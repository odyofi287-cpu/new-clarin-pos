import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import pg from "pg";
import { migrateAdminRolePostgres } from "./roleMigration.js";

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), ".env") });
const mode = process.argv[2];
if (!["--check", "--apply"].includes(mode)) {
  throw new Error("Usage: node migrate-superadmin-to-admin.js --check|--apply");
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
  connectionTimeoutMillis: 15000,
});
try {
  const client = await pool.connect();
  try {
    const summarySql = `SELECT r.name AS role, COUNT(u.id)::int AS account_count
      FROM roles r LEFT JOIN users u ON u.role_id = r.id GROUP BY r.id, r.name ORDER BY r.name`;
    const before = (await client.query(summarySql)).rows;
    console.log(JSON.stringify({ before }));
    if (mode === "--apply") {
      const migration = await migrateAdminRolePostgres(client);
      const after = (await client.query(summarySql)).rows;
      const remaining = await client.query(`SELECT COUNT(*)::int AS count FROM users u
        JOIN roles r ON r.id = u.role_id WHERE r.name = 'SUPERADMIN'`);
      if (remaining.rows[0].count !== 0 || after.some((role) => role.role === "SUPERADMIN")) {
        throw new Error("Admin role rename verification failed");
      }
      console.log(JSON.stringify({ migration, after, verified: true }));
    }
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
