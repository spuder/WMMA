import { describe, expect, test } from "bun:test";
import * as M from "../src/money";

describe("parse", () => {
  const ok: Array<[string, number]> = [
    ["0", 0],
    ["12", 1200],
    ["12.3", 1230],
    ["12.34", 1234],
    ["12.340", 1234],
    [".5", 50],
    ["1,234.56", 123456],
    ["1,234,567.89", 123456789],
    ["$4.50", 450],
    ["-4.50", -450],
    ["-$4.50", -450],
    ["$-4.50", -450],
    ["(4.50)", -450],
    ["($1,000.00)", -100000],
    ["+3", 300],
    ["  7.01 ", 701],
    ["-0.00", 0],
  ];
  for (const [input, expected] of ok) {
    test(JSON.stringify(input), () => expect(M.toCents(M.parse(input))).toBe(expected));
  }

  const bad = ["", "abc", "1.2.3", "1,23.00", "12.345", "0.001", "--1", "-(1)", "$", "1e5", "NaN"];
  for (const input of bad) {
    test(`rejects ${JSON.stringify(input)}`, () => expect(() => M.parse(input)).toThrow(M.MoneyError));
  }

  test("rejects values beyond safe integer cents", () => {
    expect(() => M.parse("999999999999999999.00")).toThrow(M.MoneyError);
  });

  test("avoids float artefacts (0.1 + 0.2)", () => {
    expect(M.toCents(M.add(M.parse("0.1"), M.parse("0.2")))).toBe(30);
  });
});

describe("fromHledgerQuantity", () => {
  test("2 places", () => expect(M.fromHledgerQuantity({ decimalMantissa: -450, decimalPlaces: 2 })).toBe(M.cents(-450)));
  test("0 places", () => expect(M.fromHledgerQuantity({ decimalMantissa: 7, decimalPlaces: 0 })).toBe(M.cents(700)));
  test("1 place", () => expect(M.fromHledgerQuantity({ decimalMantissa: 45, decimalPlaces: 1 })).toBe(M.cents(450)));
  test("4 places, exact", () => expect(M.fromHledgerQuantity({ decimalMantissa: 45000, decimalPlaces: 4 })).toBe(M.cents(450)));
  test("4 places, sub-cent rejected", () =>
    expect(() => M.fromHledgerQuantity({ decimalMantissa: 45001, decimalPlaces: 4 })).toThrow(M.MoneyError));
});

describe("arithmetic", () => {
  const a = M.cents(1050);
  const b = M.cents(-275);
  test("add/sub/neg/abs", () => {
    expect(M.add(a, b)).toBe(M.cents(775));
    expect(M.sub(a, b)).toBe(M.cents(1325));
    expect(M.neg(b)).toBe(M.cents(275));
    expect(M.abs(b)).toBe(M.cents(275));
  });
  test("neg zero normalises", () => expect(Object.is(M.neg(M.ZERO), 0)).toBe(true));
  test("sum", () => expect(M.sum([a, b, M.cents(25)])).toBe(M.cents(800)));
  test("sum of nothing is zero", () => expect(M.sum([])).toBe(M.ZERO));
  test("times requires integer", () => {
    expect(M.times(a, 3)).toBe(M.cents(3150));
    expect(() => M.times(a, 1.5)).toThrow(M.MoneyError);
  });
  test("compare/equals/predicates", () => {
    expect(M.compare(a, b)).toBe(1);
    expect(M.compare(b, a)).toBe(-1);
    expect(M.compare(a, a)).toBe(0);
    expect(M.equals(a, M.cents(1050))).toBe(true);
    expect(M.isNegative(b)).toBe(true);
    expect(M.isZero(M.ZERO)).toBe(true);
  });
  test("cents rejects non-integers", () => {
    expect(() => M.cents(1.5)).toThrow(M.MoneyError);
    expect(() => M.cents(Number.NaN)).toThrow(M.MoneyError);
    expect(() => M.cents(2 ** 60)).toThrow(M.MoneyError);
  });
});

describe("allocate", () => {
  test("even split with remainder", () => {
    expect(M.allocate(M.cents(100), [1, 1, 1]).map(M.toCents)).toEqual([34, 33, 33]);
  });
  test("negative total", () => {
    expect(M.allocate(M.cents(-100), [1, 1, 1]).map(M.toCents)).toEqual([-34, -33, -33]);
  });
  test("weighted", () => {
    expect(M.allocate(M.cents(1000), [70, 30]).map(M.toCents)).toEqual([700, 300]);
  });
  test("zero weight gets nothing", () => {
    expect(M.allocate(M.cents(5), [0, 1, 1]).map(M.toCents)).toEqual([0, 3, 2]);
  });
  test("always sums to total", () => {
    for (let t = -503; t <= 503; t += 37) {
      const parts = M.allocate(M.cents(t), [3, 7, 11, 13]);
      expect(M.sum(parts)).toBe(M.cents(t));
    }
  });
  test("rejects bad weights", () => {
    expect(() => M.allocate(M.cents(1), [])).toThrow(M.MoneyError);
    expect(() => M.allocate(M.cents(1), [0, 0])).toThrow(M.MoneyError);
    expect(() => M.allocate(M.cents(1), [-1, 2])).toThrow(M.MoneyError);
  });
});

describe("formatting", () => {
  test("format", () => {
    expect(M.format(M.cents(123456))).toBe("$1,234.56");
    expect(M.format(M.cents(-450))).toBe("-$4.50");
    expect(M.format(M.cents(5))).toBe("$0.05");
    expect(M.format(M.ZERO)).toBe("$0.00");
  });
  test("toJournal", () => {
    expect(M.toJournal(M.cents(123456))).toBe("$1234.56");
    expect(M.toJournal(M.cents(-450))).toBe("$-4.50");
  });
  test("round-trips through parse", () => {
    for (const c of [0, 1, -1, 99, 100, -12345, 100000000]) {
      expect(M.parse(M.format(M.cents(c)))).toBe(M.cents(c));
      expect(M.parse(M.toJournal(M.cents(c)))).toBe(M.cents(c));
    }
  });
});
