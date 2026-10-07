import test from "node:test";
import assert from "node:assert/strict";
import { countHistoryDates, filterHistory, historyDate, historyMonthDays, shiftHistoryDate, shiftHistoryMonth } from "./historyCalendar.js";

test("daily history uses business date, preserves bulk records, and keeps all history accessible", () => {
  const rows = [
    { id: 1, delivery_date: "2026-10-07", created_at: "2026-10-06T16:30:00Z", items: "Cola x2, Water x3" },
    { id: 2, delivery_date: "2026-10-06", created_at: "2026-10-07T01:00:00Z" },
    { id: 3, delivery_date: "2026-10-07T00:00:00.000Z" },
  ];
  assert.deepEqual(filterHistory(rows, "delivery_date", { mode: "daily", date: "2026-10-07" }).map((row) => row.id), [1, 3]);
  assert.equal(filterHistory(rows, "delivery_date", { mode: "daily", date: "2026-10-08" }).length, 0);
  assert.equal(filterHistory(rows, "delivery_date", { mode: "all", date: "2026-10-07" }), rows);
  assert.deepEqual(countHistoryDates(rows, "delivery_date"), { "2026-10-07": 2, "2026-10-06": 1 });
});

test("returns use return date and combined sales use each classification's own date", () => {
  const selection = { mode: "daily", date: "2026-10-07" };
  const returns = [{ return_date: "2026-10-07", delivery_date: "2026-10-06", return_ids: [1, 2], quantity: 5 }];
  assert.equal(filterHistory(returns, "return_date", selection).length, 1);
  assert.equal(filterHistory(returns, "delivery_date", selection).length, 0);
  assert.equal(filterHistory([{ sale_date: "2026-10-07" }, { sale_date: "2026-10-06" }], "sale_date", selection).length, 1);
});

test("vendor and daily filters intersect for payment records and calendar counts", () => {
  const rows = [{ vendor_id: 1, delivery_date: "2026-10-07" }, { vendor_id: 2, delivery_date: "2026-10-07" }, { vendor_id: 1, delivery_date: "2026-10-06" }];
  const vendorRows = rows.filter((row) => row.vendor_id === 1);
  assert.equal(filterHistory(vendorRows, "delivery_date", { mode: "daily", date: "2026-10-07" }).length, 1);
  assert.deepEqual(countHistoryDates(vendorRows, "delivery_date"), { "2026-10-07": 1, "2026-10-06": 1 });
});

test("calendar handles month/year boundaries, leap days, and invalid dates", () => {
  assert.equal(shiftHistoryDate("2026-01-01", -1), "2025-12-31");
  assert.equal(shiftHistoryDate("2024-02-28", 1), "2024-02-29");
  assert.equal(shiftHistoryMonth("2026-12", 1), "2027-01");
  assert.equal(shiftHistoryMonth("2026-01", -1), "2025-12");
  const days = historyMonthDays("2024-02");
  assert.equal(days.length % 7, 0);
  assert.equal(days.filter(Boolean).length, 29);
  assert.equal(days[4], "2024-02-01");
  for (const value of [null, "", "2026-02-30", "not a date"]) assert.equal(historyDate(value), "");
});
