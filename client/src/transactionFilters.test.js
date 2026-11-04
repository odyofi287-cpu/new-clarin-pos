import test from "node:test";
import assert from "node:assert/strict";
import { filterTransactions, transactionFilterOptions } from "./transactionFilters.js";
import { filterHistory, countHistoryDates } from "./historyCalendar.js";

const records = [
  { id: 1, actor_id: 3, actor_name: "Alex", actor_username: "alex.staff", date: "2026-11-05", total_amount: 200, product_refs: [{ id: 1, name: "Cola" }, { id: 2, name: "Cola, Lime" }] },
  { id: 2, actor_id: 4, actor_name: "Alex", actor_username: "alex.admin", date: "2026-11-05", total_amount: 50, product_refs: [{ id: 3, name: "Cola" }] },
  { id: 3, actor_id: 3, actor_name: "Alex", date: "2026-11-04", total_amount: 20, product_refs: [{ id: 2, name: "Cola, Lime" }] },
  { id: 4, actor_id: null, date: "2026-11-05", total_amount: 10, product_refs: [{ id: 1, name: "Cola" }] },
];

test("history product/account filters intersect by stable IDs and preserve entire bulk records", () => {
  const selected = filterTransactions(records, { product: "1", account: "3" });
  assert.equal(selected.length, 1);
  assert.equal(selected[0], records[0]);
  assert.equal(selected[0].total_amount, 200);
  assert.equal(selected[0].product_refs.length, 2);
  assert.deepEqual(filterTransactions(records, { product: "3" }).map((row) => row.id), [2]);
  assert.deepEqual(filterTransactions(records, { account: "unattributed" }).map((row) => row.id), [4]);
  assert.equal(filterTransactions(records, {}).length, 4);
});

test("history options retain removed products, punctuation, duplicate names and distinct accounts", () => {
  const options = transactionFilterOptions(records, [{ id: 8, name: "New stock" }]);
  assert.equal(options.products.length, 4);
  assert.equal(options.products.find((row) => row.id === "2").name, "Cola, Lime");
  assert.equal(options.products.filter((row) => row.name === "Cola").length, 2);
  assert.ok(options.accounts.some((row) => row.id === "3"));
  assert.ok(options.accounts.some((row) => row.id === "4"));
  assert.ok(options.accounts.some((row) => row.id === "unattributed"));
});

test("calendar counts and daily history respect selected product/account without changing totals", () => {
  const filtered = filterTransactions(records, { product: "2", account: "3" });
  assert.deepEqual(countHistoryDates(filtered, "date"), { "2026-11-05": 1, "2026-11-04": 1 });
  assert.deepEqual(filterHistory(filtered, "date", { mode: "daily", date: "2026-11-04" }).map((row) => row.id), [3]);
});
