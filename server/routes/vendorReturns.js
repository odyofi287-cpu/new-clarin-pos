import express from "express";
import { randomUUID } from "node:crypto";
import { requireRole } from "../middleware/auth.js";
import { publishDataChange } from "../events.js";
import { dbAll, dbGet, dbRun, withTransaction } from "./dbCompat.js";

const router = express.Router();

function groupReturnRows(rows) {
  const groups = new Map();

  for (const row of rows) {
    const groupId = row.return_batch_id || `legacy-${row.id}`;
    const group = groups.get(groupId) || {
      id: groupId,
      return_batch_id: row.return_batch_id || null,
      vendor_id: row.vendor_id,
      vendor_name: row.vendor_name,
      return_date: row.return_date,
      return_time: row.return_time,
      items: [],
      quantity: 0,
      total_product_price_returned: 0,
      return_ids: [],
    };

    group.items.push(`${row.product_name || row.product_id} (${row.quantity})`);
    group.quantity += Number(row.quantity || 0);
    group.total_product_price_returned += Number(row.total_product_price_returned || 0);
    group.return_ids.push(row.id);
    groups.set(groupId, group);
  }

  return [...groups.values()];
}

router.get("/", requireRole("SUPERADMIN", "ADMIN", "STAFF", "VENDOR"), async (req, res) => {
  try {
    let sql = `
      SELECT vr.id, vr.return_batch_id, vr.vendor_id, v.name AS vendor_name, vr.product_id, p.name AS product_name,
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
      SELECT vr.id, vr.return_batch_id, vr.vendor_id, v.name AS vendor_name, vr.product_id, p.name AS product_name,
             vr.return_date, vr.return_time, vr.quantity, vr.total_product_price_returned
      FROM vendor_returns vr
      JOIN vendors v ON v.id = vr.vendor_id
      JOIN products p ON p.id = vr.product_id
      ${req.user.role === "VENDOR" ? "WHERE vr.vendor_id = ?" : ""}
      ORDER BY vr.return_date DESC, vr.return_time DESC
    `);
    res.json({ data: groupReturnRows(rows) });
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
    } = req.body;

    const vendorId = Number(vendor_id);
    const requestedItems = Array.isArray(req.body.items) && req.body.items.length
      ? req.body.items
      : [{
          product_id: req.body.product_id,
          quantity: req.body.quantity,
          total_product_price_returned: req.body.total_product_price_returned,
        }];

    if (!vendorId || !requestedItems.length) {
      return res.status(400).json({ error: "Vendor and at least one returned product are required" });
    }
    if (!return_date) {
      return res.status(400).json({ error: "Return date is required" });
    }
    if (!return_time) {
      return res.status(400).json({ error: "Return time is required" });
    }
    const vendor = await dbGet(req.db, "SELECT id, name FROM vendors WHERE id = $1", [vendorId], "SELECT id, name FROM vendors WHERE id = ?");
    if (!vendor) {
      return res.status(404).json({ error: "Vendor not found" });
    }
    if (req.user.role === "VENDOR" && Number(req.user.vendor_id) !== vendorId) {
      return res.status(403).json({ error: "You can only record returns for your own vendor profile" });
    }

    const returnItems = [];
    for (const item of requestedItems) {
      const productId = Number(item.product_id);
      const qty = Number(item.quantity);
      if (!productId || !Number.isInteger(qty) || qty <= 0) {
        return res.status(400).json({ error: "Each returned product needs a valid whole-number quantity" });
      }
      const product = await dbGet(req.db, "SELECT id, name, selling_price FROM products WHERE id = $1", [productId], "SELECT id, name, selling_price FROM products WHERE id = ?");
      if (!product) {
        return res.status(404).json({ error: `Product not found: ${productId}` });
      }
      const totalPrice = Number(item.total_product_price_returned ?? (Number(product.selling_price || 0) * qty));
      if (!Number.isFinite(totalPrice) || totalPrice < 0) {
        return res.status(400).json({ error: "Each return total must be a valid non-negative value" });
      }
      returnItems.push({ productId, product, qty, totalPrice });
    }

    const returnBatchId = randomUUID();
    const createdReturns = await withTransaction(req.db, async () => {
      const rows = [];
      for (const item of returnItems) {
        const result = await dbRun(
          req.db,
          `INSERT INTO vendor_returns (vendor_id, product_id, quantity, total_product_price_returned, return_date, return_time, created_by, return_batch_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [vendorId, item.productId, item.qty, item.totalPrice, return_date, return_time, req.user.user_id || req.user.id, returnBatchId],
          `INSERT INTO vendor_returns (vendor_id, product_id, quantity, total_product_price_returned, return_date, return_time, created_by, return_batch_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        );
        rows.push({
          id: result.lastInsertRowid,
          vendor_id: vendorId,
          vendor_name: vendor.name,
          product_id: item.productId,
          product_name: item.product.name,
          return_date,
          return_time,
          quantity: item.qty,
          total_product_price_returned: item.totalPrice,
          return_batch_id: returnBatchId,
        });
      }
      return rows;
    });

    publishDataChange("vendor-return");
    res.status(201).json({
      data: {
        items: createdReturns,
        item_count: createdReturns.length,
        return_batch_id: returnBatchId,
        total_amount: createdReturns.reduce((sum, item) => sum + Number(item.total_product_price_returned || 0), 0),
      }
    });
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message || "Failed to record vendor return" });
  }
});

router.delete("/batch/:batchId", requireRole("SUPERADMIN", "ADMIN", "STAFF"), async (req, res) => {
  try {
    const batchId = String(req.params.batchId || "").trim();
    if (!batchId) {
      return res.status(400).json({ error: "Return batch ID is required" });
    }

    const existing = await dbGet(
      req.db,
      "SELECT id FROM vendor_returns WHERE return_batch_id = $1 LIMIT 1",
      [batchId],
      "SELECT id FROM vendor_returns WHERE return_batch_id = ? LIMIT 1"
    );
    if (!existing) {
      return res.status(404).json({ error: "Vendor return batch not found" });
    }

    const result = await dbRun(
      req.db,
      "DELETE FROM vendor_returns WHERE return_batch_id = $1 RETURNING id",
      [batchId],
      "DELETE FROM vendor_returns WHERE return_batch_id = ?"
    );
    publishDataChange("vendor-return");
    res.json({ data: { deleted: true, return_batch_id: batchId, count: result.changes } });
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message || "Failed to remove vendor return batch" });
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
