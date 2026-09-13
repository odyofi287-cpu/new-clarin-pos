import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sqliteFile = process.argv[2] || path.join(__dirname, "data", "pos.db");
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) throw new Error("DATABASE_URL is required. Set it in server/.env or the current PowerShell session.");
try {
  const parsedUrl = new URL(databaseUrl);
  if (!/^postgres(ql)?$/.test(parsedUrl.protocol.replace(":", "")) || !parsedUrl.hostname) {
    throw new Error();
  }
} catch {
  throw new Error("DATABASE_URL must be a full PostgreSQL URL like postgresql://postgres.PROJECT_REF:PASSWORD@POOLER_HOST:5432/postgres");
}
if (!fs.existsSync(sqliteFile)) throw new Error(`SQLite database not found: ${sqliteFile}`);

const sqlite = new Database(sqliteFile, { readonly: true });
const pool = new pg.Pool({ connectionString: databaseUrl, ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined });
const tables = ["roles", "vendors", "users", "products", "deliveries", "delivery_items", "inventory_movements", "sales", "sale_items", "vendor_returns"];

try {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
    for (const table of tables) {
      const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
      if (!rows.length) continue;
      const columns = Object.keys(rows[0]);
      const quoted = columns.map((column) => `"${column}"`).join(", ");
      const values = columns.map((_, index) => `$${index + 1}`).join(", ");
      for (const row of rows) await client.query(`INSERT INTO ${table} (${quoted}) VALUES (${values}) ON CONFLICT DO NOTHING`, columns.map((column) => row[column]));
      await client.query(
        `SELECT setval(pg_get_serial_sequence($1, 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1), true)`,
        [`public.${table}`]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
} finally {
  sqlite.close();
  await pool.end();
}