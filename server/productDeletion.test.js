import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import Database from "better-sqlite3";
import products from "./routes/products.js";
import { ensureProductDeletionSchema } from "./productDeletionSchema.js";
import { ensureProductEconomicsSchema } from "./productEconomics.js";
import { restockVendorReturn, reverseVendorReturnStock } from "./routes/returnInventory.js";
import { getStockAlerts } from "./routes/dashboard.js";
import { buildReportDocument } from "./reportDocument.js";
import { getSalesCalendarRange } from "./salesCalendarRange.js";

process.env.NODE_ENV = "test";
const { initDb } = await import("./db.js");
const { default: deliveries } = await import("./routes/deliveries.js");
const { default: sales } = await import("./routes/sales.js");
const { default: returns } = await import("./routes/vendorReturns.js");
const { getBusinessDate } = await import("./businessDate.js");

async function api(t, db, includeTransactions = false) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.db = db; req.user = { role: req.headers["x-test-role"] || "STAFF", user_id: 3 }; next(); });
  app.use("/products", products);
  if (includeTransactions) { app.use("/deliveries", deliveries); app.use("/sales", sales); app.use("/returns", returns); }
  const server = app.listen(0);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (url, method = "GET", body, role = "STAFF") => {
    const response = await fetch(`${base}${url}`, { method, headers: { "content-type": "application/json", "x-test-role": role },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
}

test("existing SQL product schema upgrades repeatedly without changing products or history", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT, current_stock INTEGER); INSERT INTO products VALUES (1, 'Historical product', 7)");
    ensureProductDeletionSchema(db);
    ensureProductDeletionSchema(db);
    assert.deepEqual(db.prepare("SELECT * FROM products").get(), { id: 1, name: "Historical product", current_stock: 7, deleted_at: null });
  } finally { db.close(); }
});

test("PostgreSQL product schema uses an additive idempotent timestamp column", async () => {
  const queries = [];
  await ensureProductDeletionSchema({ pool: {}, client: () => ({ query: async (sql) => { queries.push(sql); } }) });
  assert.deepEqual(queries, ["ALTER TABLE products ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ"]);
});

test("SQL catalog deletion preserves foreign-key history, images and stock; return adjustments never restore visibility", async (t) => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE roles (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE users (id INTEGER PRIMARY KEY, active INTEGER, vendor_id INTEGER, role_id INTEGER REFERENCES roles(id));
    INSERT INTO roles VALUES (1,'STAFF'); INSERT INTO users VALUES (3,1,NULL,1);
    CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT, category TEXT, selling_price REAL, current_stock INTEGER, minimum_stock INTEGER, unit TEXT, image_url TEXT, active INTEGER);
    CREATE TABLE sales (id INTEGER PRIMARY KEY);
    CREATE TABLE sale_items (id INTEGER PRIMARY KEY, sale_id INTEGER REFERENCES sales(id), product_id INTEGER REFERENCES products(id), quantity INTEGER, unit_price REAL);
    CREATE TABLE deliveries (id INTEGER PRIMARY KEY);
    CREATE TABLE delivery_items (id INTEGER PRIMARY KEY, delivery_id INTEGER REFERENCES deliveries(id), product_id INTEGER REFERENCES products(id), quantity INTEGER, unit_cost REAL);
    CREATE TABLE inventory_movements (id INTEGER PRIMARY KEY, product_id INTEGER REFERENCES products(id), movement_type TEXT, quantity INTEGER, reference_type TEXT, reference_id INTEGER, user_id INTEGER, created_at TEXT);
    INSERT INTO products VALUES (1,'Old Cola','Drinks',35,5,10,'unit','data:image/png;base64,old-photo',1), (2,'Archived Water','Drinks',25,7,10,'unit',NULL,0);
    INSERT INTO sales VALUES (1); INSERT INTO sale_items VALUES (1,1,1,2,30);
    INSERT INTO deliveries VALUES (1); INSERT INTO delivery_items VALUES (1,1,1,4,25);`);
  ensureProductDeletionSchema(db);
  ensureProductEconomicsSchema(db);
  const historyBefore = JSON.stringify([db.prepare("SELECT * FROM sale_items").all(), db.prepare("SELECT * FROM delivery_items").all()]);
  const request = await api(t, db);
  assert.equal((await request("/products/1/permanent", "DELETE", undefined, "VENDOR")).status, 403);
  assert.equal((await request("/products/1/permanent", "DELETE", undefined, "ADMIN")).status, 200);
  assert.deepEqual((await request("/products?active=all")).body.data.map((product) => product.id), [2]);
  assert.equal((await request("/products/1/activate", "PATCH", { active: true })).status, 410);
  const detail = (await request("/products/1")).body.data;
  assert.ok(detail.deleted_at);
  assert.equal(detail.image_url, "data:image/png;base64,old-photo");
  assert.equal(detail.current_stock, 5);
  await restockVendorReturn(db, { id: 10, product_id: 1, quantity: 2 }, 3);
  assert.equal(db.prepare("SELECT current_stock FROM products WHERE id=1").get().current_stock, 7);
  assert.deepEqual((await request("/products?active=all")).body.data.map((product) => product.id), [2]);
  assert.equal((await getStockAlerts(db)).stock_alert_products.length, 0);
  assert.equal(JSON.stringify([db.prepare("SELECT * FROM sale_items").all(), db.prepare("SELECT * FROM delivery_items").all()]), historyBefore);
  assert.equal(db.prepare("SELECT p.name FROM delivery_items i JOIN products p ON p.id=i.product_id").get().name, "Old Cola");
  await reverseVendorReturnStock(db, { id: 10, product_id: 1 }, 3);
  assert.equal((await request("/products/1")).body.data.current_stock, 5);
  assert.equal((await request("/products/1/permanent", "DELETE")).status, 200);
  assert.equal((await request("/products/1", "PUT", { name: "Resurrect", selling_price: 1 })).status, 410);
});

test("deleted product stays hidden after a real return, while old records and financial totals remain available", async (t) => {
  const db = initDb();
  db.vendor_returns = [];
  db.deliveries[0].delivery_date = getBusinessDate();
  db.deliveries[0].payment_status = "UNPAID";
  db.deliveries[0].created_by = 3;
  const request = await api(t, db, true);
  const originalSales = JSON.stringify(db.sales);
  const originalSaleItems = JSON.stringify(db.sale_items);
  const originalDeliveries = JSON.stringify(db.deliveries);
  const originalDeliveryItems = JSON.stringify(db.delivery_items);
  const stockBefore = db.products[0].current_stock;
  const totalsBefore = await getSalesCalendarRange(db, getBusinessDate(), getBusinessDate());
  assert.equal((await request("/products/1/permanent", "DELETE")).status, 200);
  const eligible = await request("/returns/eligible-products?vendor_id=1&delivery_id=1");
  assert.ok(eligible.body.data.some((product) => product.id === 1));
  const returned = await request("/returns", "POST", { vendor_id: 1, delivery_id: 1, return_date: getBusinessDate(), return_time: "10:30", items: [{ product_id: 1, quantity: 2 }] });
  assert.equal(returned.status, 201);
  assert.equal(db.products[0].current_stock, stockBefore + 2);
  assert.equal(db.products[0].active, 0);
  const totalsAfter = await getSalesCalendarRange(db, getBusinessDate(), getBusinessDate());
  assert.equal(totalsAfter.recorded_sales, totalsBefore.recorded_sales);
  assert.equal(totalsAfter.vendor_deliveries, totalsBefore.vendor_deliveries);
  assert.equal(totalsAfter.net_sales, totalsBefore.net_sales - 50);
  assert.ok(db.products[0].deleted_at);
  assert.ok(!(await request("/products?active=all")).body.data.some((product) => product.id === 1));
  assert.equal(JSON.stringify(db.sales), originalSales);
  assert.equal(JSON.stringify(db.sale_items), originalSaleItems);
  assert.equal(JSON.stringify(db.deliveries), originalDeliveries);
  assert.equal(JSON.stringify(db.delivery_items), originalDeliveryItems);
  assert.match((await request("/deliveries/1")).body.data.items[0].product_name, /Cola/);
  assert.equal((await request("/sales", "POST", { items: [{ product_id: 1, quantity: 1 }] })).status, 400);
  assert.equal((await request("/deliveries", "POST", { vendor_id: 1, pickup_datetime: `${getBusinessDate()}T11:00`, items: [{ product_id: 1, quantity: 1 }] })).status, 400);
  assert.equal((await request("/products/1/activate", "PATCH", { active: true })).status, 410);
  assert.equal((await request("/deliveries/1", "PUT", { vendor_id: 1, items: [{ product_id: 1, quantity: 21, unit_cost: 25 }, { product_id: 2, quantity: 10, unit_cost: 20 }] })).status, 400);
  const retained = await request("/deliveries/1", "PUT", { vendor_id: 1, items: [{ product_id: 1, quantity: 20, unit_cost: 99 }, { product_id: 2, quantity: 10, unit_cost: 20 }] });
  assert.equal(retained.status, 200);
  assert.equal(retained.body.data.items.find((item) => item.product_id === 1).unit_cost, 25);
  assert.ok(!(await request("/products?active=all")).body.data.some((product) => product.id === 1));
});

test("archiving remains reversible and distinct from permanent deletion", async (t) => {
  const db = initDb();
  const request = await api(t, db);
  assert.equal((await request("/products/1", "DELETE")).status, 200);
  assert.ok((await request("/products?active=all")).body.data.some((product) => product.id === 1));
  assert.ok(!(await request("/products?active=1")).body.data.some((product) => product.id === 1));
  assert.equal((await request("/products/1/activate", "PATCH", { active: true })).status, 200);
  assert.ok((await request("/products?active=1")).body.data.some((product) => product.id === 1));
});

test("catalog deletion denies inactive accounts and outdated Staff claims after an account becomes Vendor", async (t) => {
  const db = initDb();
  const request = await api(t, db);
  const user = db.users.find((entry) => entry.id === 3);
  user.active = 0;
  assert.equal((await request("/products/1/permanent", "DELETE")).status, 403);
  user.active = 1;
  user.role_id = db.roles.find((role) => role.name === "VENDOR").id;
  assert.equal((await request("/products/1/permanent", "DELETE")).status, 403);
  assert.equal(db.products[0].deleted_at, undefined);
  assert.equal(db.products[0].active, 1);
});

test("report quantity labels use Items and delivery reports use the renamed title", () => {
  const range = { start: "2026-11-01", end: "2026-11-05" };
  const report = buildReportDocument("vendor-deliveries", [], range, { name: "Staff" });
  assert.equal(report.title, "Deliveries Report");
  assert.ok(report.sections[0].columns.some((column) => column.label === "Items"));
  assert.doesNotMatch(JSON.stringify(report), /\bunits?\b/i);
});
