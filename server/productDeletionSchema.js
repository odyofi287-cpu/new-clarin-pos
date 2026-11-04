import { isInMemoryDb, isPostgresDb } from "./routes/dbCompat.js";

// Additive and idempotent: existing product IDs, stock and history are untouched.
export function ensureProductDeletionSchema(db) {
  if (isInMemoryDb(db)) return;
  if (isPostgresDb(db)) return db.client().query("ALTER TABLE products ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ");
  const columns = db.prepare("PRAGMA table_info(products)").all();
  if (!columns.some((column) => column.name === "deleted_at")) db.exec("ALTER TABLE products ADD COLUMN deleted_at TEXT");
}
