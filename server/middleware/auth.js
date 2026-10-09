import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { normalizeSessionRole } from "../roleMigration.js";
import { dbGet } from "../routes/dbCompat.js";

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET;

if (process.env.NODE_ENV === "production" && (!JWT_SECRET || JWT_SECRET === "change-this-secret")) {
  throw new Error("JWT_SECRET must be configured with a unique production secret");
}

export async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.replace("Bearer ", "") : req.query.token;
  if (!token) {
    return res.status(401).json({ error: "Authorization token missing" });
  }

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET || "change-this-secret");
  } catch (error) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
  try {
    req.user = { ...payload, role: normalizeSessionRole(payload.role) };
    if (["ADMIN", "SUPERADMIN"].includes(payload.role)) {
      // ADMIN used to mean Staff. Do not let an old signed token inherit the
      // renamed owner's privileges; resolve the current role from the account.
      const account = await dbGet(req.db,
        "SELECT u.id, u.active, u.vendor_id, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1 AND u.active = 1",
        [Number(payload.user_id)],
        "SELECT u.id, u.active, u.vendor_id, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ? AND u.active = 1");
      if (!account || account.active === 0) return res.status(401).json({ error: "Account is unavailable" });
      req.user.role = normalizeSessionRole(account.role);
      req.user.vendor_id = account.vendor_id || null;
    }
    next();
  } catch (error) {
    next(error);
  }
}

export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    next();
  };
}

export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "ADMIN") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

export function requireVendorAccess(req, res, next) {
  const rawVendor = req.params.vendorId ?? req.body.vendorId ?? req.query.vendorId;
  if (rawVendor === undefined) {
    return next();
  }
  const vendorId = Number(rawVendor);
  if (req.user.role === "VENDOR") {
    if (!req.user.vendor_id || req.user.vendor_id !== vendorId) {
      return res.status(403).json({ error: "Forbidden" });
    }
  }
  next();
}
