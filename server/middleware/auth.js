import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET;

if (process.env.NODE_ENV === "production" && (!JWT_SECRET || JWT_SECRET === "change-this-secret")) {
  throw new Error("JWT_SECRET must be configured with a unique production secret");
}

export function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.replace("Bearer ", "") : req.query.token;
  if (!token) {
    return res.status(401).json({ error: "Authorization token missing" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET || "change-this-secret");
    req.user = payload;
    next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid or expired token" });
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

export function requireSuperadmin(req, res, next) {
  if (!req.user || req.user.role !== "SUPERADMIN") {
    return res.status(403).json({ error: "Superadmin access required" });
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
