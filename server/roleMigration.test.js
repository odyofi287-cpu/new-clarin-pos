import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { SUPPORTED_ROLES, migrateAdminRoleInMemory, migrateAdminRoleSqlite, migrateAdminRolePostgres } from "./roleMigration.js";

function fixture() {
  const db = new Database(":memory:");
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE roles (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
    CREATE TABLE users (id INTEGER PRIMARY KEY, role_id INTEGER REFERENCES roles(id),
      username TEXT, password TEXT, active INTEGER, profile_picture TEXT);
    CREATE TABLE sales (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), total_amount INTEGER);
    INSERT INTO roles VALUES (1, 'SUPERADMIN'), (2, 'ADMIN'), (3, 'STAFF'), (4, 'VENDOR');
    INSERT INTO users VALUES (1, 1, 'owner', 'owner-password', 1, 'owner-picture'),
      (2, 2, 'former-admin', 'unchanged-password', 1, 'admin-picture'),
      (3, 3, 'staff', 'staff-password', 1, NULL),
      (4, 4, 'vendor', 'vendor-password', 1, NULL),
      (5, 2, 'inactive-admin', 'inactive-password', 0, NULL);
    INSERT INTO sales VALUES (1, 2, 100), (2, 5, 50);`);
  return db;
}

test("SQLite conversion preserves active/inactive accounts, profiles and sales and can run repeatedly", () => {
  const db = fixture();
  try {
    const before = db.prepare("SELECT * FROM users ORDER BY id").all();
    const salesBefore = db.prepare("SELECT * FROM sales ORDER BY id").all();
    assert.deepEqual(migrateAdminRoleSqlite(db), { converted_accounts: 2, removed_roles: 1, renamed_roles: 1 });
    assert.deepEqual(db.prepare("SELECT * FROM users ORDER BY id").all(),
      before.map((user) => ({ ...user, role_id: user.role_id === 2 ? 3 : user.role_id })));
    assert.deepEqual(db.prepare("SELECT * FROM sales ORDER BY id").all(), salesBefore);
    assert.deepEqual(db.prepare("SELECT name FROM roles ORDER BY id").all().map((role) => role.name), SUPPORTED_ROLES);
    assert.deepEqual(migrateAdminRoleSqlite(db), { converted_accounts: 0, removed_roles: 0, renamed_roles: 0 });
  } finally { db.close(); }
});

test("Postgres migration locks roles and accounts and executes the conversion atomically", async () => {
  const db = fixture();
  const calls = [];
  const client = { query: async (sql) => {
    calls.push(sql);
    if (sql.startsWith("LOCK TABLE")) return {};
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) { db.exec(sql); return {}; }
    if (sql.includes("RETURNING")) {
      const rows = db.prepare(sql).all();
      return { rows, rowCount: rows.length };
    }
    const result = db.prepare(sql).run();
    return { rowCount: result.changes };
  } };
  try {
    assert.deepEqual(await migrateAdminRolePostgres(client), { converted_accounts: 2, removed_roles: 1, renamed_roles: 1 });
    assert.equal(calls[0], "BEGIN");
    assert.match(calls[1], /LOCK TABLE roles, users/);
    assert.equal(calls.at(-1), "COMMIT");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM users WHERE role_id = 3").get().count, 3);
    assert.equal(db.prepare("SELECT name FROM roles WHERE id = 1").get().name, "ADMIN");
    assert.deepEqual(await migrateAdminRolePostgres(client), { converted_accounts: 0, removed_roles: 0, renamed_roles: 0 });
  } finally { db.close(); }
});

test("A migration failure rolls back the account conversion and role removal", async () => {
  const db = fixture();
  const client = { query: async (sql) => {
    if (sql.startsWith("LOCK TABLE")) return {};
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) { db.exec(sql); return {}; }
    if (sql.startsWith("DELETE FROM roles")) throw new Error("Simulated migration failure");
    if (sql.includes("RETURNING")) { const rows = db.prepare(sql).all(); return { rowCount: rows.length }; }
    return { rowCount: db.prepare(sql).run().changes };
  } };
  try {
    const before = db.prepare("SELECT * FROM users ORDER BY id").all();
    await assert.rejects(migrateAdminRolePostgres(client), /Simulated migration failure/);
    assert.deepEqual(db.prepare("SELECT * FROM users ORDER BY id").all(), before);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM roles WHERE name = 'ADMIN'").get().count, 1);
  } finally { db.close(); }
});

test("Conversion retains former Admins as Staff and renames the owner role in memory", () => {
  const db = {
    roles: [{ id: 1, name: "SUPERADMIN" }, { id: 7, name: "ADMIN" }],
    users: [{ id: 2, role_id: 7, username: "old-admin", active: 0 }],
  };
  assert.deepEqual(migrateAdminRoleInMemory(db), { converted_accounts: 1, removed_roles: 1, renamed_roles: 1 });
  const staffRole = db.roles.find((role) => role.name === "STAFF");
  assert.equal(db.users[0].role_id, staffRole.id);
  assert.equal(db.users[0].active, 0);
  assert.deepEqual(db.roles.find((role) => role.id === 1), { id: 1, name: "ADMIN" });
  assert.deepEqual(migrateAdminRoleInMemory(db), { converted_accounts: 0, removed_roles: 0, renamed_roles: 0 });
});

test("Already-renamed Admin accounts are never downgraded on SQLite or memory startup", () => {
  const db = fixture();
  try {
    migrateAdminRoleSqlite(db);
    const before = db.prepare("SELECT * FROM users ORDER BY id").all();
    assert.deepEqual(migrateAdminRoleSqlite(db), { converted_accounts: 0, removed_roles: 0, renamed_roles: 0 });
    assert.deepEqual(db.prepare("SELECT * FROM users ORDER BY id").all(), before);
    assert.equal(db.prepare("SELECT name FROM roles WHERE id = 1").get().name, "ADMIN");
    const memory = { roles: [{ id: 1, name: "ADMIN" }, { id: 3, name: "STAFF" }], users: [{ id: 1, role_id: 1 }] };
    migrateAdminRoleInMemory(memory);
    assert.equal(memory.users[0].role_id, 1);
    assert.equal(memory.roles[0].name, "ADMIN");
  } finally { db.close(); }
});

test("Owner role rename keeps its ID, credentials, profiles and sales foreign keys", () => {
  const db = fixture();
  try {
    db.prepare("INSERT INTO sales VALUES (3, 1, 250)").run();
    const owner = db.prepare("SELECT * FROM users WHERE id = 1").get();
    migrateAdminRoleSqlite(db);
    assert.deepEqual(db.prepare("SELECT * FROM users WHERE id = 1").get(), owner);
    assert.deepEqual(db.prepare("SELECT * FROM sales WHERE id = 3").get(), { id: 3, user_id: 1, total_amount: 250 });
    assert.equal(db.prepare("SELECT name FROM roles WHERE id = ?").get(owner.role_id).name, "ADMIN");
  } finally { db.close(); }
});
