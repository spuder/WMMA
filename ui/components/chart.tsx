/** ECharts, tree-shaken, themed from the CSS tokens and re-themed on light/dark changes. */
import { BarChart, LineChart, PieChart, SankeyChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useRef, useState } from "preact/hooks";

echarts.use([LineChart, BarChart, PieChart, SankeyChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

export type ChartOption = echarts.EChartsCoreOption;

export interface Theme {
  ink: string;
  muted: string;
  line: string;
  surface: string;
  accent: string;
  in: string;
  out: string;
  warn: string;
  palette: string[];
  dark: boolean;
}

function readTheme(): Theme {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  const dark = cs.colorScheme.includes("dark") || matchMedia("(prefers-color-scheme: dark)").matches && document.documentElement.dataset["theme"] !== "light";
  return {
    ink: v("--ink"),
    muted: v("--muted"),
    line: v("--line"),
    surface: v("--surface"),
    accent: v("--accent"),
    in: v("--in"),
    out: v("--out"),
    warn: v("--warn"),
    dark,
    // Calm, distinguishable categorical palette (works on both themes).
    palette: dark
      ? ["#47c08f", "#6aa8f0", "#f1b34a", "#f0876a", "#b493f0", "#ef7fb0", "#4fc6c0", "#a7b06a", "#9aa0a6"]
      : ["#1f7a5a", "#3b74c4", "#c98a12", "#c4512f", "#7b5cc4", "#c2477f", "#1f8f8a", "#7d8a3a", "#7a7f86"],
  };
}

export function useTheme(): Theme | null {
  const [t, setT] = useState<Theme | null>(null);
  useEffect(() => {
    setT(readTheme());
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => setT(readTheme());
    mq.addEventListener("change", on);
    window.addEventListener("wmma-theme", on);
    return () => {
      mq.removeEventListener("change", on);
      window.removeEventListener("wmma-theme", on);
    };
  }, []);
  return t;
}

export function Chart({ option, class: cls = "chart", onClick }: { option: (t: Theme) => ChartOption; class?: string; onClick?: (p: any) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const inst = useRef<echarts.ECharts | null>(null);
  const theme = useTheme();
  useEffect(() => {
    if (!el.current) return;
    inst.current = echarts.init(el.current, undefined, { renderer: "canvas" });
    const ro = new ResizeObserver(() => inst.current?.resize());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      inst.current?.dispose();
    };
  }, []);
  useEffect(() => {
    if (!inst.current || !theme) return;
    const base: ChartOption = {
      color: theme.palette,
      textStyle: { fontFamily: getComputedStyle(document.body).fontFamily, color: theme.muted },
      animationDuration: 500,
      tooltip: {
        backgroundColor: theme.surface,
        borderColor: theme.line,
        textStyle: { color: theme.ink, fontSize: 13 },
        extraCssText: "border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.12);",
      },
    };
    inst.current.setOption({ ...base, ...option(theme), tooltip: { ...(base["tooltip"] as object), ...((option(theme)["tooltip"] as object) ?? {}) } }, true);
    if (onClick) {
      inst.current.off("click");
      inst.current.on("click", onClick);
    }
  }, [theme, option]);
  return <div ref={el} class={cls} />;
}
