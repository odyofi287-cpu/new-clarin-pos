export const SUPPORTED_ROLES = Object.freeze(["ADMIN", "STAFF", "VENDOR"]);

// The current Admin is the former Superadmin. Legacy ADMIN token claims must
// also be checked against the account's current database role in authMiddleware.
export function normalizeSessionRole(role) {
  return role === "SUPERADMIN" ? "ADMIN" : role;
}

const ENSURE_STAFF_SQL = "INSERT INTO roles (name) VALUES ('STAFF') ON CONFLICT (name) DO NOTHING";
const CONVERT_ADMINS_SQL = `UPDATE users SET role_id = (SELECT id FROM roles WHERE name = 'STAFF')
  WHERE role_id IN (SELECT id FROM roles WHERE name = 'ADMIN')
  AND EXISTS (SELECT 1 FROM roles WHERE name = 'SUPERADMIN') RETURNING id`;
const REMOVE_ADMIN_SQL = `DELETE FROM roles WHERE name = 'ADMIN'
  AND EXISTS (SELECT 1 FROM roles WHERE name = 'SUPERADMIN') RETURNING id`;
const RENAME_SUPERADMIN_SQL = "UPDATE roles SET name = 'ADMIN' WHERE name = 'SUPERADMIN' RETURNING id";

export function migrateAdminRoleInMemory(db) {
  let staffRole = db.roles.find((role) => role.name === "STAFF");
  if (!staffRole) {
    staffRole = { id: Math.max(0, ...db.roles.map((role) => role.id)) + 1, name: "STAFF" };
    db.roles.push(staffRole);
  }
  const superadminRole = db.roles.find((role) => role.name === "SUPERADMIN");
  // Only convert obsolete lower-privilege Admins while SUPERADMIN still exists.
  // On subsequent startups ADMIN is the renamed owner role and must be retained.
  const adminRoleIds = new Set(superadminRole ? db.roles.filter((role) => role.name === "ADMIN").map((role) => role.id) : []);
  let convertedAccounts = 0;
  for (const user of db.users) {
    if (adminRoleIds.has(user.role_id)) {
      user.role_id = staffRole.id;
      convertedAccounts += 1;
    }
  }
  db.roles = db.roles.filter((role) => !adminRoleIds.has(role.id));
  if (superadminRole) superadminRole.name = "ADMIN";
  return { converted_accounts: convertedAccounts, removed_roles: adminRoleIds.size, renamed_roles: superadminRole ? 1 : 0 };
}

export function migrateAdminRoleSqlite(db) {
  return db.transaction(() => {
    db.prepare(ENSURE_STAFF_SQL).run();
    const converted = db.prepare(CONVERT_ADMINS_SQL).all();
    const removed = db.prepare(REMOVE_ADMIN_SQL).all();
    const renamed = db.prepare(RENAME_SUPERADMIN_SQL).all();
    return { converted_accounts: converted.length, removed_roles: removed.length, renamed_roles: renamed.length };
  })();
}

export async function migrateAdminRolePostgres(client) {
  await client.query("BEGIN");
  try {
    // Lock through both the legacy conversion and rename so concurrent startups
    // cannot confuse an obsolete Admin with the new owner-level Admin role.
    await client.query("LOCK TABLE roles, users IN SHARE ROW EXCLUSIVE MODE");
    await client.query(ENSURE_STAFF_SQL);
    const converted = await client.query(CONVERT_ADMINS_SQL);
    const removed = await client.query(REMOVE_ADMIN_SQL);
    const renamed = await client.query(RENAME_SUPERADMIN_SQL);
    await client.query("COMMIT");
    return { converted_accounts: converted.rowCount, removed_roles: removed.rowCount, renamed_roles: renamed.rowCount };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
