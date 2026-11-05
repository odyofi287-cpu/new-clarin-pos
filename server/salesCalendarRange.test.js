import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import express from "express";
import dashboardRoutes from "./routes/dashboard.js";
import { getSalesCalendarRange, salesCalendarRangeInput } from "./salesCalendarRange.js";

function fixture() {
  return {
    sale_items: [],
    sales: [
      { sale_date: "2024-02-28", total_amount: 100 },
      { sale_date: "2024-02-29", total_amount: 200 },
      { sale_date: "2024-03-01", total_amount: 300 },
      { sale_date: "2024-03-02", total_amount: 900 },
    ],
    deliveries: [
      { delivery_date: "2024-02-28", total_amount: 50, payment_status: "PAID" },
      { delivery_date: "2024-03-01", total_amount: 75, payment_status: "UNPAID" },
      { delivery_date: "2024-03-02", total_amount: 900 },
    ],
    vendor_returns: [
      { return_date: "2024-02-29", total_product_price_returned: 20 },
      { return_date: "2024-03-01", total_product_price_returned: 25 },
      { return_date: "2024-03-01", total_product_price_returned: 5 },
      { return_date: "2024-03-02", total_product_price_returned: 900 },
    ],
  };
}

function sqlite(rows) {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE sales (sale_date TEXT, total_amount REAL);
    CREATE TABLE deliveries (delivery_date TEXT, total_amount REAL, payment_status TEXT);
    CREATE TABLE vendor_returns (return_date TEXT, total_product_price_returned REAL);`);
  for (const table of ["sales", "deliveries", "vendor_returns"]) {
    for (const row of rows[table]) {
      const keys = Object.keys(row);
      db.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...Object.values(row));
    }
  }
  return db;
}

for (const backend of ["memory", "SQL"]) {
  test(`${backend}: sales calendar range includes both dates, leap day, paid/unpaid deliveries and each return`, async () => {
    const db = backend === "memory" ? fixture() : sqlite(fixture());
    try {
      assert.deepEqual(await getSalesCalendarRange(db, "2024-02-28", "2024-03-01"), {
        start_date: "2024-02-28", end_date: "2024-03-01",
        recorded_sales: 600, vendor_deliveries: 125, vendor_returns: 50, net_sales: 675,
      });
      assert.equal((await getSalesCalendarRange(db, "2024-03-01", "2024-03-01")).net_sales, 345);
      assert.equal((await getSalesCalendarRange(db, "2020-01-01", "2020-12-31")).net_sales, 0);
    } finally { if (backend === "SQL") db.close(); }
  });
}

test("calendar range normalizes Manila date objects and preserves negative net sales", async () => {
  const db = { sale_items: [], sales: [], deliveries: [], vendor_returns: [{ return_date: new Date("2024-02-28T16:00:00Z"), total_product_price_returned: 50 }] };
  assert.equal((await getSalesCalendarRange(db, "2024-02-29", "2024-02-29")).net_sales, -50);
});

test("calendar range rejects missing, invalid, reversed and injected dates before querying", async () => {
  for (const query of [{}, { start_date: "2024-02-28" }, { start_date: "2023-02-29", end_date: "2024-01-01" },
    { start_date: "2024-02-30", end_date: "2024-03-01" }, { start_date: "2024-03-02", end_date: "2024-03-01" },
    { start_date: "2024-01-01' OR 1=1--", end_date: "2024-03-01" }, { start_date: ["2024-01-01"], end_date: "2024-03-01" }]) {
    assert.throws(() => salesCalendarRangeInput(query));
  }
  await assert.rejects(getSalesCalendarRange({}, "2024-02-30", "2024-03-01"));
});

test("PostgreSQL range uses bound dates, indexed predicates, one statement and numeric results", async () => {
  const calls = [];
  const db = { pool: {}, client: () => ({ query: async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [{ recorded_sales: "100.50", vendor_deliveries: "25.25", vendor_returns: "5.25" }] };
  } }) };
  const result = await getSalesCalendarRange(db, "2024-01-01", "2024-12-31");
  assert.equal(result.net_sales, 120.5);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, ["2024-01-01", "2024-12-31", "2024-01-01", "2024-12-31", "2024-01-01", "2024-12-31"]);
  assert.match(calls[0].sql, /sale_date BETWEEN \$1 AND \$2/);
  assert.doesNotMatch(calls[0].sql, /2024|DATE\(|CAST\(|JOIN/i);
});

test("sales calendar API permits Admin/Staff, denies Vendors, validates dates and returns matching totals", async (t) => {
  const app = express();
  app.use((req, res, next) => {
    req.db = fixture();
    req.db.sales.forEach((row) => { row.user_id = 3; });
    req.db.deliveries.forEach((row, index) => { row.id = index + 1; row.created_by = 3; });
    req.db.vendor_returns.forEach((row) => { row.delivery_id = 1; });
    req.db.delivery_items = [];
    req.user = { role: req.headers["x-test-role"], user_id: 3 }; next();
  });
  app.use("/dashboard", dashboardRoutes);
  const server = app.listen(0);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/dashboard/sales-calendar`;
  for (const role of ["ADMIN", "STAFF"]) {
    const response = await fetch(`${base}?start_date=2024-02-28&end_date=2024-03-01`, { headers: { "x-test-role": role } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.net_sales, 675);
  }
  assert.equal((await fetch(`${base}?start_date=2024-02-28&end_date=2024-03-01`, { headers: { "x-test-role": "VENDOR" } })).status, 403);
  assert.equal((await fetch(base, { headers: { "x-test-role": "STAFF" } })).status, 400);
  assert.equal((await fetch(`${base}?start_date=2024-03-02&end_date=2024-03-01`, { headers: { "x-test-role": "ADMIN" } })).status, 400);
});
