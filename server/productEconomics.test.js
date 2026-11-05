import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { ensureProductEconomicsSchema, productEconomicsInput, deliveryQuantity } from "./productEconomics.js";
import { getProfitEvents, summarizeProfit, profitReport } from "./profitData.js";

process.env.NODE_ENV = "test";
const { initDb } = await import("./db.js");
const { getBusinessDate } = await import("./businessDate.js");
const { default: products } = await import("./routes/products.js");
const { default: deliveries } = await import("./routes/deliveries.js");
const { default: sales } = await import("./routes/sales.js");
const { default: returns } = await import("./routes/vendorReturns.js");
const { default: dashboard } = await import("./routes/dashboard.js");
const today = getBusinessDate();
const productBody = { name: "Case Cola", category: "Drinks", volume_ml: 330, quantity_per_case: 24, base_price: 20, markup_price: 5, initial_stock: 100, image_url: "data:image/png;base64,photo" };

async function fixture(t, database) {
  const db = database || initDb();
  if (!database) { db.products = []; db.deliveries = []; db.delivery_items = []; db.sales = []; db.sale_items = []; db.vendor_returns = []; db.inventory_movements = []; }
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.db = db; req.user = { role: req.headers["x-role"] || "STAFF", user_id: 3, vendor_id: 1 }; next(); });
  for (const [route, handler] of Object.entries({ products, deliveries, sales, returns, dashboard })) app.use(`/${route}`, handler);
  const server = app.listen(0);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, method = "GET", body, role = "STAFF") => {
    const response = await fetch(`${origin}${route}`, { method, headers: { "content-type": "application/json", "x-role": role }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const create = async (override = {}) => request("/products", "POST", { ...productBody, ...override });
  const deliver = (items, extra = {}) => request("/deliveries", "POST", { vendor_id: 1, delivery_date: today, delivery_time: "09:00", items, ...extra });
  const recordReturn = (deliveryId, quantity = 2) => request("/returns", "POST", { vendor_id: 1, delivery_id: deliveryId, return_date: today, return_time: "10:00", items: [{ product_id: 1, quantity }] });
  return { db, request, create, deliver, recordReturn };
}

test("product metadata derives selling price and validates decimal prices, volume and case quantities", () => {
  assert.deepEqual(productEconomicsInput({ ...productBody, selling_price: 999 }), { volume_ml: 330, quantity_per_case: 24, base_price: 20, markup_price: 5, selling_price: 25 });
  assert.equal(productEconomicsInput({ ...productBody, base_price: "0.10", markup_price: "0.20" }).selling_price, 0.3);
  for (const override of [{ volume_ml: 0 }, { quantity_per_case: 1.5 }, { base_price: -1 }, { markup_price: "" }, { markup_price: 0.001 }, { base_price: Infinity }]) {
    assert.throws(() => productEconomicsInput({ ...productBody, ...override }));
  }
  assert.equal(deliveryQuantity({ entry_unit: "half-case", entry_quantity: 2 }, { quantity_per_case: 24 }).quantity, 24);
  assert.throws(() => deliveryQuantity({ entry_unit: "half-case", entry_quantity: 1 }, { quantity_per_case: 5 }), /even/);
  assert.throws(() => deliveryQuantity({ entry_unit: "case", entry_quantity: 1 }, {}), /quantity per case/);
  assert.throws(() => deliveryQuantity({ quantity: 0.5 }, {}), /whole/);
});

test("new product fields persist, calculated pricing cannot be overridden, Vendors cannot see costs or profit", async (t) => {
  const { create, request } = await fixture(t);
  const result = await create({ selling_price: 999 });
  assert.equal(result.status, 201);
  assert.equal(result.body.data.selling_price, 25);
  assert.equal(result.body.data.quantity_per_case, 24);
  assert.equal(result.body.data.volume_ml, 330);
  assert.equal((await create({ quantity_per_case: 0 })).status, 400);
  const edited = await request("/products/1", "PUT", { ...productBody, base_price: 22, markup_price: 8 });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.data.selling_price, 30);
  assert.equal((await request("/products", "POST", productBody, "VENDOR")).status, 403);
  const vendor = await request("/products", "GET", undefined, "VENDOR");
  assert.equal(vendor.body.data[0].base_price, undefined);
  assert.equal(vendor.body.data[0].markup_price, undefined);
  assert.equal((await request("/products/1", "GET", undefined, "VENDOR")).body.data.base_price, undefined);
  assert.equal((await request(`/dashboard/profits?start_date=${today}&end_date=${today}`, "GET", undefined, "VENDOR")).status, 403);
  assert.equal((await request("/dashboard/profits?start_date=2026-02-31&end_date=2026-03-01")).status, 400);
  assert.equal((await request("/dashboard/profits?start_date=2026-11-05&end_date=2026-11-01")).status, 400);
});

test("case deliveries charge and deduct Items correctly, ignore forged prices and roll back overselling", async (t) => {
  const { db, create, deliver } = await fixture(t);
  await create();
  const full = await deliver([{ product_id: 1, entry_unit: "case", entry_quantity: 2, quantity: 1, unit_cost: 0.01 }]);
  assert.equal(full.status, 201);
  assert.equal(full.body.data.total_amount, 1200);
  assert.equal(full.body.data.items[0].quantity, 48);
  assert.equal(db.products[0].current_stock, 52);
  assert.equal(db.delivery_items[0].unit_base_price, 20);
  assert.equal(db.delivery_items[0].case_size, 24);
  const half = await deliver([{ product_id: 1, entry_unit: "half-case", quantity: 1 }]);
  assert.equal(half.status, 201);
  assert.equal(half.body.data.total_amount, 300);
  assert.equal(db.products[0].current_stock, 40);
  const before = JSON.stringify(db);
  assert.equal((await deliver([{ product_id: 1, entry_unit: "case", quantity: 1 }, { product_id: 1, entry_unit: "case", quantity: 1 }])).status, 400);
  assert.equal(JSON.stringify(db), before);
  assert.equal((await deliver([{ product_id: 1, quantity: 0.5 }])).status, 400);
  assert.equal(summarizeProfit(await getProfitEvents(db, today, today)).gross_profit, 300);
});

test("returns reverse original margin, edits preserve historical costs, and paid/deleted products remain in profit", async (t) => {
  const { db, create, deliver, recordReturn, request } = await fixture(t);
  await create();
  const delivery = await deliver([{ product_id: 1, entry_unit: "case", quantity: 1 }]);
  const id = delivery.body.data.id;
  const vendorDetail = await request(`/deliveries/${id}`, "GET", undefined, "VENDOR");
  assert.equal(vendorDetail.body.data.items[0].unit_base_price, undefined);
  assert.equal(vendorDetail.body.data.items[0].entry_unit, "case");
  await request("/products/1", "PUT", { ...productBody, base_price: 30, markup_price: 10 });
  const returned = await recordReturn(id);
  assert.equal(returned.status, 201);
  assert.equal(returned.body.data.total_amount, 50);
  assert.equal(db.vendor_returns[0].unit_base_price, 20);
  assert.equal(db.products[0].current_stock, 78);
  assert.equal(summarizeProfit(await getProfitEvents(db, today, today)).gross_profit, 110);
  const edit = await request(`/deliveries/${id}`, "PUT", { items: [{ product_id: 1, quantity: 12, unit_cost: 40 }] });
  assert.equal(edit.status, 200);
  assert.equal(db.delivery_items[0].unit_base_price, 20);
  assert.equal(db.delivery_items[0].unit_cost, 25);
  assert.equal(summarizeProfit(await getProfitEvents(db, today, today)).gross_profit, 50);
  assert.equal((await request(`/deliveries/${id}/confirm-payment`, "POST")).status, 200);
  assert.equal((await request("/products/1/permanent", "DELETE")).status, 200);
  const report = await profitReport(db, today, today, today);
  assert.equal(report.summary.range.gross_profit, 50);
  assert.equal(report.products[0].image_url, productBody.image_url);
  assert.equal(report.products[0].name, "Case Cola");
  assert.equal(report.daily[0].gross_profit, 50);
  assert.equal(report.monthly[0].gross_profit, 50);
  assert.equal(report.yearly[0].gross_profit, 50);
  assert.equal((await request("/dashboard")).body.data.todays_profit, 50);
});

test("legacy sales use the captured base-price reference; later edits preserve saved transaction costs", async (t) => {
  const { db, create, request } = await fixture(t);
  await create();
  assert.equal((await request("/sales", "POST", { items: [{ product_id: 1, quantity: 2 }] })).status, 201);
  assert.equal(db.sale_items[0].unit_base_price, 20);
  db.sales.push({ id: 2, sale_date: today, total_amount: 25, user_id: 3 });
  db.sale_items.push({ sale_id: 2, product_id: 1, quantity: 1, unit_price: 25 });
  await request("/products/1", "PUT", { ...productBody, base_price: 5, markup_price: 45 });
  const totals = summarizeProfit(await getProfitEvents(db, today, today));
  assert.equal(totals.gross_profit, 15);
  assert.equal(totals.net_sales, 75);
  assert.equal(totals.known_revenue, 75);
  assert.equal(totals.missing_cost_items, 0);
  assert.equal(totals.missing_cost_lines, 0);
  assert.equal(totals.estimated_cost_items, 1);
});

test("profit grouping includes both endpoints, historical product names/images, negative profit and calendar years", async (t) => {
  const { db, create } = await fixture(t);
  await create();
  db.sales = [{ id: 1, sale_date: "2025-12-31" }, { id: 2, sale_date: "2026-01-01" }, { id: 3, sale_date: "2026-01-02" }];
  db.sale_items = [{ sale_id: 1, product_id: 1, quantity: 1, unit_price: 20, unit_base_price: 10 }, { sale_id: 2, product_id: 1, quantity: 1, unit_price: 20, unit_base_price: 25 }, { sale_id: 3, product_id: 1, quantity: 1, unit_price: 100, unit_base_price: 0 }];
  const report = await profitReport(db, "2025-12-31", "2026-01-01", "2026-01-01");
  assert.equal(report.summary.range.gross_profit, 5);
  assert.equal(report.summary.daily.gross_profit, -5);
  assert.equal(report.summary.yearly.gross_profit, 95);
  assert.deepEqual(report.yearly.map((row) => row.gross_profit), [-5, 10]);
  assert.equal(report.products[0].image_url, productBody.image_url);
});

test("schema additions are idempotent for SQLite and PostgreSQL without rewriting historical costs", async () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE products (id INTEGER PRIMARY KEY, selling_price NUMERIC, current_stock INTEGER); CREATE TABLE sale_items(id INTEGER PRIMARY KEY); CREATE TABLE delivery_items(id INTEGER PRIMARY KEY); CREATE TABLE vendor_returns(id INTEGER PRIMARY KEY); INSERT INTO products VALUES(1,25,12); INSERT INTO delivery_items VALUES(1)");
    ensureProductEconomicsSchema(db);
    ensureProductEconomicsSchema(db);
    assert.deepEqual(db.prepare("SELECT * FROM products").get(), { id: 1, selling_price: 25, current_stock: 12, volume_ml: null, quantity_per_case: null, base_price: null, markup_price: null });
    assert.equal(db.prepare("SELECT unit_base_price FROM delivery_items").get().unit_base_price, null);
  } finally { db.close(); }
  const statements = [];
  await ensureProductEconomicsSchema({ pool: {}, client: () => ({ query: async (sql) => { statements.push(sql); } }) });
  assert.equal(statements.length, 10);
  assert.ok(statements.every((sql) => sql.startsWith("ALTER TABLE ") && sql.includes("ADD COLUMN IF NOT EXISTS")));
});

test("real SQL case delivery, sale and return agree with dashboard and product profit totals", async (t) => {
  const sqlite = new Database(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8").replaceAll("INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY", "INTEGER PRIMARY KEY AUTOINCREMENT"));
  sqlite.exec("INSERT INTO roles(id,name) VALUES(1,'ADMIN'),(2,'STAFF'),(3,'VENDOR'); INSERT INTO users(id,username,email,password,name,role_id) VALUES(3,'staff','staff@test','x','Staff',2); INSERT INTO vendors(id,name,vendor_code) VALUES(1,'Vendor','VND-0001')");
  const db = { prepare: sqlite.prepare.bind(sqlite), exec: sqlite.exec.bind(sqlite), transaction: (fn) => async () => { sqlite.exec("BEGIN"); try { const result = await fn(); sqlite.exec("COMMIT"); return result; } catch (error) { sqlite.exec("ROLLBACK"); throw error; } } };
  const { create, deliver, recordReturn, request } = await fixture(t, db);
  assert.equal((await create()).status, 201);
  const delivery = await deliver([{ product_id: 1, entry_unit: "half-case", quantity: 1 }]);
  assert.equal(delivery.status, 201);
  assert.equal(delivery.body.data.total_amount, 300);
  assert.equal((await request("/sales", "POST", { items: [{ product_id: 1, quantity: 2 }] })).status, 201);
  assert.equal((await recordReturn(delivery.body.data.id)).status, 201);
  assert.equal(sqlite.prepare("SELECT current_stock FROM products").get().current_stock, 88);
  const report = await request(`/dashboard/profits?start_date=${today}&end_date=${today}`);
  assert.equal(report.status, 200);
  assert.equal(report.body.data.summary.range.gross_profit, 60);
  assert.equal(report.body.data.summary.range.delivery_profit, 60);
  assert.equal(report.body.data.summary.range.recorded_profit, 10);
  assert.equal(report.body.data.summary.range.return_profit, -10);
  assert.equal(report.body.data.summary.range.missing_cost_items, 0);
  assert.equal(report.body.data.products[0].image_url, productBody.image_url);
  const before = sqlite.prepare("SELECT current_stock FROM products").get().current_stock;
  assert.equal((await deliver([{ product_id: 1, entry_unit: "case", quantity: 100 }])).status, 400);
  assert.equal(sqlite.prepare("SELECT current_stock FROM products").get().current_stock, before);
});
