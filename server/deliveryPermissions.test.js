import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { requireCurrentStaff } from "./middleware/auth.js";

test("delivery mutation guard requires a currently active Staff account, not a cached token role", async () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE roles (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE users (id INTEGER PRIMARY KEY, role_id INTEGER, active INTEGER, vendor_id INTEGER);
    INSERT INTO roles VALUES (1, 'ADMIN'), (2, 'STAFF'), (3, 'VENDOR');
    INSERT INTO users VALUES (1, 1, 1, NULL), (2, 2, 1, NULL), (3, 3, 1, 1), (4, 2, 0, NULL);`);
  try {
    for (const [userId, tokenRole, expected] of [[1, "ADMIN", 403], [1, "STAFF", 403], [2, "STAFF", 200], [3, "STAFF", 403], [4, "STAFF", 403], [999, "STAFF", 403]]) {
      let status = 200;
      let allowed = false;
      const response = { status(value) { status = value; return this; }, json() { return this; } };
      await requireCurrentStaff({ user: { user_id: userId, role: tokenRole }, db }, response, (error) => {
        assert.ifError(error);
        allowed = true;
      });
      assert.equal(status, expected);
      assert.equal(allowed, expected === 200);
    }
  } finally { db.close(); }
});

test("delivery mutation guard fails closed when account lookup fails", async () => {
  let failure;
  let allowed = false;
  await requireCurrentStaff({ user: { role: "STAFF", user_id: 2 }, db: { prepare() { throw new Error("database unavailable"); } } }, {}, (error) => {
    failure = error;
    allowed = !error;
  });
  assert.equal(allowed, false);
  assert.match(failure.message, /database unavailable/);
});
