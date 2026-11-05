import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { captureLegacyProfitCost, ensureLegacyProfitCostSchema } from "./legacyProfitCosts.js";
import { getProfitEvents, summarizeProfit, profitReport } from "./profitData.js";

process.env.NODE_ENV = "test";
const { initDb } = await import("./db.js");
const { getBusinessDate } = await import("./businessDate.js");
const { default: products } = await import("./routes/products.js");
const { default: sales } = await import("./routes/sales.js");
const { default: dashboard } = await import("./routes/dashboard.js");
const today = getBusinessDate();

function fixture() {
  const db = initDb();
  db.products = [{ id: 1, name: "Cola", category: "Drinks", base_price: 10, markup_price: 15, selling_price: 25, current_stock: 100, active: 1, image_url: "data:image/png;base64,photo" }];
  db.sales = [{ id: 1, user_id: 3, sale_date: today, total_amount: 50 }, { id: 2, user_id: 3, sale_date: today, total_amount: 25 }];
  db.sale_items = [{ id: 1, sale_id: 1, product_id: 1, quantity: 2, unit_price: 25, unit_base_price: null }, { id: 2, sale_id: 2, product_id: 1, quantity: 1, unit_price: 25, unit_base_price: 4 }];
  db.deliveries = [{ id: 1, vendor_id: 1, delivery_date: today, total_amount: 90, created_by: 3 }];
  db.delivery_items = [{ id: 1, delivery_id: 1, product_id: 1, quantity: 3, unit_cost: 30, unit_base_price: null }];
  db.vendor_returns = [{ id: 1, delivery_id: 1, product_id: 1, quantity: 1, total_product_price_returned: 30, return_date: today, unit_base_price: null }];
  db.inventory_movements = [];
  return db;
}

async function api(t, db) {
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { req.db = db; req.user = { role: req.headers["x-role"] || "STAFF", user_id: 3 }; next(); });
  app.use("/products", products); app.use("/sales", sales); app.use("/dashboard", dashboard);
  const server = app.listen(0); t.after(() => new Promise((resolve) => server.close(resolve)));
  return async (url, method = "GET", body, role = "STAFF") => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method, headers: { "content-type": "application/json", "x-role": role }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
}

test("SQLite upgrade captures current base prices once, including zero and hidden products", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE products(id INTEGER PRIMARY KEY, name TEXT, base_price NUMERIC, selling_price NUMERIC, current_stock INTEGER, active INTEGER); INSERT INTO products VALUES(1,'Cola',10,25,100,1),(2,'No cost',NULL,30,9,1),(3,'Zero cost',0,5,5,1),(4,'Hidden',8,12,2,0)");
    ensureLegacyProfitCostSchema(db);
    const first = db.prepare("SELECT * FROM products ORDER BY id").all();
    assert.deepEqual(first.map((row) => row.legacy_base_price), [10, null, 0, 8]);
    assert.ok(first[0].legacy_base_price_set_at);
    db.exec("UPDATE products SET base_price = 20 WHERE id = 1");
    ensureLegacyProfitCostSchema(db);
    const later = db.prepare("SELECT * FROM products ORDER BY id").all();
    assert.equal(later[0].legacy_base_price, 10);
    assert.equal(later[0].legacy_base_price_set_at, first[0].legacy_base_price_set_at);
    assert.deepEqual(later.map((row) => [row.selling_price, row.current_stock, row.active]), first.map((row) => [row.selling_price, row.current_stock, row.active]));
    db.exec("UPDATE products SET base_price = 7 WHERE id = 2");
    ensureLegacyProfitCostSchema(db);
    assert.equal(db.prepare("SELECT legacy_base_price FROM products WHERE id=2").get().legacy_base_price, 7);
  } finally { db.close(); }
});

test("Postgres startup is additive and only captures a missing product cost reference", async () => {
  const queries = [];
  await ensureLegacyProfitCostSchema({ pool: {}, client: () => ({ query: async (sql, params) => { queries.push({ sql, params }); return { rows: [], rowCount: 0 }; } }) });
  assert.equal(queries.length, 3);
  assert.match(queries[0].sql, /ADD COLUMN IF NOT EXISTS legacy_base_price NUMERIC/);
  assert.match(queries[1].sql, /ADD COLUMN IF NOT EXISTS legacy_base_price_set_at TIMESTAMPTZ/);
  assert.match(queries[2].sql, /WHERE legacy_base_price IS NULL AND base_price BETWEEN/);
  assert.doesNotMatch(queries.map((row) => row.sql).join("\n"), /UPDATE (sale_items|delivery_items|vendor_returns)|DROP|DELETE/);
});

test("missing historical costs are completed, original amounts stay unchanged, and estimates are disclosed", async () => {
  const db = fixture();
  const transactions = JSON.stringify([db.sales, db.sale_items, db.deliveries, db.delivery_items, db.vendor_returns, db.inventory_movements]);
  captureLegacyProfitCost(db);
  const report = await profitReport(db, today, today, today);
  assert.equal(report.summary.range.gross_profit, 91);
  assert.equal(report.summary.range.missing_cost_items, 0);
  assert.equal(report.summary.range.reconstructed_cost_items, 6);
  assert.equal(report.summary.range.estimated_cost_items, 6);
  assert.equal(report.summary.range.known_revenue, 135);
  assert.equal(report.products[0].image_url, db.products[0].image_url);
  assert.equal(report.daily[0].gross_profit, 91);
  assert.equal(report.monthly[0].gross_profit, 91);
  assert.equal(report.yearly[0].gross_profit, 91);
  assert.equal(JSON.stringify([db.sales, db.sale_items, db.deliveries, db.delivery_items, db.vendor_returns, db.inventory_movements]), transactions);
  assert.equal(db.products[0].current_stock, 100);
});

test("subsequent pricing edits preserve estimates while new sales follow the updated base price", async (t) => {
  const db = fixture(); captureLegacyProfitCost(db);
  const request = await api(t, db);
  const edit = await request("/products/1", "PUT", { name: "Cola", base_price: 20, markup_price: 15 });
  assert.equal(edit.status, 200);
  assert.equal(db.products[0].legacy_base_price, 10);
  assert.equal(summarizeProfit(await getProfitEvents(db, today, today)).gross_profit, 91);
  assert.equal((await request("/sales", "POST", { items: [{ product_id: 1, quantity: 1 }] })).status, 201);
  assert.equal(db.sale_items.at(-1).unit_base_price, 20);
  assert.equal(db.sale_items.at(-1).unit_price, 35);
  assert.equal(summarizeProfit(await getProfitEvents(db, today, today)).gross_profit, 106);
  const vendor = await request("/products/1", "GET", undefined, "VENDOR");
  assert.equal(vendor.body.data.legacy_base_price, undefined);
  assert.equal(vendor.body.data.legacy_base_price_set_at, undefined);
  assert.equal((await request(`/dashboard/profits?start_date=${today}&end_date=${today}`, "GET", undefined, "VENDOR")).status, 403);
});

test("first base-price input completes older gaps but selling price alone is never mistaken for cost", async (t) => {
  const db = fixture();
  db.products[0].base_price = null; db.products[0].markup_price = null;
  db.sale_items = [db.sale_items[0]]; db.sales = [db.sales[0]]; db.deliveries = []; db.delivery_items = []; db.vendor_returns = [];
  captureLegacyProfitCost(db);
  assert.equal(summarizeProfit(await getProfitEvents(db, today, today)).missing_cost_items, 2);
  const request = await api(t, db);
  assert.equal((await request("/products/1", "PUT", { name: "Cola", base_price: 12, markup_price: 13 })).status, 200);
  assert.equal(db.products[0].legacy_base_price, 12);
  const totals = summarizeProfit(await getProfitEvents(db, today, today));
  assert.equal(totals.missing_cost_items, 0);
  assert.equal(totals.estimated_cost_items, 2);
  assert.equal(totals.gross_profit, 26);
  assert.equal(db.sale_items[0].unit_base_price, null);
});

test("a pre-existing current base price is captured before the first subsequent edit", async (t) => {
  const db = fixture(); const request = await api(t, db);
  assert.equal((await request("/products/1", "PUT", { name: "Cola", base_price: 30, markup_price: 2 })).status, 200);
  assert.equal(db.products[0].legacy_base_price, 10);
  assert.equal(summarizeProfit(await getProfitEvents(db, today, today)).gross_profit, 91);
});

test("saved zero costs and negative historical margins are retained rather than replaced or clamped", async () => {
  const db = fixture();
  db.sales = [{ id: 1, sale_date: today }]; db.sale_items = [{ id: 1, sale_id: 1, product_id: 1, quantity: 1, unit_price: 5, unit_base_price: 0 }, { id: 2, sale_id: 1, product_id: 1, quantity: 1, unit_price: 2, unit_base_price: null }]; db.deliveries = []; db.delivery_items = []; db.vendor_returns = [];
  captureLegacyProfitCost(db);
  const totals = summarizeProfit(await getProfitEvents(db, today, today));
  assert.equal(totals.gross_profit, -3);
  assert.equal(totals.estimated_cost_items, 1);
});

test("SQL estimates and weighted original delivery costs agree with memory without report-time writes", async (t) => {
  const memory = fixture();
  memory.products[0].base_price = 25;
  memory.sales = []; memory.sale_items = [];
  memory.deliveries[0].total_amount = 40;
  memory.delivery_items = [{ id: 1, delivery_id: 1, product_id: 1, quantity: 1, unit_cost: 20, unit_base_price: 10 }, { id: 2, delivery_id: 1, product_id: 1, quantity: 1, unit_cost: 20, unit_base_price: 11 }];
  memory.vendor_returns[0].total_product_price_returned = 20;
  captureLegacyProfitCost(memory);
  const db = new Database(":memory:"); t.after(() => db.close());
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8").replaceAll("INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY", "INTEGER PRIMARY KEY AUTOINCREMENT"));
  db.exec("INSERT INTO roles(id,name) VALUES(1,'STAFF'); INSERT INTO users(id,username,email,password,name,role_id) VALUES(3,'staff','staff@example.test','not-real','Staff',1); INSERT INTO vendors(id,name,vendor_code) VALUES(1,'Vendor','VND-0001')");
  db.prepare("INSERT INTO products(id,name,selling_price,base_price,current_stock,legacy_base_price,active) VALUES(1,'Cola',25,25,100,25,1)").run();
  db.prepare("INSERT INTO deliveries(id,vendor_id,created_by,delivery_date,total_amount) VALUES(1,1,3,?,40)").run(today);
  db.exec("INSERT INTO delivery_items(id,delivery_id,product_id,quantity,unit_cost,unit_base_price) VALUES(1,1,1,1,20,10),(2,1,1,1,20,11)");
  db.prepare("INSERT INTO vendor_returns(id,vendor_id,delivery_id,product_id,quantity,total_product_price_returned,return_date,return_time) VALUES(1,1,1,1,1,20,?,'10:00')").run(today);
  const before = JSON.stringify([db.prepare("SELECT * FROM products").all(), db.prepare("SELECT * FROM delivery_items").all(), db.prepare("SELECT * FROM vendor_returns").all()]);
  const totals = summarizeProfit(await getProfitEvents(db, today, today));
  assert.deepEqual(totals, summarizeProfit(await getProfitEvents(memory, today, today)));
  assert.equal(totals.gross_profit, 9.5);
  assert.equal(totals.reconstructed_cost_items, 1);
  assert.equal(totals.estimated_cost_items, 0);
  db.exec("UPDATE delivery_items SET unit_base_price=NULL WHERE id=2"); memory.delivery_items[1].unit_base_price = null;
  assert.equal(summarizeProfit(await getProfitEvents(db, today, today)).gross_profit, 2.5);
  db.exec("UPDATE vendor_returns SET quantity=2,total_product_price_returned=40");
  Object.assign(memory.vendor_returns[0], { quantity: 2, total_product_price_returned: 40 });
  const fullyReturned = summarizeProfit(await getProfitEvents(db, today, today));
  assert.equal(fullyReturned.gross_profit, 0);
  assert.deepEqual(fullyReturned, summarizeProfit(await getProfitEvents(memory, today, today)));
  db.exec("UPDATE vendor_returns SET quantity=1,total_product_price_returned=20");
  Object.assign(memory.vendor_returns[0], { quantity: 1, total_product_price_returned: 20 });
  db.exec("UPDATE delivery_items SET unit_base_price=NULL"); memory.delivery_items.forEach((row) => { row.unit_base_price = null; });
  const fallback = summarizeProfit(await getProfitEvents(db, today, today));
  assert.deepEqual(fallback, summarizeProfit(await getProfitEvents(memory, today, today)));
  assert.equal(fallback.gross_profit, -5);
  assert.equal(fallback.estimated_cost_items, 3);
  assert.equal(db.prepare("SELECT unit_base_price FROM vendor_returns").get().unit_base_price, null);
  db.exec("UPDATE delivery_items SET unit_base_price=CASE WHEN id=1 THEN 10 ELSE 11 END");
  assert.equal(JSON.stringify([db.prepare("SELECT * FROM products").all(), db.prepare("SELECT * FROM delivery_items").all(), db.prepare("SELECT * FROM vendor_returns").all()]), before);
});
