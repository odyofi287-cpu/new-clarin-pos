import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import express from "express";
import router from "./routes/reports.js";
import { totalSalesReport, inventoryReport, reportRange, allTimeSalesRange, salesReport, deliveryReport } from "./reportData.js";
import { buildReportDocument, reportCsv } from "./reportDocument.js";

const DAY = "2026-10-06";
function fixture() {
  return {
    sales: [{ id: 1, user_id: 1, sale_date: DAY, total_amount: 100.25 }, { id: 2, user_id: 1, sale_date: "2026-10-05", total_amount: 900 }],
    sale_items: [{ sale_id: 1, product_id: 1, quantity: 1, unit_price: 100.25 }, { sale_id: 2, product_id: 1, quantity: 9, unit_price: 100 }],
    deliveries: [{ id: 1, vendor_id: 1, delivery_date: DAY, total_amount: 200, payment_status: "PAID" }, { id: 2, vendor_id: 2, delivery_date: "2026-10-05", total_amount: 900, payment_status: "UNPAID" }],
    delivery_items: [{ delivery_id: 1, product_id: 1, quantity: 2, unit_cost: 100 }, { delivery_id: 2, product_id: 1, quantity: 9, unit_cost: 100 }],
    vendor_returns: [{ id: 1, product_id: 1, return_date: DAY, return_batch_id: "bulk", quantity: 1, total_product_price_returned: 100 }, { id: 2, product_id: 2, return_date: DAY, return_batch_id: "bulk", quantity: 1, total_product_price_returned: 10 }],
    products: [{ id: 1, name: 'Piñá, "Special"', category: "Food", unit: "pack", image_url: "data:image/png;base64,image", active: 1, current_stock: 5, minimum_stock: 10 }, { id: 2, name: "Returns only", category: "Food", unit: "pack", image_url: null, active: 1, current_stock: 0, minimum_stock: 10 }],
    vendors: [{ id: 1, name: "Vendor one" }, { id: 2, name: "Vendor two" }],
    users: [{ id: 1, name: "Report Author", username: "staff", vendor_id: null, active: 1 }, { id: 2, name: "Vendor one", username: "vendor-updated", vendor_id: 1, active: 1 }],
    inventory_movements: [{ product_id: 1, movement_type: "STOCK_IN", quantity: 5, created_at: "2026-10-05T16:00:00Z" }, { product_id: 1, movement_type: "STOCK_OUT", quantity: 2, created_at: "2026-10-06T15:59:59Z" }, { product_id: 1, movement_type: "STOCK_IN", quantity: 99, created_at: "2026-10-06T16:00:00Z" }],
  };
}

function sqlite(rows) {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE sales (id INTEGER, user_id INTEGER, sale_date TEXT, total_amount REAL);
    CREATE TABLE sale_items (sale_id INTEGER, product_id INTEGER, quantity REAL, unit_price REAL);
    CREATE TABLE deliveries (id INTEGER, vendor_id INTEGER, delivery_date TEXT, total_amount REAL, payment_status TEXT);
    CREATE TABLE delivery_items (delivery_id INTEGER, product_id INTEGER, quantity REAL, unit_cost REAL);
    CREATE TABLE vendor_returns (id INTEGER, product_id INTEGER, return_date TEXT, return_batch_id TEXT, quantity REAL, total_product_price_returned REAL);
    CREATE TABLE products (id INTEGER, name TEXT, category TEXT, unit TEXT, image_url TEXT, active INTEGER, current_stock REAL, minimum_stock REAL);
    CREATE TABLE vendors (id INTEGER, name TEXT);
    CREATE TABLE users (id INTEGER, name TEXT, username TEXT, vendor_id INTEGER, active INTEGER);
    CREATE TABLE inventory_movements (product_id INTEGER, movement_type TEXT, quantity REAL, created_at TEXT);`);
  for (const [table, entries] of Object.entries(rows)) for (const row of entries) {
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...Object.values(row));
  }
  return db;
}

for (const backend of ["in-memory", "SQLite"]) {
  test(`${backend}: selected-day sales reconciles product totals and counts bulk returns once`, async () => {
    const db = backend === "SQLite" ? sqlite(fixture()) : fixture();
    try {
      const report = await totalSalesReport(db, DAY, DAY);
      assert.deepEqual(report.totals, { recorded_sales: 100.25, delivery_total: 200, return_total: 110, transactions: 3, total: 190.25 });
      assert.equal(report.products.reduce((sum, p) => sum + p.net_sales, 0), 190.25);
      assert.equal(report.products[1].net_sales, -10);
      assert.equal(report.products[0].net_quantity, 2);
      assert.equal(report.products[0].image_url, fixture().products[0].image_url);
      assert.equal(report.daily.length, 1);
      assert.equal(report.daily[0].period, DAY);
      assert.equal(report.weekly[0].period, "2026-10-05");
      assert.equal(report.weekly[0].total, 190.25);
      assert.equal(report.monthly[0].period, "2026-10");
      const range = await totalSalesReport(db, "2026-10-05", DAY);
      assert.equal(range.totals.total, 1990.25);
      assert.equal((await totalSalesReport(db, "2026-01-01", "2026-01-01")).totals.total, 0);
      assert.equal((await allTimeSalesRange(db)).start, "2026-10-05");
    } finally { if (backend === "SQLite") db.close(); }
  });
  test(`${backend}: inventory applies Manila midnight boundaries and explicitly retains live stock`, async () => {
    const db = backend === "SQLite" ? sqlite(fixture()) : fixture();
    try {
      const rows = await inventoryReport(db, DAY, DAY);
      const product = rows.find((row) => row.product.startsWith("Piñá"));
      assert.equal(product.stock_in, 5);
      assert.equal(product.stock_out, 2);
      assert.equal(product.current_stock, 5);
      assert.equal(product.stock_status, "LOW_STOCK");
      assert.equal(rows.find((row) => row.product === "Returns only").stock_status, "OUT_OF_STOCK");
      assert.match(buildReportDocument("inventory", rows, { start: DAY, end: DAY }, {}).note, /not historical closing/);
    } finally { if (backend === "SQLite") db.close(); }
  });
  test(`${backend}: delivery reports are vendor-scoped and use updated registered usernames`, async () => {
    const db = backend === "SQLite" ? sqlite(fixture()) : fixture();
    try {
      const own = await deliveryReport(db, "2026-10-01", DAY, { role: "VENDOR", vendor_id: 1 });
      assert.equal(own.length, 1); assert.equal(own[0].vendor, "vendor-updated");
      assert.equal((await deliveryReport(db, "2026-10-01", DAY, { role: "STAFF" })).length, 2);
      assert.equal((await salesReport(db, DAY, DAY)).length, 1);
    } finally { if (backend === "SQLite") db.close(); }
  });
}

test("server validates calendar dates before running queries", () => {
  for (const date of ["2026-02-29", "2026-02-30", "2026-13-01", "bad", [DAY], "0000-01-01"]) assert.throws(() => reportRange({ start_date: date, end_date: DAY }));
  assert.throws(() => reportRange({ start_date: "2026-10-07", end_date: DAY }), /on or before/);
  assert.deepEqual(reportRange({ start_date: "2024-02-29", end_date: "2024-03-01" }), { start: "2024-02-29", end: "2024-03-01" });
});

test("report warns about legacy header/line differences without rewriting source data", async () => {
  const db = fixture();
  db.sales[0].total_amount = 500;
  const data = await totalSalesReport(db, DAY, DAY);
  const report = buildReportDocument("total-sales", data, { start: DAY, end: DAY }, {});
  assert.match(report.note, /Reconciliation notice/);
  assert.match(report.note, /No historical values have been modified/);
  assert.equal(db.sales[0].total_amount, 500);
  assert.equal(data.products[0].recorded_sales, 100.25);
});

test("CSV has metadata, separated summary/detail tables, fixed money precision and formula-safe text", async () => {
  const data = await totalSalesReport(fixture(), DAY, DAY);
  data.products[0].name = '=HYPERLINK("https://example.com")';
  data.products[0].category = "\t+1+1";
  const report = buildReportDocument("total-sales", data, { start: DAY, end: DAY }, { name: "@Author" });
  const csv = reportCsv(report);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.ok(csv.includes("SUMMARY")); assert.ok(csv.includes("PRODUCT SALES"));
  assert.ok(csv.includes("PRODUCT QUANTITIES")); assert.ok(csv.includes("DAILY SALES"));
  assert.ok(csv.includes("Net sales,190.25")); assert.ok(csv.includes("-10.00"));
  assert.ok(csv.includes("'=HYPERLINK")); assert.ok(csv.includes("'\t+1+1"));
  assert.ok(csv.includes("'@Author")); assert.ok(!csv.includes("base64"));
  assert.ok(csv.endsWith("\r\n"));
  const quoted = reportCsv(buildReportDocument("sales", [{ transaction_id: 1, sale_date: DAY, staff: 'Piñá, "Special"\nStaff', items: "-100.00", quantity: 2, total_amount: -100.25 }], { start: DAY, end: DAY }, {}));
  assert.ok(quoted.includes('"Piñá, ""Special""\nStaff"'));
  assert.ok(quoted.includes("'-100.00")); assert.ok(quoted.includes("-100.25"));
});

test("all report routes share preview/CSV data, validate dates, and enforce vendor isolation", async () => {
  const app = express(); const db = fixture();
  app.use((req, res, next) => { req.db = db; req.user = { user_id: 1, role: req.headers["x-test-role"] || "STAFF", vendor_id: 1 }; next(); });
  app.use(router);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const mode of ["sales", "inventory", "vendor-deliveries", "total-sales"]) {
      const path = `/${mode}?start_date=${DAY}&end_date=${DAY}`;
      const response = await fetch(base + path); assert.equal(response.status, 200);
      const body = await response.json(); assert.ok(Array.isArray(body.data));
      assert.equal(body.report.prepared_by, "Report Author");
      const csv = await fetch(`${base}/${mode}/csv?start_date=${DAY}&end_date=${DAY}`);
      assert.equal(csv.status, 200); assert.match(csv.headers.get("content-type"), /charset=utf-8/);
      assert.ok((await csv.text()).includes(body.report.title));
    }
    assert.equal((await fetch(`${base}/total-sales?start_date=2026-02-30`)).status, 400);
    const allTime = await (await fetch(`${base}/total-sales?scope=all-time`)).json();
    assert.equal(allTime.report.period.scope, "all-time");
    assert.equal(allTime.report.period.start_date, "2026-10-05");
    for (const path of ["total-sales", "total-sales/csv", "sales", "sales/csv", "inventory", "inventory/csv"]) assert.equal((await fetch(`${base}/${path}`, { headers: { "x-test-role": "VENDOR" } })).status, 403);
    const own = await (await fetch(`${base}/vendor-deliveries?start_date=2026-10-01&end_date=${DAY}`, { headers: { "x-test-role": "VENDOR" } })).json();
    assert.equal(own.data.length, 1); assert.equal(own.data[0].delivery_id, 1);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
