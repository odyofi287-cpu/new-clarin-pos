import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { getDailyActivityCounts, getStockAlerts } from "./routes/dashboard.js";

const TODAY = "2026-10-05";
const YESTERDAY = "2026-10-04";

function fixture() {
  return {
    sales: [
      { id: 1, sale_date: TODAY },
      { id: 2, sale_date: TODAY },
      { id: 3, sale_date: YESTERDAY },
    ],
    sale_items: [
      { sale_id: 1, quantity: 3 }, { sale_id: 1, quantity: 2 },
      { sale_id: 2, quantity: 1 }, { sale_id: 3, quantity: 100 },
    ],
    deliveries: [
      { id: 1, delivery_date: TODAY, payment_status: "PAID" },
      { id: 2, delivery_date: TODAY, payment_status: "UNPAID" },
      { id: 3, delivery_date: YESTERDAY, payment_status: "UNPAID" },
    ],
    delivery_items: [
      { delivery_id: 1, quantity: 10 }, { delivery_id: 1, quantity: 4 },
      { delivery_id: 2, quantity: 6 }, { delivery_id: 3, quantity: 100 },
    ],
    vendor_returns: [
      { id: 1, return_date: TODAY, return_batch_id: "bulk-return", quantity: 2 },
      { id: 2, return_date: TODAY, return_batch_id: "bulk-return", quantity: 1 },
      { id: 3, return_date: TODAY, return_batch_id: null, quantity: 1 },
      { id: 4, return_date: YESTERDAY, return_batch_id: "old-return", quantity: 100 },
    ],
  };
}

function sqliteFixture(rows) {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sales (id INTEGER, sale_date TEXT);
    CREATE TABLE sale_items (sale_id INTEGER, quantity REAL);
    CREATE TABLE deliveries (id INTEGER, delivery_date TEXT, payment_status TEXT);
    CREATE TABLE delivery_items (delivery_id INTEGER, quantity REAL);
    CREATE TABLE vendor_returns (id INTEGER, return_date TEXT, return_batch_id TEXT, quantity REAL);
    CREATE TABLE products (id INTEGER, name TEXT, category TEXT, image_url TEXT,
      current_stock INTEGER, minimum_stock INTEGER, unit TEXT, active INTEGER);
  `);
  for (const [table, entries] of Object.entries(rows)) {
    for (const entry of entries) {
      const columns = Object.keys(entry);
      db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
        .run(...Object.values(entry));
    }
  }
  return db;
}

for (const backend of ["in-memory", "SQLite"]) {
  test(`${backend}: dashboard counts bulk sales, pickups and returns once, and subtracts returned units`, async () => {
    const rows = fixture();
    const db = backend === "SQLite" ? sqliteFixture(rows) : rows;
    try {
      // Two sales + two deliveries + one bulk return + one legacy return.
      // Six sale units + twenty delivered units - four returned units.
      assert.deepEqual(await getDailyActivityCounts(db, TODAY), {
        todays_transaction_count: 6,
        items_sold_today: 22,
      });
      assert.deepEqual(await getDailyActivityCounts(db, "2026-10-06"), {
        todays_transaction_count: 0,
        items_sold_today: 0,
      });
      assert.deepEqual(await getDailyActivityCounts(db, YESTERDAY), {
        todays_transaction_count: 3,
        items_sold_today: 100,
      });
    } finally {
      if (backend === "SQLite") db.close();
    }
  });
}

test("Dashboard counters accept numeric strings and Manila business-date objects", async () => {
  const rows = fixture();
  for (const table of ["sales", "deliveries", "vendor_returns"]) {
    const dateField = { sales: "sale_date", deliveries: "delivery_date", vendor_returns: "return_date" }[table];
    for (const row of rows[table]) {
      row[dateField] = new Date(`${row[dateField]}T00:00:00+08:00`);
    }
  }
  for (const table of ["sale_items", "delivery_items", "vendor_returns"]) {
    rows[table].forEach((row) => { row.quantity = String(row.quantity); });
  }
  assert.deepEqual(await getDailyActivityCounts(rows, TODAY), {
    todays_transaction_count: 6,
    items_sold_today: 22,
  });
});

test("PostgreSQL counter results are returned as numbers", async () => {
  const db = {
    pool: {},
    client: () => ({
      query: async (sql, params) => {
        assert.match(sql, /COUNT\(DISTINCT/);
        assert.deepEqual(params, Array(6).fill(TODAY));
        return { rows: [{ transaction_count: "6", items_sold: "22" }] };
      },
    }),
  };
  assert.deepEqual(await getDailyActivityCounts(db, TODAY), {
    todays_transaction_count: 6,
    items_sold_today: 22,
  });
});

for (const backend of ["in-memory", "SQLite"]) {
  test(`${backend}: stock alerts include zero stock, retain images and count all low-stock products`, async () => {
    const product = (id, name, current_stock, active = 1) => ({
      id, name, current_stock, active, category: "Drinks", image_url: `/products/${id}.png`,
      minimum_stock: 10, unit: "bottles",
    });
    const rows = {
      sales: [], sale_items: [],
      products: [
        product(1, "Sold out", 0), product(2, "Negative balance", -1),
        product(3, "Low boundary", 10), product(4, "Healthy stock", 11),
        product(5, "Archived product", 0, 0), product(6, "Low stock", 3),
        ...Array.from({ length: 11 }, (_, index) => product(index + 7, `Low product ${index}`, 5)),
      ],
    };
    const db = backend === "SQLite" ? sqliteFixture(rows) : rows;
    try {
      const summary = await getStockAlerts(db);
      assert.equal(summary.out_of_stock_count, 2);
      assert.equal(summary.low_stock_count, 13, "Counts and alerts must not stop at ten products");
      assert.equal(summary.stock_alert_products.length, 15);
      assert.deepEqual(summary.stock_alert_products.slice(0, 2).map((row) => row.id), [2, 1]);
      assert(summary.out_of_stock_products.every((row) => row.status === "OUT_OF_STOCK"));
      assert(summary.low_stock_products.every((row) => row.status === "LOW_STOCK"));
      assert(!summary.stock_alert_products.some((row) => row.id === 4 || row.id === 5));
      assert.equal(summary.out_of_stock_products.find((row) => row.id === 1).image_url, "/products/1.png");
      if (backend === "SQLite") db.prepare("UPDATE products SET current_stock = 12 WHERE id = 1").run();
      else rows.products[0].current_stock = 12;
      assert.equal((await getStockAlerts(db)).out_of_stock_count, 1);
    } finally { if (backend === "SQLite") db.close(); }
  });
}
