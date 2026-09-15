import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const pool = new pg.Pool({
  connectionString: databaseUrl,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
});

try {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM sale_items");
    await client.query("DELETE FROM sales");
    await client.query("DELETE FROM delivery_items");
    await client.query("DELETE FROM deliveries");
    await client.query("DELETE FROM vendor_returns");
    await client.query("DELETE FROM inventory_movements");
    await client.query("COMMIT");
    const counts = {};
    for (const table of ["users", "vendors", "products", "sales", "sale_items", "deliveries", "delivery_items", "vendor_returns", "inventory_movements"]) {
      counts[table] = (await client.query(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows[0].count;
    }
    console.log(JSON.stringify({ message: "Supabase transactional data cleared", counts }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
