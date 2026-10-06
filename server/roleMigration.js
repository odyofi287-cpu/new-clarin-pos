export const SUPPORTED_ROLES = Object.freeze(["SUPERADMIN", "STAFF", "VENDOR"]);

// Compatibility for sessions issued before the Admin role was retired.
export function normalizeSessionRole(role) {
  return role === "ADMIN" ? "STAFF" : role;
}

const ENSURE_STAFF_SQL = "INSERT INTO roles (name) VALUES ('STAFF') ON CONFLICT (name) DO NOTHING";
const CONVERT_ADMINS_SQL = `UPDATE users SET role_id = (SELECT id FROM roles WHERE name = 'STAFF')
  WHERE role_id IN (SELECT id FROM roles WHERE name = 'ADMIN') RETURNING id`;
const REMOVE_ADMIN_SQL = "DELETE FROM roles WHERE name = 'ADMIN' RETURNING id";

export function migrateAdminRoleInMemory(db) {
  let staffRole = db.roles.find((role) => role.name === "STAFF");
  if (!staffRole) {
    staffRole = { id: Math.max(0, ...db.roles.map((role) => role.id)) + 1, name: "STAFF" };
    db.roles.push(staffRole);
  }
  const adminRoleIds = new Set(db.roles.filter((role) => role.name === "ADMIN").map((role) => role.id));
  let convertedAccounts = 0;
  for (const user of db.users) {
    if (adminRoleIds.has(user.role_id)) {
      user.role_id = staffRole.id;
      convertedAccounts += 1;
    }
  }
  db.roles = db.roles.filter((role) => role.name !== "ADMIN");
  return { converted_accounts: convertedAccounts, removed_roles: adminRoleIds.size };
}

export function migrateAdminRoleSqlite(db) {
  return db.transaction(() => {
    db.prepare(ENSURE_STAFF_SQL).run();
    const converted = db.prepare(CONVERT_ADMINS_SQL).all();
    const removed = db.prepare(REMOVE_ADMIN_SQL).all();
    return { converted_accounts: converted.length, removed_roles: removed.length };
  })();
}

export async function migrateAdminRolePostgres(client) {
  await client.query("BEGIN");
  try {
    // Account creation and concurrent startups must not reintroduce an Admin
    // between converting its users and removing the obsolete role record.
    await client.query("LOCK TABLE roles, users IN SHARE ROW EXCLUSIVE MODE");
    await client.query(ENSURE_STAFF_SQL);
    const converted = await client.query(CONVERT_ADMINS_SQL);
    const removed = await client.query(REMOVE_ADMIN_SQL);
    await client.query("COMMIT");
    return { converted_accounts: converted.rowCount, removed_roles: removed.rowCount };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
