import { dbRun, isInMemoryDb, isPostgresDb } from "./routes/dbCompat.js";

// Capture once, never revalue old missing-cost lines using later catalog edits.
// Transaction prices, quantities, payments and stock are not changed.
export function captureLegacyProfitCost(db, productId = null) {
  if (isInMemoryDb(db)) {
    for (const product of db.products) {
      if (productId != null && Number(product.id) !== Number(productId)) continue;
      const price = product.base_price == null ? NaN : Number(product.base_price);
      if (product.legacy_base_price == null && Number.isFinite(price) && price >= 0 && price <= 1_000_000_000) {
        product.legacy_base_price = price;
        product.legacy_base_price_set_at = new Date().toISOString();
      }
    }
    return;
  }
  return dbRun(db, `UPDATE products SET legacy_base_price = base_price, legacy_base_price_set_at = CURRENT_TIMESTAMP
    WHERE legacy_base_price IS NULL AND base_price BETWEEN 0 AND 1000000000${productId == null ? "" : " AND id = $1"}`,
    productId == null ? [] : [Number(productId)]);
}

export function ensureLegacyProfitCostSchema(db) {
  if (isInMemoryDb(db)) return captureLegacyProfitCost(db);
  if (isPostgresDb(db)) return (async () => {
    await db.client().query("ALTER TABLE products ADD COLUMN IF NOT EXISTS legacy_base_price NUMERIC");
    await db.client().query("ALTER TABLE products ADD COLUMN IF NOT EXISTS legacy_base_price_set_at TIMESTAMPTZ");
    await captureLegacyProfitCost(db);
  })();
  const columns = db.prepare("PRAGMA table_info(products)").all();
  if (!columns.some((column) => column.name === "legacy_base_price")) db.exec("ALTER TABLE products ADD COLUMN legacy_base_price NUMERIC");
  if (!columns.some((column) => column.name === "legacy_base_price_set_at")) db.exec("ALTER TABLE products ADD COLUMN legacy_base_price_set_at TEXT");
  // Keep initialization synchronous for better-sqlite3, including error handling.
  db.prepare("UPDATE products SET legacy_base_price = base_price, legacy_base_price_set_at = CURRENT_TIMESTAMP WHERE legacy_base_price IS NULL AND base_price BETWEEN 0 AND 1000000000").run();
}
