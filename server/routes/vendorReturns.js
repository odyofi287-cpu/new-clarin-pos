import express from "express";
import { requireRole } from "../middleware/auth.js";
import { publishDataChange } from "../events.js";

const router = express.Router();

router.get("/", requireRole("SUPERADMIN", "ADMIN", "STAFF", "VENDOR"), (req, res) => {
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
      sql += " WHERE vr.vendor_id = ?";
      params.push(req.user.vendor_id);
    }

    sql += " ORDER BY vr.return_date DESC, vr.return_time DESC";
    const rows = req.db.prepare(sql).all(...params);
    res.json({ data: rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load vendor returns" });
  }
});

router.post("/", requireRole("SUPERADMIN", "ADMIN", "STAFF", "VENDOR"), (req, res) => {
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

    const vendor = req.db.prepare("SELECT id, name FROM vendors WHERE id = ?").get(vendorId);
    if (!vendor) {
      return res.status(404).json({ error: "Vendor not found" });
    }
    if (req.user.role === "VENDOR" && Number(req.user.vendor_id) !== vendorId) {
      return res.status(403).json({ error: "You can only record returns for your own vendor profile" });
    }

    const product = req.db.prepare("SELECT id, name FROM products WHERE id = ?").get(productId);
    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }

    const result = req.db.prepare(
      `INSERT INTO vendor_returns (vendor_id, product_id, quantity, total_product_price_returned, return_date, return_time, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(vendorId, productId, qty, totalPrice, return_date, return_time, req.user.user_id || req.user.id);

    const row = req.db.prepare(
      `SELECT vr.id, vr.vendor_id, v.name AS vendor_name, vr.product_id, p.name AS product_name,
              vr.return_date, vr.return_time, vr.quantity, vr.total_product_price_returned
       FROM vendor_returns vr
       JOIN vendors v ON v.id = vr.vendor_id
       JOIN products p ON p.id = vr.product_id
       WHERE vr.id = ?`
    ).get(result.lastInsertRowid);

    publishDataChange("vendor-return");
    res.status(201).json({ data: row });
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message || "Failed to record vendor return" });
  }
});

router.delete("/:id", requireRole("SUPERADMIN", "ADMIN", "STAFF", "VENDOR"), (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = req.db.prepare("SELECT id, vendor_id FROM vendor_returns WHERE id = ?").get(id);
    if (!existing) {
      return res.status(404).json({ error: "Vendor return not found" });
    }
    if (req.user.role === "VENDOR" && Number(req.user.vendor_id) !== Number(existing.vendor_id)) {
      return res.status(403).json({ error: "You can only remove your own vendor returns" });
    }

    req.db.prepare("DELETE FROM vendor_returns WHERE id = ?").run(id);

    publishDataChange("vendor-return");
    res.json({ data: { deleted: true, id } });
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message || "Failed to remove vendor return" });
  }
});

export default router;
