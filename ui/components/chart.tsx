/** ECharts, tree-shaken, themed from the CSS tokens and re-themed on light/dark changes. */
import { BarChart, LineChart, PieChart, SankeyChart, TreemapChart } from "echarts/charts";
import { GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent, TooltipComponent, VisualMapPiecewiseComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useRef, useState } from "preact/hooks";

echarts.use([LineChart, BarChart, PieChart, SankeyChart, TreemapChart, GridComponent, TooltipComponent, LegendComponent, MarkLineComponent, MarkAreaComponent, VisualMapPiecewiseComponent, CanvasRenderer]);

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
    // Bright, distinguishable categorical palette (matches --c0…--c7 in styles.css).
    palette: dark
      ? ["#6aa3ff", "#ff8a5c", "#3fcc97", "#b993f7", "#f5c35a", "#f283b2", "#4cc4d8", "#a5bc5f", "#9a9894"]
      : ["#4f8ef7", "#ff7a45", "#2fb886", "#a77bf3", "#f2b33d", "#ec6aa0", "#33b3c9", "#8ea64a", "#a39e98"],
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

export function Chart({ option, class: cls = "chart", onClick }: { option: (t: Theme) => ChartOption; class?: string; onClick?: ((p: any) => void) | undefined }) {
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
        padding: [8, 12],
        extraCssText: "border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.12);",
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
