import { useEffect, useState } from "preact/hooks";
import { api, catEmoji, catLabel, CATEGORY_GROUPS, categoryMeta, leaf, money, monthName, monthShift, thisMonth, useApi } from "../api";
import { EntitySwitcher, useApp } from "../app";
import { Seg } from "../components/report-kit";
import { CatName, ErrorBox, Icon, Loading, Sheet, toast } from "../components/ui";

interface Row {
  account: string;
  planned: number | null;
  actual: number;
  /** Expenses: available after rollover. Income: planned minus received. */
  remaining: number;
  rolled: number;
}

const toCents = (s: string) => {
  const n = Number(s.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
};

export function Budget() {
  const { entity, entities, categories } = useApp();
  const [month, setMonth] = useState(thisMonth());
  const ent = entity ?? entities.find((e) => e.type === "personal")?.slug ?? entities[0]?.slug ?? null;
  const { data, error, reload } = useApi(ent ? `/reports/budget?entity=${encodeURIComponent(ent)}&month=${month}` : null, [ent, month]);
  const [showUnbudgeted, setShowUnbudgeted] = useState(false);
  const [adding, setAdding] = useState(false);
  const [side, setSide] = useState<"summary" | "income" | "expenses">("summary");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const save = async (account: string, amount: string) => {
    const c = toCents(amount || "0");
    if (Number.isNaN(c) || c < 0) return toast("Enter an amount like 400 or 400.00");
    try {
      await api("/budgets", { method: "PUT", body: [{ entity: ent, account, month, amount: (c / 100).toFixed(2) }] });
      toast(`${leaf(account)}: ${money(c)} a month from ${monthName(month, { month: "long" })}`);
      setAdding(false);
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  if (!ent) return <div class="empty">Add a business or personal profile first</div>;
  const income: Row[] = (data?.income ?? []).map((l: any) => ({ account: l.account, planned: l.planned ? l.budgeted_cents : null, actual: l.actual_cents, remaining: l.planned ? l.budgeted_cents - l.actual_cents : 0, rolled: 0 }));
  const expenses: Row[] = (data?.lines ?? []).map((l: any) => ({ account: l.account, planned: l.budgeted_cents, actual: l.activity_cents, remaining: l.available_cents, rolled: l.rolled_over_cents }));
  const unbudgeted: Row[] = (data?.unbudgeted ?? []).map((l: any) => ({ account: l.account, planned: null, actual: l.activity_cents, remaining: -l.activity_cents, rolled: 0 }));
  const sum = (rs: Row[], k: "planned" | "actual") => rs.reduce((s, r) => s + (r[k] ?? 0), 0);
  const plannedIn = sum(income, "planned");
  const actualIn = sum(income, "actual");
  const plannedOut = sum(expenses, "planned");
  const actualOut = sum(expenses, "actual") + sum(unbudgeted, "actual");
  const left = plannedIn - plannedOut;

  const groups = CATEGORY_GROUPS.filter((g) => g !== "Income")
    .map((g) => ({ g, rows: [...expenses, ...(showUnbudgeted ? unbudgeted : [])].filter((r) => categoryMeta(r.account).group === g) }))
    .filter((x) => x.rows.length > 0);
  const current = month === thisMonth();

  return (
    <div class="stack">
      <div class="topbar">
        <div class="row" style={{ gap: 12 }}>
          <h1>Budget</h1>
          <div class="month-nav">
            <button class="icon-btn" onClick={() => setMonth(monthShift(month, -1))} aria-label="Previous month">
              <span class="flip"><Icon.chevron /></span>
            </button>
            <strong>{monthName(month, { month: "long", year: "numeric" })}</strong>
            <button class="icon-btn" onClick={() => setMonth(monthShift(month, 1))} aria-label="Next month">
              <Icon.chevron />
            </button>
            {!current && (
              <button class="btn sm" onClick={() => setMonth(thisMonth())}>
                Today
              </button>
            )}
          </div>
        </div>
        <div class="toolbar">
          <button class="btn sm" onClick={() => setAdding(true)}>
            <span class="tiny-ico"><Icon.plus /></span> Budget
          </button>
          <EntitySwitcher />
        </div>
      </div>
      {!entity && <div class="muted small">Budgets belong to one profile. Showing {entities.find((e) => e.slug === ent)?.name}; pick another above.</div>}
      {error && <ErrorBox error={error} />}
      {!data ? (
        <Loading h={420} />
      ) : (
        <div class="grid">
          <div class="span-8 stack">
            <div class="card budget-card">
              <BudgetHead first="Income" />
              {income.length === 0 && <div class="empty small">No income this month. Add a planned amount with “+ Budget”.</div>}
              {income.length > 0 && (
                <GroupRow name="Income" rows={income} kind="income" open={!collapsed["Income"]} onToggle={() => setCollapsed({ ...collapsed, Income: !collapsed["Income"] })} />
              )}
              {!collapsed["Income"] && income.map((r) => <BudgetRow key={`${month}:${r.account}`} r={r} kind="income" onSave={save} />)}
              <BudgetTotal label="Total income" planned={plannedIn} actual={actualIn} remaining={income.reduce((s, r) => s + r.remaining, 0)} kind="income" />
            </div>
            <div class="card budget-card">
              <BudgetHead first="Expenses" />
              {groups.length === 0 && <div class="empty small">No budgets yet. Use “+ Budget” to plan a category.</div>}
              {groups.map(({ g, rows }) => (
                <>
                  <GroupRow name={g} rows={rows} kind="expense" open={!collapsed[g]} onToggle={() => setCollapsed({ ...collapsed, [g]: !collapsed[g] })} />
                  {!collapsed[g] && rows.map((r) => <BudgetRow key={`${month}:${r.account}`} r={r} kind="expense" onSave={save} />)}
                </>
              ))}
              {unbudgeted.length > 0 && (
                <button class="linkbtn unbudgeted-toggle" onClick={() => setShowUnbudgeted(!showUnbudgeted)}>
                  <span class="tiny-ico">{showUnbudgeted ? "🙈" : "👁️"}</span>
                  {showUnbudgeted ? "Hide" : "Show"} {unbudgeted.length} unbudgeted ({money(sum(unbudgeted, "actual"))} spent)
                </button>
              )}
              <BudgetTotal label="Total expenses" planned={plannedOut} actual={actualOut} remaining={expenses.reduce((s, r) => s + r.remaining, 0) - sum(unbudgeted, "actual")} kind="expense" />
            </div>
          </div>
          <div class="span-4 stack">
            <div class={`card left-to-budget ${left < 0 ? "over" : ""}`}>
              <div class="ltb-value num">{money(left, true)}</div>
              <div class="ltb-label">{left < 0 ? "Over budget" : "Left to budget"}</div>
              <div class="muted tiny">{plannedIn === 0 ? "Type a planned amount next to your income to see what's left" : "Planned income minus planned expenses"}</div>
            </div>
            <div class="card">
              <Seg value={side} onChange={setSide} label="Summary" options={[["summary", "Summary"], ["income", "Income"], ["expenses", "Expenses"]]} />
              <div class="stack" style={{ marginTop: 14, gap: 16 }}>
                {(side === "summary" || side === "income") && <Meter label="Income" planned={plannedIn} actual={actualIn} income />}
                {(side === "summary" || side === "expenses") && <Meter label="Expenses" planned={plannedOut} actual={actualOut} />}
                {side === "income" && income.map((r) => <Meter label={<CatName account={r.account} />} planned={r.planned ?? 0} actual={r.actual} income small />)}
                {side === "expenses" && [...expenses, ...unbudgeted].sort((a, b) => b.actual - a.actual).map((r) => <Meter label={<CatName account={r.account} />} planned={(r.planned ?? 0) + Math.max(0, r.rolled)} actual={r.actual} small />)}
              </div>
            </div>
          </div>
        </div>
      )}
      <Sheet open={adding} onClose={() => setAdding(false)} title="Plan a category">
        <NewBudget categories={categories} month={month} onSave={save} />
      </Sheet>
    </div>
  );
}

function BudgetHead({ first }: { first: string }) {
  return (
    <div class="budget-row budget-head">
      <span>{first}</span>
      <span class="hide-sm">Progress</span>
      <span class="r">Planned</span>
      <span class="r">Actual</span>
      <span class="r">Remaining</span>
    </div>
  );
}

/** A category group (Monarch's "Fixed", "Income"…) with its own totals; its categories sit indented beneath it. */
function GroupRow({ name, rows, kind, open, onToggle }: { name: string; rows: Row[]; kind: "income" | "expense"; open: boolean; onToggle: () => void }) {
  const planned = rows.reduce((s, r) => s + (r.planned ?? 0) + (kind === "expense" ? Math.max(0, r.rolled) : 0), 0);
  const actual = rows.reduce((s, r) => s + r.actual, 0);
  const remaining = kind === "income" ? rows.reduce((s, r) => s + r.remaining, 0) : rows.reduce((s, r) => s + r.remaining, 0);
  const over = kind === "expense" && remaining < 0;
  return (
    <div class="budget-row budget-group" role="button" tabIndex={0} aria-expanded={open} onClick={onToggle} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onToggle())}>
      <span class="budget-group-name">
        <span class={`st-caret${open ? " open" : ""}`}>
          <Icon.chevron />
        </span>
        {name}
      </span>
      <span class="hide-sm">
        <div class={`bar budget-bar ${over ? "over" : ""}`}>
          <div style={{ width: `${planned > 0 ? Math.min(100, (actual / planned) * 100) : actual > 0 ? 100 : 0}%` }} />
        </div>
      </span>
      <span class="r num">{money(rows.reduce((s, r) => s + (r.planned ?? 0), 0), true)}</span>
      <span class="r num">{money(actual, true)}</span>
      <span class={`r num ${over ? "neg" : kind === "expense" ? "in" : ""}`}>{money(remaining, true)}</span>
    </div>
  );
}

function BudgetRow({ r, kind, onSave }: { r: Row; kind: "income" | "expense"; onSave: (account: string, amount: string) => void }) {
  const text = (c: number | null) => (c === null ? "" : (c / 100).toFixed(c % 100 === 0 ? 0 : 2));
  const [v, setV] = useState(text(r.planned));
  useEffect(() => setV(text(r.planned)), [r.planned]);
  const commit = () => {
    const c = toCents(v || "0");
    if (v === "" && r.planned === null) return;
    if (c !== (r.planned ?? 0)) onSave(r.account, v || "0");
  };
  const budget = (r.planned ?? 0) + (kind === "expense" ? Math.max(0, r.rolled) : 0);
  const ratio = budget > 0 ? r.actual / budget : r.actual > 0 ? 1.01 : 0;
  const state = kind === "income" ? (r.remaining <= 0 ? "ok" : "zero") : r.remaining < 0 ? "over" : ratio > 0.85 ? "warn" : "ok";
  return (
    <div class={`budget-row budget-item${r.planned === null ? " unplanned" : ""}`}>
      <span class="budget-cat">
        <CatName account={r.account} />
      </span>
      <span class="hide-sm">
        <div class={`bar budget-bar ${state === "over" ? "over" : state === "warn" ? "warn" : ""}`}>
          <div style={{ width: `${Math.min(100, ratio * 100)}%` }} />
        </div>
      </span>
      <span class="r">
        <input
          class="plan-input num"
          inputMode="decimal"
          aria-label={`Planned for ${catLabel(r.account)}`}
          placeholder="—"
          value={v}
          onInput={(e) => setV((e.target as HTMLInputElement).value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setV(text(r.planned));
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      </span>
      <span class="r num">{money(r.actual, true)}</span>
      <span class="r" title={r.rolled ? `${r.rolled > 0 ? "+" : ""}${money(r.rolled)} rolled over from last month` : undefined}>
        {r.planned === null ? (
          <span class="muted">—</span>
        ) : (
          <span class={`pill ${state}`}>
            {money(r.remaining, true)}
            {r.rolled !== 0 && <span class="roll" aria-hidden>↻</span>}
          </span>
        )}
      </span>
    </div>
  );
}

function BudgetTotal({ label, planned, actual, remaining, kind }: { label: string; planned: number; actual: number; remaining: number; kind: "income" | "expense" }) {
  return (
    <div class="budget-row budget-total">
      <span>{label}</span>
      <span class="hide-sm">
        <div class={`bar budget-bar ${kind === "expense" && actual > planned ? "over" : ""}`}>
          <div style={{ width: `${planned > 0 ? Math.min(100, (actual / planned) * 100) : 0}%` }} />
        </div>
      </span>
      <span class="r num">{money(planned, true)}</span>
      <span class="r num">{money(actual, true)}</span>
      <span class={`r num ${kind === "expense" && remaining < 0 ? "neg" : ""}`}>{money(remaining, true)}</span>
    </div>
  );
}

function Meter({ label, planned, actual, income, small }: { label: preact.ComponentChildren; planned: number; actual: number; income?: boolean; small?: boolean }) {
  const over = !income && actual > planned;
  return (
    <div class={`meter${small ? " small" : ""}`}>
      <div class="spread">
        <span class="meter-label">{label}</span>
        <span class="muted small num">{money(planned, true)} planned</span>
      </div>
      <div class={`bar ${over ? "over" : ""}`}>
        <div style={{ width: `${planned > 0 ? Math.min(100, (actual / planned) * 100) : actual > 0 ? 100 : 0}%` }} />
      </div>
      <div class="spread small">
        <span class={`num ${income ? "in" : ""}`}>
          {money(actual, true)} {income ? "earned" : "spent"}
        </span>
        <span class={`num ${over ? "neg" : "in"}`}>
          {money(Math.abs(planned - actual), true)} {income ? (actual >= planned ? "over plan" : "to go") : over ? "over" : "remaining"}
        </span>
      </div>
    </div>
  );
}

function NewBudget({ categories, month, onSave }: { categories: string[]; month: string; onSave: (account: string, amount: string) => void }) {
  const [account, setAccount] = useState("");
  const [amount, setAmount] = useState("");
  return (
    <form
      class="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (account && amount) onSave(account, amount);
      }}
    >
      <div class="field">
        <label>Category</label>
        <select class="input" value={account} onChange={(e) => setAccount((e.target as HTMLSelectElement).value)}>
          <option value="">Choose…</option>
          <optgroup label="Income">
            {categories.filter((c) => c.startsWith("Income:")).map((c) => (
              <option value={c}>{catEmoji(c)} {catLabel(c)}</option>
            ))}
          </optgroup>
          <optgroup label="Expenses">
            {categories.filter((c) => c.startsWith("Expenses:")).map((c) => (
              <option value={c}>{catEmoji(c)} {catLabel(c)}</option>
            ))}
          </optgroup>
        </select>
      </div>
      <div class="field">
        <label>Monthly amount from {monthName(month, { month: "long", year: "numeric" })} on</label>
        <input class="input num" inputMode="decimal" placeholder="400.00" value={amount} onInput={(e) => setAmount((e.target as HTMLInputElement).value)} />
      </div>
      <button class="btn primary block" type="submit" disabled={!account || !amount}>
        Save budget
      </button>
    </form>
  );
}
