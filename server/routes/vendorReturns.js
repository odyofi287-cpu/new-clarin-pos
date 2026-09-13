import express from "express";
import { requireRole } from "../middleware/auth.js";
import { publishDataChange } from "../events.js";
import { dbAll, dbGet, dbRun } from "./dbCompat.js";

const router = express.Router();

router.get("/", requireRole("SUPERADMIN", "ADMIN", "STAFF", "VENDOR"), async (req, res) => {
  try {
    let sql = `
      SELECT vr.id, vr.vendor_id, v.name AS vendor_name, vr.product_id, p.name AS product_name,
             vr.return_date, vr.return_time, vr.quantity, vr.total_product_price_returned
      FROM vendor_returns vr
      JOIN vendors v ON v.id = vr.vendor_id
      JOIN products p ON p.id = vr.product_id
    `;
    const params = [];

    if (req.user.role === "VENDOR") {
      sql += ` WHERE vr.vendor_id = $${params.length + 1}`;
      params.push(req.user.vendor_id);
    }

    sql += " ORDER BY vr.return_date DESC, vr.return_time DESC";
    const rows = await dbAll(req.db, sql, params, `
      SELECT vr.id, vr.vendor_id, v.name AS vendor_name, vr.product_id, p.name AS product_name,
             vr.return_date, vr.return_time, vr.quantity, vr.total_product_price_returned
      FROM vendor_returns vr
      JOIN vendors v ON v.id = vr.vendor_id
      JOIN products p ON p.id = vr.product_id
      ${req.user.role === "VENDOR" ? "WHERE vr.vendor_id = ?" : ""}
      ORDER BY vr.return_date DESC, vr.return_time DESC
    `);
    res.json({ data: rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load vendor returns" });
  }
});

router.post("/", requireRole("SUPERADMIN", "ADMIN", "STAFF"), async (req, res) => {
  try {
    const {
      vendor_id,
      return_date,
      return_time,
      product_id,
      quantity,
      total_product_price_returned,
    } = req.body;

    const vendorId = Number(vendor_id);
    const productId = Number(product_id);
    const qty = Number(quantity);
    const totalPrice = Number(total_product_price_returned ?? 0);

    if (!vendorId || !productId || !Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ error: "Vendor, product, and valid quantity are required" });
    }
    if (!return_date) {
      return res.status(400).json({ error: "Return date is required" });
    }
    if (!return_time) {
      return res.status(400).json({ error: "Return time is required" });
    }
    if (!Number.isFinite(totalPrice) || totalPrice < 0) {
      return res.status(400).json({ error: "Return total must be a valid non-negative value" });
    }

    const vendor = await dbGet(req.db, "SELECT id, name FROM vendors WHERE id = $1", [vendorId], "SELECT id, name FROM vendors WHERE id = ?");
    if (!vendor) {
      return res.status(404).json({ error: "Vendor not found" });
    }
    if (req.user.role === "VENDOR" && Number(req.user.vendor_id) !== vendorId) {
      return res.status(403).json({ error: "You can only record returns for your own vendor profile" });
    }

    const product = await dbGet(req.db, "SELECT id, name FROM products WHERE id = $1", [productId], "SELECT id, name FROM products WHERE id = ?");
    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }

    const result = await dbRun(
      req.db,
      `INSERT INTO vendor_returns (vendor_id, product_id, quantity, total_product_price_returned, return_date, return_time, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [vendorId, productId, qty, totalPrice, return_date, return_time, req.user.user_id || req.user.id],
      `INSERT INTO vendor_returns (vendor_id, product_id, quantity, total_product_price_returned, return_date, return_time, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    const row = await dbGet(
      req.db,
      `SELECT vr.id, vr.vendor_id, v.name AS vendor_name, vr.product_id, p.name AS product_name,
              vr.return_date, vr.return_time, vr.quantity, vr.total_product_price_returned
       FROM vendor_returns vr
       JOIN vendors v ON v.id = vr.vendor_id
       JOIN products p ON p.id = vr.product_id
       WHERE vr.id = $1`,
      [result.lastInsertRowid],
      `SELECT vr.id, vr.vendor_id, v.name AS vendor_name, vr.product_id, p.name AS product_name,
              vr.return_date, vr.return_time, vr.quantity, vr.total_product_price_returned
       FROM vendor_returns vr
       JOIN vendors v ON v.id = vr.vendor_id
       JOIN products p ON p.id = vr.product_id
       WHERE vr.id = ?`
    );

    publishDataChange("vendor-return");
    res.status(201).json({ data: row });
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message || "Failed to record vendor return" });
  }
});

router.delete("/:id", requireRole("SUPERADMIN", "ADMIN", "STAFF"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await dbGet(req.db, "SELECT id, vendor_id FROM vendor_returns WHERE id = $1", [id], "SELECT id, vendor_id FROM vendor_returns WHERE id = ?");
    if (!existing) {
      return res.status(404).json({ error: "Vendor return not found" });
    }
    if (req.user.role === "VENDOR" && Number(req.user.vendor_id) !== Number(existing.vendor_id)) {
      return res.status(403).json({ error: "You can only remove your own vendor returns" });
    }

    await dbRun(req.db, "DELETE FROM vendor_returns WHERE id = $1 RETURNING id", [id], "DELETE FROM vendor_returns WHERE id = ?");

    publishDataChange("vendor-return");
    res.json({ data: { deleted: true, id } });
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message || "Failed to remove vendor return" });
  }
});

export default router;
