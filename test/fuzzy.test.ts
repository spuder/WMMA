import { describe, expect, test } from "bun:test";
import { fuzzyMatch } from "../ui/fuzzy";

const rank = (q: string, items: string[]) =>
  items
    .map((t) => ({ t, r: fuzzyMatch(q, t) }))
    .filter((x) => x.r)
    .sort((a, b) => b.r!.score - a.r!.score)
    .map((x) => x.t);

const CATS = ["Food / Groceries", "Food / Dining", "Gifts", "Subscriptions", "Shopping", "Housing / Rent", "Rent / Property", "Taxes / Personal", "Transportation", "Travel", "Gross Receipts"];

describe("fuzzyMatch", () => {
  test("subsequences match, word starts rank first", () => {
    expect(rank("groc", CATS)[0]).toBe("Food / Groceries");
    expect(rank("grc", CATS).slice(0, 2).sort()).toEqual(["Food / Groceries", "Gross Receipts"]);
    expect(rank("sub", CATS)[0]).toBe("Subscriptions");
    expect(rank("tr", CATS).slice(0, 2).sort()).toEqual(["Transportation", "Travel"]);
  });
  test("every token must match, in any order", () => {
    expect(rank("food din", CATS)).toEqual(["Food / Dining"]);
    expect(rank("din food", CATS)).toEqual(["Food / Dining"]);
    expect(rank("rent prop", CATS)[0]).toBe("Rent / Property");
  });
  test("tolerates one typo in longer words", () => {
    expect(rank("grocires", CATS)[0]).toBe("Food / Groceries");
    expect(rank("xyz", CATS)).toEqual([]);
  });
  test("prefix beats a scattered match", () => {
    expect(rank("g", ["Shopping", "Gifts"])[0]).toBe("Gifts");
  });
  test("reports matched positions for highlighting", () => {
    expect(fuzzyMatch("gro", "Food / Groceries")!.indices).toEqual([7, 8, 9]);
    expect(fuzzyMatch("", "Gifts")).toEqual({ score: 0, indices: [] });
  });
});
