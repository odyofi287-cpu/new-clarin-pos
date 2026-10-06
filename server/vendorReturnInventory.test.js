import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import Database from "better-sqlite3";

process.env.NODE_ENV = "test";
const { initDb } = await import("./db.js");
const { getBusinessDate } = await import("./businessDate.js");
const { default: returnRoutes } = await import("./routes/vendorReturns.js");
const { default: deliveryRoutes } = await import("./routes/deliveries.js");
const { restockVendorReturn, reverseVendorReturnStock } = await import("./routes/returnInventory.js");

async function fixture(t) {
  const db = initDb();
  db.products.forEach((product) => { product.current_stock = 5; });
  db.deliveries = [{
    id: 1, vendor_id: 1, delivery_date: getBusinessDate(), delivery_time: "09:00",
    payment_status: "UNPAID", total_amount: 190, created_at: new Date().toISOString(),
  }];
  db.delivery_items = [
    { id: 1, delivery_id: 1, product_id: 1, quantity: 4, unit_cost: 35 },
    { id: 2, delivery_id: 1, product_id: 2, quantity: 2, unit_cost: 25 },
  ];
  db.vendor_returns = [];
  db.inventory_movements = [];
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.db = db;
    req.user = { role: "SUPERADMIN", user_id: 3 };
    next();
  });
  app.use("/returns", returnRoutes);
  app.use("/deliveries", deliveryRoutes);
  const server = app.listen(0);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (url, method = "GET", body) => {
    const response = await fetch(`${base}${url}`, {
      method, headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const record = (items = [{ product_id: 1, quantity: 2 }, { product_id: 2, quantity: 1 }]) => request("/returns", "POST", {
    vendor_id: 1, delivery_id: 1, return_date: getBusinessDate(), return_time: "10:00", items,
  });
  const stocks = () => db.products.map((product) => product.current_stock);
  return { db, request, record, stocks };
}

test("Bulk returns restock each product; single and bulk removal reverse only their own units", async (t) => {
  const { db, record, request, stocks } = await fixture(t);
  const created = await record();
  assert.equal(created.status, 201);
  assert.deepEqual(stocks(), [7, 6]);
  assert.deepEqual(db.inventory_movements.map((movement) => [movement.reference_type, movement.quantity]),
    [["VENDOR_RETURN", 2], ["VENDOR_RETURN", 1]]);
  const firstId = created.body.data.items[0].id;
  assert.equal((await request(`/returns/${firstId}`, "DELETE")).status, 200);
  assert.deepEqual(stocks(), [5, 6]);
  assert.equal(db.vendor_returns.length, 1);
  assert.equal((await request(`/returns/${firstId}`, "DELETE")).status, 404);
  assert.deepEqual(stocks(), [5, 6]);
  assert.equal((await request(`/returns/batch/${created.body.data.return_batch_id}`, "DELETE")).status, 200);
  assert.deepEqual(stocks(), [5, 5]);
  assert.equal(db.vendor_returns.length, 0);
  assert.equal(db.inventory_movements.filter((movement) => movement.reference_type === "VENDOR_RETURN_REMOVAL").length, 2);
  // Return IDs must not reuse the old stock movement reference after deletion.
  const next = await record([{ product_id: 1, quantity: 1 }]);
  assert(next.body.data.return_id > firstId);
  assert.equal((await request(`/returns/${next.body.data.return_id}`, "DELETE")).status, 200);
  assert.deepEqual(stocks(), [5, 5]);
});

test("A failed bulk restock rolls back return records, stock and movement history", async (t) => {
  const { db, record, stocks } = await fixture(t);
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const statement = prepare(sql);
    if (sql.startsWith("INSERT INTO inventory_movements")) {
      const run = statement.run.bind(statement);
      statement.run = (...params) => {
        if (params[0] === 2) throw new Error("Simulated inventory movement failure");
        return run(...params);
      };
    }
    return statement;
  };
  assert.equal((await record()).status, 400);
  assert.deepEqual(stocks(), [5, 5]);
  assert.equal(db.vendor_returns.length, 0);
  assert.equal(db.inventory_movements.length, 0);
});

test("Removing a batch cannot make stock negative or partially reverse the batch", async (t) => {
  const { db, record, request, stocks } = await fixture(t);
  const created = await record();
  assert.equal(created.status, 201);
  db.products[1].current_stock = 0;
  const removed = await request(`/returns/batch/${created.body.data.return_batch_id}`, "DELETE");
  assert.equal(removed.status, 400);
  assert.match(removed.body.error, /needs 1 units in stock/);
  assert.deepEqual(stocks(), [7, 0]);
  assert.equal(db.vendor_returns.length, 2);
  assert.equal(db.inventory_movements.length, 2);
});

test("Removing an old return without a restock movement leaves stock unchanged", async (t) => {
  const { db, request, stocks } = await fixture(t);
  db.vendor_returns.push({ id: 99, vendor_id: 1, product_id: 1, quantity: 2 });
  assert.equal((await request("/returns/99", "DELETE")).status, 200);
  assert.deepEqual(stocks(), [5, 5]);
  assert.equal(db.inventory_movements.length, 0);
});

test("Delivery changes cannot double-restock returns or reduce quantities below returned units", async (t) => {
  const { record, request, stocks } = await fixture(t);
  const created = await record();
  assert.equal(created.status, 201);
  assert.equal((await request("/deliveries/1", "DELETE")).status, 400);
  assert.deepEqual(stocks(), [7, 6]);
  const edit = await request("/deliveries/1", "PUT", {
    vendor_id: 1, items: [{ product_id: 1, quantity: 1 }, { product_id: 2, quantity: 2 }],
  });
  assert.equal(edit.status, 400);
  assert.match(edit.body.error, /already has 2 returned units/);
  assert.deepEqual(stocks(), [7, 6]);
  const paymentEdit = await request("/deliveries/1", "PUT", {
    vendor_id: 1, payment_status: "PAID",
    items: [{ product_id: 1, quantity: 4 }, { product_id: 2, quantity: 2 }],
  });
  assert.equal(paymentEdit.status, 200);
  assert.deepEqual(stocks(), [7, 6]);
  assert.equal((await request(`/returns/batch/${created.body.data.return_batch_id}`, "DELETE")).status, 200);
  assert.equal((await request("/deliveries/1", "DELETE")).status, 200);
  assert.deepEqual(stocks(), [9, 7]);
});

test("Return stock SQL adds and reverses quantities with an audit trail", async () => {
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE products (id INTEGER PRIMARY KEY, current_stock INTEGER);
      CREATE TABLE inventory_movements (id INTEGER PRIMARY KEY, product_id INTEGER,
        movement_type TEXT, quantity INTEGER, reference_type TEXT, reference_id INTEGER,
        user_id INTEGER, created_at TEXT);
      INSERT INTO products VALUES (1, 5);`);
    const entry = { id: 10, product_id: 1, quantity: 2 };
    await restockVendorReturn(db, entry, 3);
    assert.equal(db.prepare("SELECT current_stock FROM products").get().current_stock, 7);
    await reverseVendorReturnStock(db, entry, 3);
    assert.equal(db.prepare("SELECT current_stock FROM products").get().current_stock, 5);
    await reverseVendorReturnStock(db, { id: 9, product_id: 1, quantity: 100 }, 3);
    assert.equal(db.prepare("SELECT current_stock FROM products").get().current_stock, 5);
    assert.deepEqual(db.prepare("SELECT movement_type, quantity, reference_type FROM inventory_movements ORDER BY id").all(), [
      { movement_type: "STOCK_IN", quantity: 2, reference_type: "VENDOR_RETURN" },
      { movement_type: "STOCK_OUT", quantity: 2, reference_type: "VENDOR_RETURN_REMOVAL" },
    ]);
  } finally {
    db.close();
  }
});
