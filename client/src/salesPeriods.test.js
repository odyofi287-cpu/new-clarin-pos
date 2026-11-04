import test from "node:test";
import assert from "node:assert/strict";
import { salesPeriodRange, switchSalesPeriod } from "./salesPeriods.js";

test("account sales periods use inclusive calendar days, months and years including leap days", () => {
  assert.deepEqual(salesPeriodRange("daily", "2026-11-05"), { start_date: "2026-11-05", end_date: "2026-11-05" });
  assert.deepEqual(salesPeriodRange("monthly", "2024-02"), { start_date: "2024-02-01", end_date: "2024-02-29" });
  assert.equal(salesPeriodRange("monthly", "2100-02").end_date, "2100-02-28");
  assert.equal(salesPeriodRange("monthly", "2000-02").end_date, "2000-02-29");
  assert.deepEqual(salesPeriodRange("yearly", "2026"), { start_date: "2026-01-01", end_date: "2026-12-31" });
  assert.equal(salesPeriodRange("monthly", "9999-12").end_date, "9999-12-31");
});

test("period changes retain the selected calendar context and reject invalid inputs", () => {
  assert.deepEqual(switchSalesPeriod({ mode: "daily", value: "2025-12-31" }, "monthly"), { mode: "monthly", value: "2025-12" });
  assert.deepEqual(switchSalesPeriod({ mode: "yearly", value: "2025" }, "daily"), { mode: "daily", value: "2025-01-01" });
  for (const [mode, value] of [["daily", "2026-02-29"], ["monthly", "2026-13"], ["yearly", "0000"], ["yearly", "1"], ["weekly", "2026-01-01"]]) assert.throws(() => salesPeriodRange(mode, value));
});
