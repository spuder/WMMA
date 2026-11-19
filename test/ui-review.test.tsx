/**
 * M7 done-when: the review queue can be cleared entirely on a phone.
 * Renders the real swipe screen in a headless DOM at phone width, drives it
 * with pointer (finger) drags and taps, and checks every item is resolved.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

GlobalRegistrator.register({ width: 390, height: 844, url: "http://wmma.test/" });

const { render } = await import("preact");
const { App } = await import("../ui/app");
const { Review } = await import("../ui/pages/Review");
const { Toaster } = await import("../ui/components/ui");

type Item = { wmma_id: string; jev_choices: Array<{ account: string; probability: number }>; date: string; payee: string; amount_cents: number; account: string; entity: string | null; reason: string | null };

const queue: Item[] = [
  { wmma_id: "W1", jev_choices: [{ account: "Expenses:Food:Groceries", probability: 0.71 }, { account: "Expenses:Food:Dining", probability: 0.2 }], date: "2026-03-02", payee: "GROCER #12", amount_cents: -5000, account: "Assets:Checking:Main", entity: "personal", reason: "low confidence" },
  { wmma_id: "W2", jev_choices: [{ account: "Expenses:Food:Groceries", probability: 0.66 }], date: "2026-03-09", payee: "GROCER #12", amount_cents: -6000, account: "Assets:Checking:Main", entity: "personal", reason: "low confidence" },
  { wmma_id: "W3", jev_choices: [], date: "2026-03-10", payee: "MYSTERY CO", amount_cents: -1000, account: "Assets:Checking:Main", entity: "personal", reason: "jev not configured" },
  { wmma_id: "W4", jev_choices: [{ account: "Expenses:Food:Groceries", probability: 0.6 }], date: "2026-03-16", payee: "GROCER #14", amount_cents: -7000, account: "Assets:Checking:Main", entity: "personal", reason: "low confidence" },
  { wmma_id: "W5", jev_choices: [{ account: "Expenses:Food:Groceries", probability: 0.55 }], date: "2026-03-20", payee: "GROCER #15", amount_cents: -8000, account: "Assets:Checking:Main", entity: "personal", reason: "low confidence" },
];

const posts: Array<{ id: string; account: string }> = [];
let refreshes = 0;

const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (/\/api\/v1\/review(\?|$)/.test(url) && (!init?.method || init.method === "GET")) {
      expect(url).toContain("order=newest");
      return Response.json({ items: queue });
    }
    const m = /\/api\/v1\/review\/(\w+)$/.exec(url);
    if (m && init?.method === "POST") {
      const { account } = JSON.parse(String(init.body));
      posts.push({ id: m[1]!, account });
      // The 3rd grocery accept teaches a rule that also sorts W5.
      const groceries = posts.filter((p) => p.account === "Expenses:Food:Groceries").length;
      const learned = groceries === 3;
      return Response.json({
        item: { wmma_id: m[1], status: "accepted", chosen: account },
        ruleCreated: learned ? { match: { payeeKey: "grocer" }, target_account: account } : null,
        autoResolved: learned ? ["W5"] : [],
      });
    }
    return Response.json({ error: "unexpected " + url }, { status: 500 });
  }) as typeof fetch;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  await GlobalRegistrator.unregister();
});

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting for UI");
    await new Promise((r) => setTimeout(r, 20));
  }
};
const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const topCard = () => document.querySelector(".deck .swipe-card:not(.behind):not(.behind2)") as HTMLElement | null;
const text = () => document.body.textContent ?? "";
/** Text of the card on top of the deck (cards behind it also render their content). */
const top = () => topCard()?.textContent ?? "";

function swipe(el: HTMLElement, dx: number) {
  const opts = (x: number) => ({ bubbles: true, pointerId: 1, clientX: x, clientY: 300, pointerType: "touch" });
  el.dispatchEvent(new PointerEvent("pointerdown", opts(200)));
  for (let i = 1; i <= 6; i++) el.dispatchEvent(new PointerEvent("pointermove", opts(200 + (dx * i) / 6)));
  el.dispatchEvent(new PointerEvent("pointerup", opts(200 + dx)));
}

describe("swipe review on a phone", () => {
  test("the queue can be cleared entirely with swipes and taps", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(
      <App.Provider
        value={{
          entity: null,
          setEntity: () => {},
          entities: [{ slug: "personal", name: "Household", type: "personal", status: "active" }],
          reviewCount: queue.length,
          refreshReview: () => void refreshes++,
          categories: ["Expenses:Food:Dining", "Expenses:Food:Groceries", "Expenses:Shopping", "Income:Salary"],
          reloadEntities: () => {},
          userName: null,
        }}
      >
        <Review />
        <Toaster />
      </App.Provider>,
      root,
    );

    localStorage.removeItem("wmma.review.later");
    await until(() => topCard() !== null);
    // Newest first; everything here is from March, so the current milestone is "This year".
    expect(top()).toContain("GROCER #15");
    expect(text()).toContain("Jev suggests");
    expect($(".quest-title")!.textContent).toBe("5 to clear · This year");
    expect($(".quest-bar-label")!.textContent).toBe("0/5");

    // 1. Swipe left: decide later. Nothing is sent; the card goes to the back of the deck.
    swipe(topCard()!, -180);
    await until(() => top().includes("GROCER #14"));
    expect(posts.length).toBe(0);
    expect($(".sheet")).toBeNull();
    expect($("[title=\"Saved for later\"]")!.textContent).toBe("⏳1");
    expect(JSON.parse(localStorage.getItem("wmma.review.later")!)).toEqual(["W5"]);

    // 2. Swipe right: accept Jev's pick.
    swipe(topCard()!, 180);
    await until(() => posts.length === 1 && $(".quest-bar-label")!.textContent === "1/5");
    expect($(".quest-left")!.textContent).toBe("4");
    expect(posts[0]).toEqual({ id: "W4", account: "Expenses:Food:Groceries" });

    // 3. A short drag springs back without doing anything.
    swipe(topCard()!, 40);
    await new Promise((r) => setTimeout(r, 300));
    expect(posts.length).toBe(1);
    expect(top()).toContain("MYSTERY CO");

    // 4. No suggestion: accept is disabled; "Other" opens the picker, tap a category.
    expect(top()).toContain("No suggestion");
    expect(($(".round.yes") as HTMLButtonElement).disabled).toBe(true);
    ($(".round.pick") as HTMLButtonElement).click();
    await until(() => $(".sheet") !== null);
    const shopping = [...document.querySelectorAll(".sheet .catbtn")].find((b) => b.textContent?.includes("Shopping")) as HTMLButtonElement;
    expect([...document.querySelectorAll(".sheet .catbtn")].some((b) => b.textContent?.includes("Salary"))).toBe(false); // money out: expenses only
    shopping.click();
    await until(() => posts.length === 2);
    expect(posts[1]).toEqual({ id: "W3", account: "Expenses:Shopping" });

    // 5. Tap the accept button.
    await until(() => top().includes("$60.00"));
    ($(".round.yes") as HTMLButtonElement).click();
    await until(() => posts.length === 3);
    expect(posts[2]).toEqual({ id: "W2", account: "Expenses:Food:Groceries" });

    // 6. Third grocery accept teaches a rule that also sorts the card set aside for later.
    await until(() => top().includes("$50.00"));
    swipe(topCard()!, 200);
    await until(() => text().includes("All caught up"));
    expect(posts.map((p) => p.id)).toEqual(["W4", "W3", "W2", "W1"]);
    expect(text()).toContain("5 sorted");
    expect(text()).toContain("1 new rule learned");
    expect(text()).toContain("Learned: “grocer” → Groceries · 1 more sorted");
    await until(() => text().includes("Inbox zero!")); // milestone celebration
    expect(JSON.parse(localStorage.getItem("wmma.review.later")!)).toEqual([]);
    expect(refreshes).toBeGreaterThanOrEqual(4);
  });
});
