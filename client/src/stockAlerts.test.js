import test from "node:test";
import assert from "node:assert/strict";
import { activeInventoryProducts, normalizeStockFilter, productStockStatus, stockAlertKey } from "./stockAlerts.js";

const products = [
  { id: 1, name: "Water", category: "Drinks", current_stock: 0, active: 1, image_url: "water.jpg" },
  { id: 2, name: "Juice", category: "Drinks", current_stock: "1", active: true },
  { id: 3, name: "Bread", category: "Food", current_stock: 10, active: 1 },
  { id: 4, name: "Chips", category: "Food", current_stock: 11, active: 1 },
  { id: 5, name: "Archived", current_stock: 0, active: 0 },
  { id: 6, name: "Negative stock", current_stock: -2, active: 1 },
];

test("stock statuses match the dashboard boundaries and numeric strings", () => {
  assert.deepEqual(products.map(productStockStatus), ["out-of-stock", "low-stock", "low-stock", "in-stock", "out-of-stock", "out-of-stock"]);
});

test("filtered inventory excludes archived records and retains original product images", () => {
  assert.deepEqual(activeInventoryProducts(products, "low-stock").map((product) => product.id), [2, 3]);
  assert.deepEqual(activeInventoryProducts(products, "out-of-stock").map((product) => product.id), [1, 6]);
  assert.equal(activeInventoryProducts(products, "out-of-stock")[0], products[0]);
  assert.equal(activeInventoryProducts(products, "out-of-stock")[0].image_url, "water.jpg");
});

test("search and stock filters intersect; all inventory restores healthy products", () => {
  assert.deepEqual(activeInventoryProducts(products, "low-stock", " DRINKS ").map((product) => product.id), [2]);
  assert.deepEqual(activeInventoryProducts(products, "out-of-stock", "juice"), []);
  assert.equal(activeInventoryProducts(products).length, 5);
  assert.equal(normalizeStockFilter("unsupported"), "all");
  assert.equal(activeInventoryProducts(products, "unsupported").length, 5);
});

test("notification key is stable across polling order and same-status quantity changes", () => {
  const key = stockAlertKey(products);
  assert.equal(key, stockAlertKey([...products].reverse()));
  assert.equal(key, stockAlertKey(products.map((product) => product.id === 2 ? { ...product, current_stock: 7 } : product)));
  assert.notEqual(key, stockAlertKey(products.map((product) => product.id === 2 ? { ...product, current_stock: 0 } : product)));
  assert.notEqual(key, stockAlertKey([...products, { id: 7, current_stock: 4, active: 1 }]));
  assert.equal(stockAlertKey([{ id: 8, current_stock: 15, active: 1 }, products[4]]), "");
});
