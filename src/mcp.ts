/**
 * MCP server (SPEC §8) over Streamable HTTP at /mcp, on the same service
 * layer and Tailscale auth as REST. Stateless: one server per request, bound
 * to the authenticated user. Every tool call is recorded in audit.log
 * (writes additionally log before/after from their service).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { listAccountsWithBalances } from "./services/accounts";
import { syncSimplefin } from "./services/bank-imports";
import { createRule, listReview, resolveReview } from "./services/categorize";
import { ServiceError, type ServiceContext } from "./services/context";
import { listEntities } from "./services/entities";
import { recordTransfer, recordValuation, setBudgets } from "./services/ledger";
import { budgetReport, cashflow, netWorth, pnl, spending } from "./services/reports";
import { patchTransaction, searchTransactions, splitTransaction, updateMapping } from "./services/transactions";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const month = z.string().regex(/^\d{4}-\d{2}$/, "YYYY-MM");
const amount = z.string().describe('Decimal dollars, e.g. "12.34"');
const entity = z.string().describe("Entity slug (see list_entities)");

type Json = Record<string, unknown> | unknown[];

export function buildMcpServer(ctx: ServiceContext, actor: string): McpServer {
  const server = new McpServer({ name: "wmma", version: "0.1.0" }, { instructions: "WMMA personal and multi-business finance. Amounts are USD. Use list_entities first to find entity slugs." });

  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    write: boolean,
    fn: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<Json>,
  ) => {
    server.registerTool(
      name,
      { description, inputSchema: shape, annotations: { readOnlyHint: !write, destructiveHint: false, openWorldHint: false } },
      (async (args: any) => {
        try {
          const result = await fn(args);
          await ctx.audit.append({ actor, operation: `mcp.${name}`, inputs: args, before: null, after: write ? result : { ok: true } });
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 1) }] };
        } catch (e) {
          const msg = e instanceof ServiceError ? e.message : `internal error: ${e instanceof Error ? e.message : String(e)}`;
          await ctx.audit.append({ actor, operation: `mcp.${name}`, inputs: args, before: null, after: { error: msg } });
          return { isError: true, content: [{ type: "text" as const, text: msg }] };
        }
      }) as never,
    );
  };

  // ---- read
  tool("list_entities", "List entities (personal, businesses, rentals).", { status: z.enum(["active", "archived", "all"]).optional() }, false, async (a) => listEntities(ctx, a.status ?? "active"));
  tool("list_accounts", "List bank, card, loan and asset accounts with balances.", {}, false, async () => listAccountsWithBalances(ctx));
  tool(
    "search_transactions",
    "Search transactions (newest first) by date range, account, entity, category or text.",
    {
      from: date.optional(),
      to: date.optional(),
      account: z.string().optional().describe("hledger account or prefix, e.g. Assets:Checking"),
      entity: entity.optional(),
      category: z.string().optional().describe("Income/Expenses account or prefix"),
      text: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional(),
      offset: z.number().int().min(0).optional(),
    },
    false,
    async (a) => searchTransactions(ctx, a as never),
  );
  tool("get_pnl", "Profit and loss for one entity (or all combined) over a date range (inclusive).", { entity: entity.optional(), from: date, to: date }, false, async (a) =>
    pnl(ctx, { entity: a.entity ?? null, from: a.from, to: a.to }) as unknown as Promise<Json>,
  );
  tool("get_cashflow", "Income -> expense flows (Sankey nodes and links) for an entity or all.", { entity: entity.optional(), from: date, to: date, depth: z.number().int().min(1).max(4).optional() }, false, async (a) =>
    cashflow(ctx, { entity: a.entity ?? null, from: a.from, to: a.to, ...(a.depth ? { depth: a.depth } : {}) }) as unknown as Promise<Json>,
  );
  tool("get_budget_vs_actual", "Budget vs actual with rollover for an entity and month.", { entity, month }, false, async (a) => budgetReport(ctx, { entity: a.entity, month: a.month }) as unknown as Promise<Json>);
  tool("get_net_worth", "Net worth (assets minus liabilities) at each month end, per entity and combined.", { from: month, to: month }, false, async (a) => netWorth(ctx, { from: a.from, to: a.to }) as unknown as Promise<Json>);
  tool("get_spending_by_category", "Spending by expense category.", { entity: entity.optional(), from: date, to: date, depth: z.number().int().min(1).max(4).optional() }, false, async (a) =>
    spending(ctx, { entity: a.entity ?? null, from: a.from, to: a.to, ...(a.depth ? { depth: a.depth } : {}) }) as unknown as Promise<Json>,
  );
  tool("get_review_queue", "Transactions waiting for a category, with Jev's top suggestions.", { limit: z.number().int().min(1).max(500).optional() }, false, async (a) => listReview(ctx, "pending", a.limit ?? 100) as unknown as Promise<Json>);

  // ---- write
  tool(
    "categorize_transaction",
    "Set a transaction's category. If it's in the review queue this counts as a swipe (3 for the same payee create a rule).",
    { wmma_id: z.string(), category: z.string().describe("Income/Expenses account, e.g. Expenses:Food:Groceries"), from: z.string().optional().describe("Which category posting to change, if there are several") },
    true,
    async (a) => {
      const queued = listReview(ctx, "pending", 100000).some((r) => r.wmma_id === a.wmma_id);
      if (queued && !a.from) return (await resolveReview(ctx, actor, a.wmma_id, a.category)) as unknown as Json;
      return (await patchTransaction(ctx, actor, a.wmma_id, { category: { to: a.category, ...(a.from ? { from: a.from } : {}) } })) as unknown as Json;
    },
  );
  tool("set_entity", "Assign a transaction to an entity.", { wmma_id: z.string(), entity }, true, async (a) => (await patchTransaction(ctx, actor, a.wmma_id, { entity: a.entity })) as unknown as Json);
  tool(
    "split_transaction",
    "Split a transaction's category posting into several categories; amounts must add up to the original.",
    { wmma_id: z.string(), from: z.string().optional(), postings: z.array(z.object({ account: z.string(), amount })).min(2) },
    true,
    async (a) => (await splitTransaction(ctx, actor, a.wmma_id, { ...(a.from ? { from: a.from } : {}), postings: a.postings })) as unknown as Json,
  );
  tool(
    "create_rule",
    "Create a categorization rule.",
    {
      match: z
        .object({ payeeKey: z.string().optional(), payeeContains: z.string().optional(), amountMin: z.number().int().optional(), amountMax: z.number().int().optional(), account: z.string().optional() })
        .describe("Amounts are signed cents"),
      target: z.string(),
      entity_override: entity.optional(),
    },
    true,
    async (a) => (await createRule(ctx, actor, { match: a.match, target: a.target, entityOverride: a.entity_override ?? null })) as unknown as Json,
  );
  tool(
    "update_mapping",
    "Map a source category (e.g. a YNAB category) to an account; apply=true also moves existing transactions.",
    { source: z.enum(["ynab", "reihub"]), source_category: z.string(), target: z.string(), apply: z.boolean().optional() },
    true,
    async (a) => (await updateMapping(ctx, actor, { source: a.source, sourceCategory: a.source_category, target: a.target, apply: a.apply ?? false })) as unknown as Json,
  );
  tool("set_budget", "Set a monthly budget amount for an Expenses category, from a month onward.", { entity, account: z.string(), month, amount }, true, async (a) => ({
    updated: await setBudgets(ctx, actor, [{ entity: a.entity, account: a.account, month: a.month, amount: a.amount }]),
  }));
  tool("record_valuation", "Record an asset's value as of a date (difference goes to Equity:Unrealized).", { account: z.string().describe("Account slug"), date, value: amount }, true, async (a) =>
    (await recordValuation(ctx, actor, { account: a.account, date: a.date, value: a.value })) as unknown as Json,
  );
  tool(
    "record_transfer",
    "Record a transfer between two accounts (between entities it goes through due-to/due-from).",
    { from: z.string().describe("Account slug"), to: z.string().describe("Account slug"), amount, date, memo: z.string().optional() },
    true,
    async (a) => (await recordTransfer(ctx, actor, { from: a.from, to: a.to, amount: a.amount, date: a.date, ...(a.memo ? { memo: a.memo } : {}) })) as unknown as Json,
  );
  tool("run_simplefin_sync", "Pull new transactions from SimpleFIN now.", {}, true, async () => (await syncSimplefin(ctx, actor)) as unknown as Json);

  return server;
}

/** Handle an authenticated /mcp request. */
export async function handleMcp(ctx: ServiceContext, actor: string, req: Request): Promise<Response> {
  const server = buildMcpServer(ctx, actor);
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true }) // no sessionIdGenerator: stateless;
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // Stateless: the response body is fully built with enableJsonResponse.
    void server.close();
  }
}
