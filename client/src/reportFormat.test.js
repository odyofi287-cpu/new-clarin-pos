import test from "node:test";
import assert from "node:assert/strict";
import { rangeError, formatReportValue } from "./reportFormat.js";

test("calendar validates real dates, leap years, and order", () => {
  assert.equal(rangeError({ start_date: "2024-02-29", end_date: "2024-03-01" }), "");
  for (const date of ["", "2026-02-29", "2026-02-30", "2026-13-01", "0000-01-01", "2026-1-1"]) assert.ok(rangeError({ start_date: date, end_date: date }));
  assert.match(rangeError({ start_date: "2026-10-07", end_date: "2026-10-06" }), /on or before/);
});

test("report formatting preserves negative money and ISO business dates", () => {
  assert.match(formatReportValue(-100.5, "money"), /100\.50/);
  assert.ok(formatReportValue(-100.5, "money").includes("-"));
  assert.match(formatReportValue("2026-10-06", "date"), /6/);
  assert.match(formatReportValue("2026-10-06", "date"), /2026/);
  assert.equal(formatReportValue("OUT_OF_STOCK", "status"), "OUT OF STOCK");
  assert.equal(formatReportValue('Piñá, "Special"'), 'Piñá, "Special"');
});
