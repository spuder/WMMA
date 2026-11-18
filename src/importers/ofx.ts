/**
 * QFX/OFX parser for bank and credit card statements. Handles OFX 1.x (SGML,
 * unclosed leaf tags) and 2.x (XML). Uses FITID as the record id.
 */
import * as M from "../money";
import type { BankAccountData, BankRecord } from "./bank";

export class OfxError extends Error {
  override name = "OfxError";
}

interface Node {
  name: string;
  value?: string;
  children: Node[];
}

const decode = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");

export function parseOfxTree(text: string): Node {
  const start = text.search(/<OFX>/i);
  if (start < 0) throw new OfxError("not an OFX/QFX file: no <OFX> element");
  const body = text.slice(start).replace(/<!--[\s\S]*?-->/g, "");
  const root: Node = { name: "#root", children: [] };
  const stack: Node[] = [root];
  const re = /<(\/?)([A-Za-z0-9._]+)[^>]*>([^<]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const [, close, rawName, rawText] = m;
    const name = rawName!.toUpperCase();
    const text = rawText!.trim();
    const top = stack[stack.length - 1]!;
    if (close) {
      // Pop to the matching aggregate; a close tag for a leaf (XML style) is a no-op.
      const i = stack.map((n) => n.name).lastIndexOf(name);
      if (i > 0) stack.length = i;
      continue;
    }
    if (text !== "") {
      top.children.push({ name, value: decode(text), children: [] });
    } else {
      const node: Node = { name, children: [] };
      top.children.push(node);
      stack.push(node);
    }
  }
  return root;
}

function find(n: Node, name: string): Node | undefined {
  for (const c of n.children) {
    if (c.name === name) return c;
    const d = find(c, name);
    if (d) return d;
  }
  return undefined;
}

function findAll(n: Node, name: string, out: Node[] = []): Node[] {
  for (const c of n.children) {
    if (c.name === name) out.push(c);
    else findAll(c, name, out);
  }
  return out;
}

const leaf = (n: Node | undefined, name: string): string | undefined => n?.children.find((c) => c.name === name)?.value;

/** OFX datetime "YYYYMMDD[HHMMSS[.XXX]][[+-]hh:TZ]" -> "YYYY-MM-DD" (statement-local date). */
export function ofxDate(s: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(s.trim());
  if (!m) throw new OfxError(`invalid OFX date ${JSON.stringify(s)}`);
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** OFX amounts may use a decimal comma in some locales. */
export function ofxAmount(s: string) {
  let t = s.trim();
  if (t.includes(",") && !t.includes(".")) t = t.replace(",", ".");
  return M.parse(t);
}

export function parseOfx(text: string): BankAccountData[] {
  const root = parseOfxTree(text);
  if (find(root, "INVSTMTRS")) throw new OfxError("investment statements (INVSTMTRS) are not supported yet");
  const org = leaf(find(root, "FI"), "ORG");
  const statements = [...findAll(root, "STMTRS"), ...findAll(root, "CCSTMTRS")];
  if (statements.length === 0) throw new OfxError("no bank or credit card statement found");

  return statements.map((st) => {
    const isCard = st.name === "CCSTMTRS";
    const cur = leaf(st, "CURDEF");
    if (cur && cur.toUpperCase() !== "USD") throw new OfxError(`only USD is supported (statement is ${cur})`);
    const acct = find(st, isCard ? "CCACCTFROM" : "BANKACCTFROM");
    const acctId = leaf(acct, "ACCTID");
    if (!acctId) throw new OfxError("statement has no ACCTID");
    const bankId = leaf(acct, "BANKID") ?? org ?? "";
    const last4 = acctId.slice(-4);
    const type = leaf(acct, "ACCTTYPE");

    const records: BankRecord[] = findAll(st, "STMTTRN").map((t) => {
      const fitid = leaf(t, "FITID");
      const posted = leaf(t, "DTPOSTED");
      const amt = leaf(t, "TRNAMT");
      if (!fitid || !posted || !amt) throw new OfxError("STMTTRN missing FITID, DTPOSTED or TRNAMT");
      const name = leaf(t, "NAME") ?? leaf(find(t, "PAYEE"), "NAME") ?? "";
      const memo = leaf(t, "MEMO") ?? null;
      const check = leaf(t, "CHECKNUM");
      return {
        externalId: fitid,
        date: ofxDate(posted),
        amount: ofxAmount(amt),
        payee: name || memo || (check ? `Check ${check}` : leaf(t, "TRNTYPE") ?? "Unknown"),
        memo: name ? memo : null,
      };
    });

    const bal = find(st, "LEDGERBAL");
    const balAmt = leaf(bal, "BALAMT");
    const balDate = leaf(bal, "DTASOF");
    return {
      externalKey: `${bankId}:${acctId}`,
      name: `${org ?? (isCard ? "Card" : "Bank")} ${type ? type.toLowerCase() + " " : ""}${last4}`.trim(),
      kindHint: isCard || type === "CREDITLINE" ? "credit" : "bank",
      balance: balAmt && balDate ? { amount: ofxAmount(balAmt), asOf: ofxDate(balDate) } : null,
      records,
    };
  });
}
