// Grok Build's plan meter comes from xAI's billing answer, {config: {creditUsagePercent?, currentPeriod?: {type, start, end}}}.
// The period type is a protobuf enum value, written by its full name (USAGE_PERIOD_TYPE_WEEKLY) or bare (WEEKLY), and the bounds
// are ISO date-times. xAI leaves creditUsagePercent out until something is metered, so a weekly or monthly period with whole,
// forward bounds and no percentage is that period at 0%, resetting at its end. A percentage xAI does report is shown, held to
// 0..100, whatever the bounds. Anything else is a read that worked with nothing to show.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { grokUsageResponseToLimits } from "../src/agent-usage-limits.mjs";

const CHECKED_AT = "2027-03-10T09:15:00.000Z";
const LABEL = { weekly: "Weekly", monthly: "Monthly", other: "Subscription" };
const MARCH_START = "2027-03-08T06:00:00Z";
const MARCH_END = "2027-03-15T06:00:00Z";

// A billing answer as xAI writes it: a field not given is left out of the answer, never sent empty.
function billing({ type, from, until, percent } = {}) {
  const currentPeriod = Object.fromEntries(
    Object.entries({ type, start: from, end: until }).filter(([, value]) => value !== undefined),
  );
  return { config: percent === undefined ? { currentPeriod } : { creditUsagePercent: percent, currentPeriod } };
}

// The single row Grok's meter can show.
function row(kind, usedPercent, resetsAt) {
  const shownRow = { id: "subscription", kind, label: LABEL[kind], usedPercent };
  if (resetsAt !== undefined) shownRow.resetsAt = resetsAt;
  return shownRow;
}

function expectRows(cases) {
  for (const [name, answer, rows] of cases) {
    assert.deepEqual(grokUsageResponseToLimits(answer, CHECKED_AT).windows, rows, name);
  }
}

// Ways a bound can fail to be a whole zoned date-time, each made from a good bound so that it would still sit on the right side
// of the other bound if it were read at all.
function spoiled(iso) {
  return [
    ["without its zone", iso.slice(0, -1)],
    ["as a date alone", iso.slice(0, 10)],
    ["with a lower-case t", iso.replace("T", "t")],
    ["with a lower-case z", iso.replace(/Z$/, "z")],
    ["with a space for the T", iso.replace("T", " ")],
    ["with a space before it", ` ${iso}`],
    ["with a space after it", `${iso} `],
    ["as epoch milliseconds", Date.parse(iso)],
    ["as a timestamp object", { seconds: Date.parse(iso) / 1000 }],
    ["as null", null],
    ["as empty text", ""],
    ["as words", "around then"],
  ];
}

describe("a Grok Build period with nothing metered yet", () => {
  it("is shown at 0% when weekly or monthly with whole bounds in order, resetting at its end", () => {
    expectRows([
      ["full weekly name, UTC bounds",
        billing({ type: "USAGE_PERIOD_TYPE_WEEKLY", from: MARCH_START, until: "2027-03-15T06:00:00.500Z" }),
        [row("weekly", 0, "2027-03-15T06:00:00.500Z")]],
      ["bare monthly name, bounds seven hours behind UTC",
        billing({ type: "MONTHLY", from: "2027-04-01T00:00:00-07:00", until: "2027-05-01T00:00:00-07:00" }),
        [row("monthly", 0, "2027-05-01T07:00:00.000Z")]],
      ["bare weekly name, microsecond bounds ahead of UTC",
        billing({ type: "WEEKLY", from: "2027-06-14T12:30:45.123456+05:30", until: "2027-06-21T12:30:45.123456+05:30" }),
        [row("weekly", 0, "2027-06-21T07:00:45.123Z")]],
      ["six-digit year, a clock without seconds and the 24:00 end of the last day",
        billing({ type: "USAGE_PERIOD_TYPE_MONTHLY", from: "+002027-02-01T00:00Z", until: "2027-02-28T24:00Z" }),
        [row("monthly", 0, "2027-03-01T00:00:00.000Z")]],
      ["a week from the leap day of 2028",
        billing({ type: "WEEKLY", from: "2028-02-29T00:00:00Z", until: "2028-03-07T00:00:00Z" }),
        [row("weekly", 0, "2028-03-07T00:00:00.000Z")]],
      ["a week to the leap day of 2000, a century year divisible by 400",
        billing({ type: "WEEKLY", from: "2000-02-22T00:00:00Z", until: "2000-02-29T00:00:00Z" }),
        [row("weekly", 0, "2000-02-29T00:00:00.000Z")]],
    ]);
  });

  it("orders its bounds as instants, not as text", () => {
    expectRows([
      ["a start that reads later but is four hours earlier",
        billing({ type: "WEEKLY", from: "2027-03-15T01:00:00+09:00", until: "2027-03-14T20:00:00Z" }),
        [row("weekly", 0, "2027-03-14T20:00:00.000Z")]],
      ["a start that reads earlier but is four hours later",
        billing({ type: "WEEKLY", from: "2027-03-14T20:00:00Z", until: "2027-03-15T01:00:00+09:00" }),
        []],
    ]);
  });

  it("shows nothing for a period that does not move forward", () => {
    expectRows([
      ["equal bounds", billing({ type: "WEEKLY", from: MARCH_END, until: MARCH_END }), []],
      ["one instant written in two zones",
        billing({ type: "WEEKLY", from: "2027-03-15T11:30:00+05:30", until: MARCH_END }), []],
      ["start after end", billing({ type: "WEEKLY", from: MARCH_END, until: MARCH_START }), []],
    ]);
  });

  it("shows nothing for a daily, unspecified, unnamed or lower-case period type", () => {
    expectRows([
      ["daily", billing({ type: "USAGE_PERIOD_TYPE_DAILY", from: "2027-03-10T00:00:00Z", until: "2027-03-11T00:00:00Z" }), []],
      ["unspecified", billing({ type: "USAGE_PERIOD_TYPE_UNSPECIFIED", from: MARCH_START, until: MARCH_END }), []],
      ["no type", billing({ from: MARCH_START, until: MARCH_END }), []],
      ["lower case", billing({ type: "weekly", from: MARCH_START, until: MARCH_END }), []],
    ]);
  });

  it("shows nothing when the answer carries no period", () => {
    expectRows([
      ["no period", { config: {} }, []],
      ["no config", {}, []],
      ["null answer", null, []],
      ["no answer", undefined, []],
    ]);
  });

  it("shows nothing when either bound is missing or not a whole zoned date-time", () => {
    const cases = [
      ["start missing", billing({ type: "WEEKLY", until: MARCH_END }), []],
      ["end missing", billing({ type: "WEEKLY", from: MARCH_START }), []],
    ];
    for (const [how, start] of spoiled(MARCH_START)) cases.push([`start ${how}`, billing({ type: "WEEKLY", from: start, until: MARCH_END }), []]);
    for (const [how, end] of spoiled(MARCH_END)) cases.push([`end ${how}`, billing({ type: "WEEKLY", from: MARCH_START, until: end }), []]);
    expectRows(cases);
  });

  it("shows nothing when a bound names a day or time the calendar lacks", () => {
    expectRows([
      ["29 February 2027 as the end", billing({ type: "WEEKLY", from: "2027-02-22T00:00:00Z", until: "2027-02-29T00:00:00Z" }), []],
      ["29 February 2027 as the start", billing({ type: "WEEKLY", from: "2027-02-29T00:00:00Z", until: "2027-03-08T00:00:00Z" }), []],
      ["29 February 2100, a century year that is not a leap year",
        billing({ type: "WEEKLY", from: "2100-02-22T00:00:00Z", until: "2100-02-29T00:00:00Z" }), []],
      ["31 April", billing({ type: "MONTHLY", from: "2027-04-01T00:00:00Z", until: "2027-04-31T00:00:00Z" }), []],
      ["month 13", billing({ type: "MONTHLY", from: "2027-12-01T00:00:00Z", until: "2027-13-01T00:00:00Z" }), []],
      ["day 0", billing({ type: "WEEKLY", from: "2027-03-00T06:00:00Z", until: MARCH_END }), []],
      ["hour 25", billing({ type: "WEEKLY", from: "2027-03-08T25:00:00Z", until: MARCH_END }), []],
      ["minute 60", billing({ type: "WEEKLY", from: "2027-03-08T06:60:00Z", until: MARCH_END }), []],
    ]);
  });
});

describe("a percentage xAI reports for Grok Build", () => {
  it("is shown as reported, a zero balance included", () => {
    expectRows([
      ["64.25", billing({ type: "USAGE_PERIOD_TYPE_WEEKLY", from: MARCH_START, until: MARCH_END, percent: 64.25 }),
        [row("weekly", 64.25, "2027-03-15T06:00:00.000Z")]],
      ["zero", billing({ type: "MONTHLY", from: "2027-04-01T00:00:00Z", until: "2027-05-01T00:00:00Z", percent: 0 }),
        [row("monthly", 0, "2027-05-01T00:00:00.000Z")]],
      ["a full 100", billing({ type: "MONTHLY", until: "2027-05-01T00:00:00Z", percent: 100 }),
        [row("monthly", 100, "2027-05-01T00:00:00.000Z")]],
    ]);
  });

  it("is held to 0..100", () => {
    expectRows([
      ["250", billing({ type: "MONTHLY", until: "2027-05-01T00:00:00Z", percent: 250 }), [row("monthly", 100, "2027-05-01T00:00:00.000Z")]],
      ["-5", billing({ type: "MONTHLY", until: "2027-05-01T00:00:00Z", percent: -5 }), [row("monthly", 0, "2027-05-01T00:00:00.000Z")]],
    ]);
  });

  it("is read from text, as protobuf's JSON may write a number, and shows nothing unless it is a finite number", () => {
    expectRows([
      ["12.5 as text", billing({ type: "WEEKLY", until: MARCH_END, percent: "12.5" }), [row("weekly", 12.5, "2027-03-15T06:00:00.000Z")]],
      ["NaN", billing({ type: "WEEKLY", until: MARCH_END, percent: "NaN" }), []],
      ["Infinity", billing({ type: "WEEKLY", until: MARCH_END, percent: "Infinity" }), []],
      ["-Infinity", billing({ type: "WEEKLY", until: MARCH_END, percent: "-Infinity" }), []],
      ["words", billing({ type: "WEEKLY", until: MARCH_END, percent: "most of it" }), []],
    ]);
  });

  it("is shown whatever the period's start or order", () => {
    expectRows([
      ["a start that is not a date", billing({ type: "WEEKLY", from: "whenever", until: MARCH_END, percent: 33 }),
        [row("weekly", 33, "2027-03-15T06:00:00.000Z")]],
      ["a zero balance with no start, which nothing metered would not show", billing({ type: "WEEKLY", until: MARCH_END, percent: 0 }),
        [row("weekly", 0, "2027-03-15T06:00:00.000Z")]],
      ["start after end", billing({ type: "WEEKLY", from: "2027-03-22T06:00:00Z", until: MARCH_END, percent: 33 }),
        [row("weekly", 33, "2027-03-15T06:00:00.000Z")]],
    ]);
  });

  it("leaves the reset time out when the end is not a date or there is no period", () => {
    expectRows([
      ["an end in words", billing({ type: "WEEKLY", from: MARCH_START, until: "next week", percent: 33 }), [row("weekly", 33)]],
      ["no period", { config: { creditUsagePercent: 18 } }, [row("other", 18)]],
    ]);
  });

  it("is the subscription's for a daily, unspecified or unnamed period", () => {
    const day = { from: "2027-03-10T00:00:00Z", until: "2027-03-11T00:00:00Z", percent: 18 };
    expectRows([
      ["daily", billing({ type: "USAGE_PERIOD_TYPE_DAILY", ...day }), [row("other", 18, "2027-03-11T00:00:00.000Z")]],
      ["unspecified", billing({ type: "USAGE_PERIOD_TYPE_UNSPECIFIED", ...day }), [row("other", 18, "2027-03-11T00:00:00.000Z")]],
      ["no type", billing(day), [row("other", 18, "2027-03-11T00:00:00.000Z")]],
    ]);
  });
});

describe("the answer to a Grok Build usage read", () => {
  it("carries the time it was checked and nothing marked unavailable", () => {
    assert.deepEqual(grokUsageResponseToLimits(billing({ type: "USAGE_PERIOD_TYPE_DAILY", from: MARCH_START, until: MARCH_END }), CHECKED_AT),
      { checkedAt: CHECKED_AT, windows: [] });
    assert.deepEqual(grokUsageResponseToLimits(billing({ type: "WEEKLY", from: MARCH_START, until: MARCH_END }), CHECKED_AT),
      { checkedAt: CHECKED_AT, windows: [row("weekly", 0, "2027-03-15T06:00:00.000Z")] });
  });

  it("is checked now when no time is given", () => {
    const before = Date.now();
    const { checkedAt } = grokUsageResponseToLimits(billing({ type: "WEEKLY", from: MARCH_START, until: MARCH_END }));
    const after = Date.now();
    assert.equal(new Date(checkedAt).toISOString(), checkedAt);
    assert.ok(Date.parse(checkedAt) >= before && Date.parse(checkedAt) <= after, checkedAt);
  });
});
