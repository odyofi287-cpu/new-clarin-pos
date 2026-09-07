import express from "express";
import { createRequire } from "node:module";
import { requireRole, requireSuperadmin } from "../middleware/auth.js";

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

function createVendor(db, name, contact) {
  const nextVendor = db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM vendors").get().next_id;
  const vendorCode = `VND-${String(nextVendor).padStart(4, "0")}`;
  return Number(db.prepare(
    "INSERT INTO vendors (name, contact, vendor_code, active) VALUES (?, ?, ?, 1)"
  ).run(name.trim(), contact ?? null, vendorCode).lastInsertRowid);
}

function resolveVendorId(db, role, vendorId, name, contact) {
  if (role !== "VENDOR") return null;

  const requestedVendorId = Number(vendorId) || null;
  if (!requestedVendorId) return createVendor(db, name, contact);

  const vendor = db.prepare("SELECT id, active FROM vendors WHERE id = ?").get(requestedVendorId);
  if (!vendor) throw new Error("Selected vendor was not found");
  if (!vendor.active) throw new Error("Selected vendor is inactive");
  return requestedVendorId;
}

router.get("/me", requireRole("SUPERADMIN", "ADMIN", "STAFF", "VENDOR"), (req, res) => {
  res.json({ data: { user_id: req.user.user_id, email: req.user.email, name: req.user.name, role: req.user.role, vendor_id: req.user.vendor_id } });
});

router.get("/vendors", requireRole("SUPERADMIN", "ADMIN", "STAFF", "VENDOR"), (req, res) => {
  try {
    const params = [];
    let whereClause = "";

    if (req.user.role === "VENDOR") {
      whereClause = "WHERE id = ?";
      params.push(req.user.vendor_id);
    }

    const vendors = req.db.prepare(
      `SELECT id, name, vendor_code, active, created_at
       FROM vendors
       ${whereClause}
       ORDER BY name ASC`
    ).all(...params);

    res.json({ data: vendors });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load vendors" });
  }
});

router.get("/", requireSuperadmin, (req, res) => {
  const users = req.db.prepare(
    "SELECT u.id, u.username, u.email, u.name, u.role_id, r.name AS role, u.vendor_id, v.vendor_code, u.contact_person, u.contact_number, u.active, u.created_at FROM users u JOIN roles r ON u.role_id = r.id LEFT JOIN vendors v ON u.vendor_id = v.id ORDER BY u.id"
  ).all();

  res.json({ data: users.map(({ password, ...user }) => {
    const vendor = user.vendor_id ? req.db.prepare("SELECT id, vendor_code FROM vendors WHERE id = ?").get(user.vendor_id) : null;
    return {
      ...user,
      vendor_code: user.vendor_code || vendor?.vendor_code || null,
      vendor_id: user.vendor_id ?? null,
      contact_person: user.contact_person ?? null,
      contact_number: user.contact_number ?? null,
    };
  }) });
});

router.post("/verify-superadmin", requireSuperadmin, async (req, res) => {
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: "Superadmin password is required" });
  }

  const user = req.db.prepare(
    "SELECT u.id, u.password, r.name AS role FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = ? AND u.active = 1"
  ).get(req.user.user_id);

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

router.post("/", requireSuperadmin, (req, res) => {
  const { username, email, password, name, role, vendor_id, contact_person, contact_number } = req.body;
  const resolvedUsername = (username || email || "").trim();

  if (!resolvedUsername || !password || !name || !role) {
    return res.status(400).json({ error: "username, password, name, and role are required" });
  }

  const normalizedUsername = resolvedUsername.toLowerCase().replace(/@.*$/, "");
  const finalEmail = String(email || (normalizedUsername.includes("@") ? normalizedUsername : `${normalizedUsername}@clarin.local`)).trim().toLowerCase();

  const roleRecord = req.db.prepare("SELECT id, name FROM roles WHERE name = ?").get(role.toUpperCase());
  if (!roleRecord) {
    return res.status(400).json({ error: "Unsupported role" });
  }

  const existing = req.db.prepare("SELECT id FROM users WHERE email = ? OR username = ?").get(finalEmail, normalizedUsername);
  if (existing) {
    return res.status(409).json({ error: "User already exists" });
  }

  let userId;
  try {
    req.db.transaction(() => {
      const vendorId = resolveVendorId(req.db, roleRecord.name, vendor_id, name, contact_number);
      userId = req.db.prepare(
        "INSERT INTO users (username, email, password, name, role_id, vendor_id, contact_person, contact_number, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)"
      ).run(normalizedUsername, finalEmail, hashPassword(password), name.trim(), roleRecord.id, vendorId, contact_person ?? null, contact_number ?? null).lastInsertRowid;
    })();
  } catch (error) {
    if (error.message === "Selected vendor was not found" || error.message === "Selected vendor is inactive") {
      return res.status(400).json({ error: error.message });
    }
    throw error;
  }

  const created = req.db.prepare(
    "SELECT u.id, u.username, u.email, u.name, u.role_id, r.name AS role, u.vendor_id, v.vendor_code, u.contact_person, u.contact_number, u.active, u.created_at FROM users u JOIN roles r ON u.role_id = r.id LEFT JOIN vendors v ON u.vendor_id = v.id WHERE u.id = ?"
  ).get(userId);

  if (!created) {
    return res.status(500).json({ error: "User creation failed" });
  }

  const { password: _password, ...safeUser } = created;
  const createdVendor = safeUser.vendor_id ? req.db.prepare("SELECT id, vendor_code FROM vendors WHERE id = ?").get(safeUser.vendor_id) : null;
  res.status(201).json({ data: { ...safeUser, vendor_code: safeUser.vendor_code || createdVendor?.vendor_code || null, vendor_id: safeUser.vendor_id ?? null, contact_person: safeUser.contact_person ?? null, contact_number: safeUser.contact_number ?? null } });
});

router.put("/:id", requireSuperadmin, (req, res) => {
  const id = Number(req.params.id);
  const user = req.db.prepare("SELECT id FROM users WHERE id = ?").get(id);
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  const { username, email, password, name, role, vendor_id, contact_person, contact_number } = req.body;
  if (!name || !role) {
    return res.status(400).json({ error: "Name and role are required" });
  }

  const roleRecord = req.db.prepare("SELECT id, name FROM roles WHERE name = ?").get(role.toUpperCase());
  if (!roleRecord) {
    return res.status(400).json({ error: "Unsupported role" });
  }

  const current = req.db.prepare("SELECT id, username, email, password FROM users WHERE id = ?").get(id);
  const normalizedUsername = String(username ?? current.username ?? current.email.split("@")[0]).trim().toLowerCase();
  const normalizedEmail = String(email ?? current.email).trim().toLowerCase();
  if (!normalizedUsername || !normalizedEmail || !normalizedEmail.includes("@")) {
    return res.status(400).json({ error: "A username and valid email are required" });
  }

  const conflict = req.db.prepare("SELECT id FROM users WHERE (email = ? OR username = ?) AND id != ?").get(normalizedEmail, normalizedUsername, id);
  if (conflict) {
    return res.status(409).json({ error: "Username or email already in use" });
  }

  const updatedPassword = password == null || password === "" ? current.password : hashPassword(String(password));
  try {
    req.db.transaction(() => {
      const safeVendorId = resolveVendorId(req.db, roleRecord.name, vendor_id, name, contact_number);
      req.db.prepare(
        "UPDATE users SET username = ?, email = ?, password = ?, name = ?, role_id = ?, vendor_id = ?, contact_person = ?, contact_number = ? WHERE id = ?"
      ).run(normalizedUsername, normalizedEmail, updatedPassword, name.trim(), roleRecord.id, safeVendorId, contact_person ?? null, contact_number ?? null, id);
    })();
  } catch (error) {
    if (error.message === "Selected vendor was not found" || error.message === "Selected vendor is inactive") {
      return res.status(400).json({ error: error.message });
    }
    throw error;
  }

  const updated = req.db.prepare(
    "SELECT u.id, u.username, u.email, u.name, u.role_id, r.name AS role, u.vendor_id, u.contact_person, u.contact_number, u.active, u.created_at FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = ?"
  ).get(id);

  if (!updated) {
    return res.status(500).json({ error: "User update failed" });
  }

  res.json({ data: { ...updated, vendor_id: updated.vendor_id ?? null, contact_person: updated.contact_person ?? null, contact_number: updated.contact_number ?? null } });
});

router.delete("/:id", requireSuperadmin, (req, res) => {
  const id = Number(req.params.id);
  const user = req.db.prepare("SELECT id FROM users WHERE id = ?").get(id);
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  req.db.prepare("DELETE FROM users WHERE id = ?").run(id);
  res.json({ data: { id, deleted: true } });
});

export default router;
