import express from "express";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { requireRole, requireSuperadmin } from "../middleware/auth.js";
import { SUPPORTED_ROLES } from "../roleMigration.js";
import { dbAll, dbGet, dbRun, isInMemoryDb, isPostgresDb, withTransaction } from "./dbCompat.js";
import { publishDataChange } from "../events.js";

const router = express.Router();
const require = createRequire(import.meta.url);
let bcrypt = null;
try {
  bcrypt = require("bcrypt");
} catch (error) {
  bcrypt = null;
}

function hashPassword(password) {
  if (bcrypt) return bcrypt.hashSync(password, 10);
  if (process.env.NODE_ENV === "production") throw new Error("Password hashing is unavailable");
  return password;
}

const PROFILE_PICTURE_MAX_BYTES = 512 * 1024;
const PROFILE_PICTURE_SIGNATURES = {
  "image/jpeg": (buffer) => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
  "image/png": (buffer) => buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/webp": (buffer) => buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP",
};

function normalizeProfilePicture(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new Error("Profile picture must be a valid image file");

  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  if (!match || match[2].length % 4 !== 0) throw new Error("Profile picture must be a JPG, PNG, or WebP image");

  const mimeType = match[1].toLowerCase();
  const image = Buffer.from(match[2], "base64");
  if (!image.length || image.length > PROFILE_PICTURE_MAX_BYTES || !PROFILE_PICTURE_SIGNATURES[mimeType](image)) {
    throw new Error("Profile picture must be a valid image no larger than 512 KB");
  }

  return `data:${mimeType};base64,${image.toString("base64")}`;
}

async function createVendor(db, name, contact) {
  if (isPostgresDb(db)) {
    const created = await dbRun(
      db,
      "INSERT INTO vendors (name, contact, vendor_code, active) VALUES ($1, $2, $3, 1) RETURNING id",
      [name.trim(), contact ?? null, `PENDING-${randomUUID()}`]
    );
    const vendorId = Number(created.lastInsertRowid);
    await dbRun(
      db,
      "UPDATE vendors SET vendor_code = 'VND-' || LPAD(id::text, 4, '0') WHERE id = $1 RETURNING id",
      [vendorId]
    );
    return vendorId;
  }

  const nextVendor = (await dbGet(db, "SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM vendors", [], "SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM vendors")).next_id;
  const vendorCode = `VND-${String(nextVendor).padStart(4, "0")}`;
  return Number((await dbRun(
    db,
    "INSERT INTO vendors (name, contact, vendor_code, active) VALUES ($1, $2, $3, 1) RETURNING id",
    [name.trim(), contact ?? null, vendorCode],
    "INSERT INTO vendors (name, contact, vendor_code, active) VALUES (?, ?, ?, 1)"
  )).lastInsertRowid);
}

async function resolveVendorId(db, role, vendorId, name, contact, forceCreate = false) {
  if (role !== "VENDOR") return null;

  if (forceCreate) return await createVendor(db, name, contact);

  const requestedVendorId = Number(vendorId) || null;
  if (!requestedVendorId) return await createVendor(db, name, contact);

  const vendor = await dbGet(db, "SELECT id, active FROM vendors WHERE id = $1", [requestedVendorId], "SELECT id, active FROM vendors WHERE id = ?");
  if (!vendor) throw new Error("Selected vendor was not found");
  if (!vendor.active) throw new Error("Selected vendor is inactive");
  return requestedVendorId;
}

router.get("/me", requireRole("SUPERADMIN", "STAFF", "VENDOR"), async (req, res) => {
  const user = await dbGet(req.db, "SELECT id, username, email, name, profile_picture FROM users WHERE id = $1", [req.user.user_id], "SELECT id, username, email, name, profile_picture FROM users WHERE id = ?");
  res.json({ data: { user_id: user?.id ?? req.user.user_id, username: user?.username, email: user?.email ?? req.user.email, name: user?.name ?? req.user.name, profile_picture: user?.profile_picture || null, role: req.user.role, vendor_id: req.user.vendor_id } });
});

router.get("/vendors", requireRole("SUPERADMIN", "STAFF", "VENDOR"), async (req, res) => {
  try {
    const params = [];
    let whereClause;

    if (req.user.role === "VENDOR") {
      whereClause = isPostgresDb(req.db)
        ? "WHERE v.id = $1 AND v.active = 1 AND EXISTS (SELECT 1 FROM users u JOIN roles r ON r.id = u.role_id WHERE u.vendor_id = v.id AND u.active = 1 AND r.name = 'VENDOR')"
        : "WHERE v.id = ? AND v.active = 1 AND EXISTS (SELECT 1 FROM users u JOIN roles r ON r.id = u.role_id WHERE u.vendor_id = v.id AND u.active = 1 AND r.name = 'VENDOR')";
      params.push(req.user.vendor_id);
    } else {
      whereClause = "WHERE v.active = 1 AND EXISTS (SELECT 1 FROM users u JOIN roles r ON r.id = u.role_id WHERE u.vendor_id = v.id AND u.active = 1 AND r.name = 'VENDOR')";
    }

    const vendors = await dbAll(
      req.db,
      `SELECT v.id, v.name, v.vendor_code, v.active, v.created_at,
              (SELECT u.username
               FROM users u
               JOIN roles r ON r.id = u.role_id
               WHERE u.vendor_id = v.id AND u.active = 1 AND r.name = 'VENDOR'
               ORDER BY u.id ASC
               LIMIT 1) AS username
       FROM vendors v
       ${whereClause}
       ORDER BY v.name ASC`,
      params,
      `SELECT v.id, v.name, v.vendor_code, v.active, v.created_at,
              (SELECT u.username
               FROM users u
               JOIN roles r ON r.id = u.role_id
               WHERE u.vendor_id = v.id AND u.active = 1 AND r.name = 'VENDOR'
               ORDER BY u.id ASC
               LIMIT 1) AS username
       FROM vendors v
       ${whereClause}
       ORDER BY v.name ASC`
    );

    const activeVendors = isInMemoryDb(req.db)
      ? vendors.flatMap((vendor) => {
          const account = req.db.users.find((user) => user.vendor_id === vendor.id
            && user.active !== 0
            && req.db.roles.find((role) => role.id === user.role_id)?.name === "VENDOR");
          return account ? [{ ...vendor, username: account.username || String(account.email || "").split("@")[0] }] : [];
        })
      : vendors;

    res.json({ data: activeVendors });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load vendors" });
  }
});

router.get("/", requireSuperadmin, async (req, res) => {
  const users = await dbAll(
    req.db,
    "SELECT u.id, u.username, u.email, u.name, u.role_id, r.name AS role, u.vendor_id, v.vendor_code, u.contact_person, u.contact_number, u.profile_picture, u.active, u.created_at FROM users u JOIN roles r ON u.role_id = r.id LEFT JOIN vendors v ON u.vendor_id = v.id ORDER BY u.id"
  );

  const data = [];
  for (const { password, ...user } of users) {
    const vendor = user.vendor_id ? await dbGet(req.db, "SELECT id, vendor_code FROM vendors WHERE id = $1", [user.vendor_id], "SELECT id, vendor_code FROM vendors WHERE id = ?") : null;
    data.push({
      ...user,
      vendor_code: user.vendor_code || vendor?.vendor_code || null,
      vendor_id: user.vendor_id ?? null,
      contact_person: user.contact_person ?? null,
      contact_number: user.contact_number ?? null,
    });
  }
  res.json({ data });
});

router.post("/verify-superadmin", requireSuperadmin, async (req, res) => {
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: "Superadmin password is required" });
  }

  const user = await dbGet(req.db, "SELECT u.id, u.password, r.name AS role FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = $1 AND u.active = 1", [req.user.user_id], "SELECT u.id, u.password, r.name AS role FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = ? AND u.active = 1");

  if (!user || user.role !== "SUPERADMIN") {
    return res.status(403).json({ error: "Superadmin access required" });
  }

  let valid = false;
  if (typeof user.password === "string" && user.password.startsWith("$2")) {
    const bcrypt = await import("bcrypt").then((m) => m.default || m).catch(() => null);
    valid = bcrypt ? bcrypt.compareSync(password, user.password) : false;
  } else {
    valid = password === user.password;
  }

  if (!valid) {
    return res.status(401).json({ error: "Invalid superadmin password" });
  }

  res.json({ data: { verified: true } });
});

router.post("/", requireSuperadmin, async (req, res) => {
  const { username, email, password, name, role, vendor_id, contact_person, contact_number } = req.body;
  let profilePicture;
  try {
    profilePicture = normalizeProfilePicture(req.body.profile_picture);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  const resolvedUsername = (username || email || "").trim();

  if (!resolvedUsername || !password || !name || !role) {
    return res.status(400).json({ error: "username, password, name, and role are required" });
  }

  const normalizedUsername = resolvedUsername.toLowerCase().replace(/@.*$/, "");
  const finalEmail = String(email || (normalizedUsername.includes("@") ? normalizedUsername : `${normalizedUsername}@clarin.local`)).trim().toLowerCase();

  const roleRecord = await dbGet(req.db, "SELECT id, name FROM roles WHERE name = $1", [role.toUpperCase()], "SELECT id, name FROM roles WHERE name = ?");
  if (!roleRecord || !SUPPORTED_ROLES.includes(roleRecord.name)) {
    return res.status(400).json({ error: "Unsupported role" });
  }

  const existing = await dbGet(req.db, "SELECT id FROM users WHERE email = $1 OR username = $2", [finalEmail, normalizedUsername], "SELECT id FROM users WHERE email = ? OR username = ?");
  if (existing) {
    return res.status(409).json({ error: "User already exists" });
  }

  let userId;
  try {
    await withTransaction(req.db, async () => {
      const vendorId = await resolveVendorId(req.db, roleRecord.name, vendor_id, name, contact_number, true);
      userId = (await dbRun(req.db, "INSERT INTO users (username, email, password, name, role_id, vendor_id, contact_person, contact_number, profile_picture, active) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1) RETURNING id", [normalizedUsername, finalEmail, hashPassword(password), name.trim(), roleRecord.id, vendorId, contact_person ?? null, contact_number ?? null, profilePicture], "INSERT INTO users (username, email, password, name, role_id, vendor_id, contact_person, contact_number, profile_picture, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)")).lastInsertRowid;
    });
  } catch (error) {
    if (error.message === "Selected vendor was not found" || error.message === "Selected vendor is inactive") {
      return res.status(400).json({ error: error.message });
    }
    throw error;
  }

  const created = await dbGet(req.db, "SELECT u.id, u.username, u.email, u.name, u.role_id, r.name AS role, u.vendor_id, v.vendor_code, u.contact_person, u.contact_number, u.profile_picture, u.active, u.created_at FROM users u JOIN roles r ON u.role_id = r.id LEFT JOIN vendors v ON u.vendor_id = v.id WHERE u.id = $1", [userId], "SELECT u.id, u.username, u.email, u.name, u.role_id, r.name AS role, u.vendor_id, v.vendor_code, u.contact_person, u.contact_number, u.profile_picture, u.active, u.created_at FROM users u JOIN roles r ON u.role_id = r.id LEFT JOIN vendors v ON u.vendor_id = v.id WHERE u.id = ?");

  if (!created) {
    return res.status(500).json({ error: "User creation failed" });
  }

  const { password: _password, ...safeUser } = created;
  const createdVendor = safeUser.vendor_id ? await dbGet(req.db, "SELECT id, vendor_code FROM vendors WHERE id = $1", [safeUser.vendor_id], "SELECT id, vendor_code FROM vendors WHERE id = ?") : null;
  publishDataChange("user");
  res.status(201).json({ data: { ...safeUser, vendor_code: safeUser.vendor_code || createdVendor?.vendor_code || null, vendor_id: safeUser.vendor_id ?? null, contact_person: safeUser.contact_person ?? null, contact_number: safeUser.contact_number ?? null } });
});

router.put("/:id", requireSuperadmin, async (req, res) => {
  const id = Number(req.params.id);
  const user = await dbGet(req.db, "SELECT id FROM users WHERE id = $1", [id], "SELECT id FROM users WHERE id = ?");
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  const { username, email, password, name, role, vendor_id, contact_person, contact_number } = req.body;
  const profilePictureRequested = Object.prototype.hasOwnProperty.call(req.body, "profile_picture");
  const removeProfilePicture = req.body.remove_profile_picture === true;
  if (req.body.remove_profile_picture != null && typeof req.body.remove_profile_picture !== "boolean") {
    return res.status(400).json({ error: "remove_profile_picture must be true or false" });
  }
  let profilePicture;
  try {
    profilePicture = profilePictureRequested ? normalizeProfilePicture(req.body.profile_picture) : null;
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  if (removeProfilePicture && profilePicture) {
    return res.status(400).json({ error: "Choose either a replacement profile picture or remove the current picture" });
  }
  if (!name || !role) {
    return res.status(400).json({ error: "Name and role are required" });
  }

  const roleRecord = await dbGet(req.db, "SELECT id, name FROM roles WHERE name = $1", [role.toUpperCase()], "SELECT id, name FROM roles WHERE name = ?");
  if (!roleRecord || !SUPPORTED_ROLES.includes(roleRecord.name)) {
    return res.status(400).json({ error: "Unsupported role" });
  }

  const current = await dbGet(req.db, "SELECT id, username, email, password FROM users WHERE id = $1", [id], "SELECT id, username, email, password FROM users WHERE id = ?");
  const normalizedUsername = String(username ?? current.username ?? current.email.split("@")[0]).trim().toLowerCase();
  const normalizedEmail = String(email ?? current.email).trim().toLowerCase();
  if (!normalizedUsername || !normalizedEmail || !normalizedEmail.includes("@")) {
    return res.status(400).json({ error: "A username and valid email are required" });
  }

  const conflict = await dbGet(req.db, "SELECT id FROM users WHERE (email = $1 OR username = $2) AND id != $3", [normalizedEmail, normalizedUsername, id], "SELECT id FROM users WHERE (email = ? OR username = ?) AND id != ?");
  if (conflict) {
    return res.status(409).json({ error: "Username or email already in use" });
  }

  const updatedPassword = password == null || password === "" ? current.password : hashPassword(String(password));
  try {
    await withTransaction(req.db, async () => {
      const safeVendorId = await resolveVendorId(req.db, roleRecord.name, vendor_id, name, contact_number);
      // A Vendor account and its vendor record represent the same operational
      // party. Keep both records aligned so edits are reflected in the pickup
      // selector, delivery history, and vendor reports.
      if (roleRecord.name === "VENDOR" && safeVendorId) {
        await dbRun(
          req.db,
          "UPDATE vendors SET name = $1, contact = $2 WHERE id = $3 RETURNING id",
          [name.trim(), contact_number ?? null, safeVendorId],
          "UPDATE vendors SET name = ?, contact = ? WHERE id = ?"
        );
      }
      const values = [normalizedUsername, normalizedEmail, updatedPassword, name.trim(), roleRecord.id, safeVendorId, contact_person ?? null, contact_number ?? null];
      const baseUpdate = "username = $1, email = $2, password = $3, name = $4, role_id = $5, vendor_id = $6, contact_person = $7, contact_number = $8";
      if (removeProfilePicture) {
        await dbRun(req.db, `UPDATE users SET ${baseUpdate}, profile_picture = NULL WHERE id = $9 RETURNING id`, [...values, id]);
      } else if (profilePicture) {
        await dbRun(req.db, `UPDATE users SET ${baseUpdate}, profile_picture = $9 WHERE id = $10 RETURNING id`, [...values, profilePicture, id]);
      } else {
        await dbRun(req.db, `UPDATE users SET ${baseUpdate} WHERE id = $9 RETURNING id`, [...values, id]);
      }
    });
  } catch (error) {
    if (error.message === "Selected vendor was not found" || error.message === "Selected vendor is inactive") {
      return res.status(400).json({ error: error.message });
    }
    throw error;
  }

  const updated = await dbGet(req.db, "SELECT u.id, u.username, u.email, u.name, u.role_id, r.name AS role, u.vendor_id, u.contact_person, u.contact_number, u.profile_picture, u.active, u.created_at FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = $1", [id], "SELECT u.id, u.username, u.email, u.name, u.role_id, r.name AS role, u.vendor_id, u.contact_person, u.contact_number, u.profile_picture, u.active, u.created_at FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = ?");

  if (!updated) {
    return res.status(500).json({ error: "User update failed" });
  }

  publishDataChange("user");
  res.json({ data: { ...updated, vendor_id: updated.vendor_id ?? null, contact_person: updated.contact_person ?? null, contact_number: updated.contact_number ?? null } });
});

router.delete("/:id", requireSuperadmin, async (req, res) => {
  const id = Number(req.params.id);
  const user = await dbGet(req.db, "SELECT id FROM users WHERE id = $1", [id], "SELECT id FROM users WHERE id = ?");
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  await dbRun(req.db, "DELETE FROM users WHERE id = $1 RETURNING id", [id], "DELETE FROM users WHERE id = ?");
  publishDataChange("user");
  res.json({ data: { id, deleted: true } });
});

export default router;
