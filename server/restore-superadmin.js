import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import bcrypt from "bcrypt";
import pg from "pg";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const pool = new pg.Pool({
  connectionString: databaseUrl,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
});

try {
  await pool.query(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
  const role = await pool.query(
    "INSERT INTO roles (name) VALUES ('SUPERADMIN') ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id"
  );
  const passwordHash = await bcrypt.hash("Superadmin123!", 10);
  const result = await pool.query(
    `INSERT INTO users (username, email, password, name, role_id, active)
     VALUES ($1, $2, $3, $4, $5, 1)
     ON CONFLICT (email) DO NOTHING
     RETURNING id, email`,
    ["superadmin", "superadmin@clarin.local", passwordHash, "System Owner", role.rows[0].id]
  );

  if (result.rowCount === 0) {
    console.log("Superadmin already exists; no account was changed.");
  } else {
    console.log("Superadmin restored: superadmin@clarin.local");
  }
} finally {
  await pool.end();
}
