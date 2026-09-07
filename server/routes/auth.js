import express from "express";
import { createRequire } from 'module';
let bcrypt = null;
try {
  const require = createRequire(import.meta.url);
  bcrypt = require('bcrypt');
} catch (e) {
  bcrypt = null;
}
import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;

if (process.env.NODE_ENV === "production" && (!JWT_SECRET || JWT_SECRET === "change-this-secret")) {
  throw new Error("JWT_SECRET must be configured with a unique production secret");
}
const JWT_EXPIRATION = "8h";

router.post("/login", (req, res) => {
  const { email, username, password } = req.body;
  const identity = String(email || username || "").trim().toLowerCase();
  if (!identity || !password) {
    return res.status(400).json({ error: "Username or email and password are required" });
  }

  const user = req.db.prepare(
    "SELECT u.id, u.email, u.password, u.name, u.role_id, u.vendor_id, r.name AS role FROM users u JOIN roles r ON u.role_id = r.id WHERE (lower(u.email) = ? OR lower(u.username) = ?) AND u.active = 1"
  ).get(identity, identity);

  let valid = false;
  if (bcrypt && user && typeof user.password === 'string' && user.password.startsWith('$2')) {
    valid = bcrypt.compareSync(password, user.password);
  } else if (user) {
    // Test mode or plain password stored
    valid = password === user.password;
  }

  if (!user || !valid) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = jwt.sign(
    {
      user_id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      vendor_id: user.vendor_id || null,
    },
    JWT_SECRET || "change-this-secret",
    { expiresIn: JWT_EXPIRATION }
  );

  res.json({ data: { token, role: user.role, vendor_id: user.vendor_id } });
});

export default router;
