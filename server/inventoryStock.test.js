import test from "node:test";
import assert from "node:assert/strict";
import express from "express";

// Select the isolated in-memory backend before importing any database module.
// These tests never initialize SQLite or connect to PostgreSQL.
process.env.NODE_ENV = "test";
const { initDb } = await import("./db.js");
const { getBusinessDate } = await import("./businessDate.js");
const { default: productsRouter } = await import("./routes/products.js");
const { default: reportsRouter } = await import("./routes/reports.js");
const { inventoryReport } = await import("./reportData.js");
const { buildReportDocument, reportCsv } = await import("./reportDocument.js");

const STAFF = 3;
const OTHER_STAFF = 2;
const productInput = {
  name: "Stock Test Cola", category: "Drinks", unit: "item",
  volume_ml: 330, quantity_per_case: 24, base_price: 20, markup_price: 5,
  minimum_stock: 0, initial_stock: 12, image_url: "data:image/png;base64,photo",
};

async function fixture(t) {
  const db = initDb();
  for (const table of ["products", "deliveries", "delivery_items", "sales", "sale_items", "vendor_returns", "inventory_movements"]) db[table] = [];
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.db = db;
    req.user = { role: req.headers["x-test-role"] || "STAFF", user_id: Number(req.headers["x-test-user"] || STAFF) };
    next();
  });
  app.use("/products", productsRouter);
  app.use("/reports", reportsRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, method = "GET", body, userId = STAFF, role = "STAFF") => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { "content-type": "application/json", "x-test-user": String(userId), "x-test-role": role },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const create = (overrides = {}, userId = STAFF) => request("/products", "POST", { ...productInput, ...overrides }, userId);
  const edit = (id, stock, overrides = {}) => request(`/products/${id}`, "PUT", { ...productInput, ...overrides, current_stock: stock });
  const movement = (id, body, userId = STAFF) => request(`/products/${id}/stock-movements`, "POST", body, userId);
  const report = (userId = STAFF, role = "STAFF") => {
    const today = getBusinessDate();
    return request(`/reports/inventory?start_date=${today}&end_date=${today}`, "GET", undefined, userId, role);
  };
  return { db, request, create, edit, movement, report };
}

function assertMovement(row, type, quantity, userId = STAFF) {
  assert.equal(row.movement_type, type);
  assert.equal(row.quantity, quantity);
  assert.equal(row.user_id, userId, "The movement must retain the signed-in account for Staff reports");
  assert.equal(getBusinessDate(new Date(row.created_at)), getBusinessDate());
}

test("initial stock is recorded as Stock in and appears in the creator's daily report", async (t) => {
  const { db, create, report } = await fixture(t);
  const result = await create({ initial_stock: 12 });
  assert.equal(result.status, 201);
  assert.equal(result.body.data.current_stock, 12);
  assert.equal(db.inventory_movements.length, 1);
  assertMovement(db.inventory_movements[0], "STOCK_IN", 12);
  const daily = await report();
  assert.equal(daily.status, 200);
  assert.equal(daily.body.data.length, 1);
  assert.equal(daily.body.data[0].stock_in, 12);
  assert.equal(daily.body.data[0].stock_out, 0);
  assert.equal(daily.body.data[0].current_stock, 12);
  assert.equal((await report(OTHER_STAFF)).body.data.length, 0);
});

test("editing quantity records only the difference; unchanged stock creates no duplicate movement", async (t) => {
  const { db, create, edit, report } = await fixture(t);
  const created = await create({ initial_stock: 12 });
  const id = created.body.data.id;
  const increase = await edit(id, 19);
  assert.equal(increase.status, 200);
  assert.equal(increase.body.data.current_stock, 19);
  assert.equal(db.inventory_movements.length, 2);
  assertMovement(db.inventory_movements.at(-1), "STOCK_IN", 7);
  const unchanged = await edit(id, 19, { category: "Updated category" });
  assert.equal(unchanged.status, 200);
  assert.equal(db.inventory_movements.length, 2, "Metadata edits and unchanged quantities must not inflate Stock in");
  assert.equal((await edit(id, 15)).status, 200);
  assert.equal(db.inventory_movements.length, 3);
  assertMovement(db.inventory_movements.at(-1), "STOCK_OUT", 4);
  const daily = await report();
  assert.equal(daily.status, 200);
  assert.equal(daily.body.data[0].stock_in, 19);
  assert.equal(daily.body.data[0].stock_out, 4);
  assert.equal(daily.body.data[0].current_stock, 15);
});

test("positive adjustments and explicit Stock in reconcile with the daily preview and CSV", async (t) => {
  const { db, create, movement, report } = await fixture(t);
  const id = (await create({ initial_stock: 0 })).body.data.id;
  assert.equal(db.inventory_movements.length, 0);
  assert.equal((await movement(id, { type: "ADJUSTMENT", delta: 5 })).status, 200);
  assertMovement(db.inventory_movements.at(-1), "STOCK_IN", 5);
  assert.equal((await movement(id, { type: "STOCK_IN", quantity: 4 })).status, 200);
  assertMovement(db.inventory_movements.at(-1), "STOCK_IN", 4);
  assert.equal((await movement(id, { type: "ADJUSTMENT", delta: -2 })).status, 200);
  assertMovement(db.inventory_movements.at(-1), "STOCK_OUT", 2);
  assert.equal(db.products[0].current_stock, 7);
  const daily = await report();
  assert.equal(daily.status, 200);
  assert.deepEqual(daily.body.data.map((row) => [row.product, row.stock_in, row.stock_out, row.current_stock, row.stock_status]), [[productInput.name, 9, 2, 7, "LOW_STOCK"]]);
  const inSummary = daily.body.report.summary.find((metric) => metric.label === "Stock-in items");
  assert.equal(inSummary.value, 9);
  const today = getBusinessDate();
  const rows = await inventoryReport(db, today, today, { role: "STAFF", user_id: STAFF });
  const csv = reportCsv(buildReportDocument("inventory", rows, { start: today, end: today }, { role: "STAFF", name: "POS Staff" }));
  assert.match(csv, /Stock-in items,9/);
  assert.match(csv, /Stock-out items,2/);
  assert.match(csv, /Stock Test Cola,9,2,7,0,LOW STOCK/);
});

test("Stock in is attributed to each Staff account while Admin sees all movements", async (t) => {
  const { create, movement, report } = await fixture(t);
  const id = (await create({ initial_stock: 3 })).body.data.id;
  assert.equal((await movement(id, { type: "ADJUSTMENT", delta: 7 }, OTHER_STAFF)).status, 200);
  const otherOnly = await create({ name: "Other Staff Product", initial_stock: 2 }, OTHER_STAFF);
  assert.equal(otherOnly.status, 201);
  const mine = await report();
  assert.equal(mine.status, 200);
  assert.equal(mine.body.data.length, 1);
  assert.equal(mine.body.data[0].stock_in, 3);
  assert.equal(mine.body.data[0].current_stock, 10, "Live stock remains shared; only movement totals are account-scoped");
  const theirs = await report(OTHER_STAFF);
  assert.equal(theirs.status, 200);
  assert.equal(theirs.body.data.find((row) => row.product === productInput.name).stock_in, 7);
  assert.equal(theirs.body.data.find((row) => row.product === "Other Staff Product").stock_in, 2);
  const all = await report(1, "ADMIN");
  assert.equal(all.status, 200);
  assert.equal(all.body.data.find((row) => row.product === productInput.name).stock_in, 10);
  assert.equal(all.body.report.summary.find((metric) => metric.label === "Stock-in items").value, 12);
});

test("invalid zero or fractional adjustments cannot change stock or create movement rows", async (t) => {
  const { db, create, movement } = await fixture(t);
  const id = (await create({ initial_stock: 4 })).body.data.id;
  for (const input of [{ type: "ADJUSTMENT", delta: 0 }, { type: "ADJUSTMENT", delta: 0.5 }, { type: "ADJUSTMENT", delta: -0.5 }, { type: "STOCK_IN", quantity: 0 }, { type: "STOCK_IN", quantity: 1.5 }]) {
    const before = JSON.stringify(db);
    const result = await movement(id, input);
    assert.equal(result.status, 400, JSON.stringify(input));
    assert.equal(JSON.stringify(db), before, "Rejected input must leave the inventory unchanged");
  }
});

for (const operation of ["edit", "adjustment"]) {
  test(`${operation}: failure to write the movement rolls back stock and metadata`, async (t) => {
    const { db, create, edit, movement } = await fixture(t);
    const id = (await create({ initial_stock: 4 })).body.data.id;
    const before = JSON.stringify(db);
    const originalPrepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      if (/^\s*INSERT\s+INTO\s+inventory_movements\b/i.test(sql)) throw new Error("Simulated movement write failure");
      return originalPrepare(sql);
    };
    try {
      const result = operation === "edit"
        ? await edit(id, 9, { name: "Must roll back", category: "Must roll back" })
        : await movement(id, { type: "ADJUSTMENT", delta: 5 });
      assert.equal(result.status, 500);
      assert.equal(JSON.stringify(db), before, "No unreported stock increment may survive a failed movement insert");
    } finally {
      delete db.prepare;
    }
  });
}
