import express from "express";
import { requireRole } from "../middleware/auth.js";
import { publishDataChange } from "../events.js";
import { dbAll, dbGet, dbRun, isInMemoryDb, withTransaction } from "./dbCompat.js";
import { getBusinessDate } from "../businessDate.js";

const router = express.Router();

function normalizeDeliveryDate(value) {
  const text = String(value || "").trim();
  const isoDate = text.match(/^\d{4}-\d{2}-\d{2}/);
  if (isoDate) return isoDate[0];

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? getBusinessDate() : parsed.toISOString().slice(0, 10);
}

async function addDeliveryAccountAmounts(db, deliveries) {
  const rows = Array.isArray(deliveries) ? deliveries : [deliveries];
  if (!rows.length || !rows[0]) return Array.isArray(deliveries) ? [] : deliveries;

  let returnRows;
  if (isInMemoryDb(db)) {
    returnRows = db.vendor_returns
      .filter((entry) => entry.delivery_id != null)
      .map((entry) => ({ delivery_id: entry.delivery_id, total_product_price_returned: entry.total_product_price_returned }));
  } else {
    returnRows = await dbAll(
      db,
      `SELECT delivery_id, SUM(total_product_price_returned) AS return_deduction
       FROM vendor_returns WHERE delivery_id IS NOT NULL GROUP BY delivery_id`,
      [],
      `SELECT delivery_id, SUM(total_product_price_returned) AS return_deduction
       FROM vendor_returns WHERE delivery_id IS NOT NULL GROUP BY delivery_id`
    );
  }

  const deductions = new Map();
  for (const entry of returnRows) {
    const deliveryId = Number(entry.delivery_id);
    const amount = Number(entry.return_deduction ?? entry.total_product_price_returned ?? 0);
    deductions.set(deliveryId, (deductions.get(deliveryId) || 0) + amount);
  }

  const enriched = rows.map((delivery) => {
    const originalAmount = Number(delivery.total_amount ?? delivery.original_amount ?? 0);
    const returnDeduction = deductions.get(Number(delivery.id)) || 0;
    return {
      ...delivery,
      original_amount: originalAmount,
      return_deduction: returnDeduction,
      amount_due: Math.max(originalAmount - returnDeduction, 0),
    };
  });
  return Array.isArray(deliveries) ? enriched : enriched[0];
}

router.get("/", requireRole("SUPERADMIN", "ADMIN", "STAFF", "VENDOR"), async (req, res) => {
  try {
    const pgFilters = [];
    const sqliteFilters = [];
    const params = [];
    if (req.user.role === "VENDOR") {
      pgFilters.push(`d.vendor_id = $${params.length + 1}`);
      sqliteFilters.push("d.vendor_id = ?");
      params.push(req.user.vendor_id);
    }

    if (req.query.start_date) {
      pgFilters.push(`d.delivery_date >= $${params.length + 1}`);
      sqliteFilters.push("d.delivery_date >= ?");
      params.push(req.query.start_date);
    }
    if (req.query.end_date) {
      pgFilters.push(`d.delivery_date <= $${params.length + 1}`);
      sqliteFilters.push("d.delivery_date <= ?");
      params.push(req.query.end_date);
    }

    const pgWhereClause = pgFilters.length ? `WHERE ${pgFilters.join(" AND ")}` : "";
    const sqliteWhereClause = sqliteFilters.length ? `WHERE ${sqliteFilters.join(" AND ")}` : "";
    const deliveries = await dbAll(
      req.db,
      `SELECT d.id, d.vendor_id, v.vendor_code, v.name AS vendor_name, d.delivery_date, d.delivery_time, d.total_amount,
              COALESCE(d.payment_status, 'UNPAID') AS payment_status, d.payment_confirmed_at, d.payment_confirmed_by,
              confirmer.name AS payment_confirmed_by_name, d.created_at,
              COALESCE(STRING_AGG(p.name || ' (' || di.quantity::text || ')', ', ' ORDER BY p.name), '') AS items
       FROM deliveries d
       JOIN vendors v ON d.vendor_id = v.id
       LEFT JOIN users confirmer ON confirmer.id = d.payment_confirmed_by
       LEFT JOIN delivery_items di ON di.delivery_id = d.id
       LEFT JOIN products p ON p.id = di.product_id
       ${pgWhereClause}
       GROUP BY d.id, v.id, confirmer.id
       ORDER BY d.delivery_date DESC, d.delivery_time DESC NULLS LAST, d.id DESC`,
      params,
      `SELECT d.id, d.vendor_id, v.vendor_code, v.name AS vendor_name, d.delivery_date, d.delivery_time, d.total_amount,
              COALESCE(d.payment_status, 'UNPAID') AS payment_status, d.payment_confirmed_at, d.payment_confirmed_by,
              confirmer.name AS payment_confirmed_by_name, d.created_at,
              COALESCE(GROUP_CONCAT(p.name || ' (' || di.quantity || ')', ', '), '') AS items
       FROM deliveries d
       JOIN vendors v ON d.vendor_id = v.id
       LEFT JOIN users confirmer ON confirmer.id = d.payment_confirmed_by
       LEFT JOIN delivery_items di ON di.delivery_id = d.id
       LEFT JOIN products p ON p.id = di.product_id
       ${sqliteWhereClause}
       GROUP BY d.id, v.id
       ORDER BY d.delivery_date DESC, d.delivery_time DESC, d.id DESC`
    );

    res.json({ data: await addDeliveryAccountAmounts(req.db, deliveries) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load deliveries" });
  }
});

router.get("/:id", requireRole("SUPERADMIN", "ADMIN", "STAFF", "VENDOR"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const params = [id];
    let pgVendorFilter = "";
    let sqliteVendorFilter = "";
    if (req.user.role === "VENDOR") {
      pgVendorFilter = `AND d.vendor_id = $${params.length + 1}`;
      sqliteVendorFilter = "AND d.vendor_id = ?";
      params.push(req.user.vendor_id);
    }

    const delivery = await dbGet(
      req.db,
      `SELECT d.id, d.vendor_id, v.vendor_code, v.name AS vendor_name, d.delivery_date, d.delivery_time, d.total_amount,
              COALESCE(d.payment_status, 'UNPAID') AS payment_status, d.payment_confirmed_at, d.payment_confirmed_by,
              confirmer.name AS payment_confirmed_by_name, d.created_at
       FROM deliveries d
       JOIN vendors v ON d.vendor_id = v.id
       LEFT JOIN users confirmer ON confirmer.id = d.payment_confirmed_by
       WHERE d.id = $1 ${pgVendorFilter}`,
      params,
      `SELECT d.id, d.vendor_id, v.vendor_code, v.name AS vendor_name, d.delivery_date, d.delivery_time, d.total_amount,
              COALESCE(d.payment_status, 'UNPAID') AS payment_status, d.payment_confirmed_at, d.payment_confirmed_by,
              confirmer.name AS payment_confirmed_by_name, d.created_at
       FROM deliveries d
       JOIN vendors v ON d.vendor_id = v.id
       LEFT JOIN users confirmer ON confirmer.id = d.payment_confirmed_by
       WHERE d.id = ? ${sqliteVendorFilter}`
    );

    if (!delivery) {
      if (req.user.role === "VENDOR") {
        const exists = await dbGet(req.db, "SELECT 1 FROM deliveries WHERE id = $1", [id], "SELECT 1 FROM deliveries WHERE id = ?");
        if (exists) {
          return res.status(403).json({ error: "Forbidden" });
        }
      }
      return res.status(404).json({ error: "Delivery not found" });
    }

    const items = await dbAll(
      req.db,
      `SELECT di.id, di.product_id, p.name AS product_name, di.quantity, di.unit_cost
       FROM delivery_items di
       JOIN products p ON di.product_id = p.id
       WHERE di.delivery_id = $1`,
      [id],
      `SELECT di.id, di.product_id, p.name AS product_name, di.quantity, di.unit_cost
       FROM delivery_items di
       JOIN products p ON di.product_id = p.id
       WHERE di.delivery_id = ?`
    );

    res.json({ data: await addDeliveryAccountAmounts(req.db, { ...delivery, items }) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load delivery" });
  }
});

router.post("/", requireRole("SUPERADMIN", "ADMIN", "STAFF"), async (req, res) => {
  try {
    const { vendor_id, pickup_datetime, delivery_date, delivery_time, items } = req.body;
    const vendorId = Number(vendor_id);
    const normalizedItems = Array.isArray(items) ? items : [{ product_id: req.body.product_id, quantity: req.body.quantity, unit_cost: req.body.unit_price }];

    if (!vendorId || !normalizedItems.length) {
      return res.status(400).json({ error: "Vendor and at least one item are required" });
    }

    const computedDate = delivery_date || (pickup_datetime ? pickup_datetime.split("T")[0] : "") || getBusinessDate();
    const deliveryDate = normalizeDeliveryDate(computedDate);
    const deliveryTime = String(delivery_time || (pickup_datetime ? pickup_datetime.split("T")[1]?.slice(0, 5) : "") || "").slice(0, 5) || null;

    const vendor = await dbGet(req.db, "SELECT id FROM vendors WHERE id = $1", [vendorId], "SELECT id FROM vendors WHERE id = ?");
    if (!vendor) {
      return res.status(404).json({ error: "Vendor not found" });
    }

    const itemPayloads = [];
    for (const item of normalizedItems) {
      const productId = Number(item.product_id);
      const quantity = Number(item.quantity);
      const unitCost = Number(item.unit_cost ?? 0);
      if (!productId || !Number.isFinite(quantity) || quantity <= 0) {
        throw new Error("Each pickup item must include a valid product and quantity");
      }
      const product = await dbGet(req.db, "SELECT id, current_stock, selling_price FROM products WHERE id = $1", [productId], "SELECT id, current_stock, selling_price FROM products WHERE id = ?");
      if (!product) {
        throw new Error(`Product ${productId} not found`);
      }
      const resolvedUnitCost = Number.isFinite(unitCost) && unitCost > 0 ? unitCost : Number(product.selling_price || 0);
      itemPayloads.push({ productId, quantity, unitCost: resolvedUnitCost, product });
    }

    const totalAmount = itemPayloads.reduce((sum, item) => sum + item.quantity * item.unitCost, 0);
    const deliveryResult = await withTransaction(req.db, async () => {
      for (const item of itemPayloads) {
        const stockUpdate = await dbRun(
          req.db,
          "UPDATE products SET current_stock = current_stock - $1 WHERE id = $2 AND current_stock >= $1 RETURNING id",
          [item.quantity, item.productId],
          "UPDATE products SET current_stock = current_stock - ? WHERE id = ? AND current_stock >= ?"
        );
        if (!stockUpdate.changes) throw new Error(`Insufficient stock for product ${item.productId}`);
      }

      const result = await dbRun(
        req.db,
        "INSERT INTO deliveries (vendor_id, delivery_date, delivery_time, total_amount, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id",
        [vendorId, deliveryDate, deliveryTime, totalAmount, req.user.user_id],
        "INSERT INTO deliveries (vendor_id, delivery_date, delivery_time, total_amount, created_by) VALUES (?, ?, ?, ?, ?)"
      );

      for (const item of itemPayloads) {
        const insertedItem = await dbRun(
          req.db,
          "INSERT INTO delivery_items (delivery_id, product_id, quantity, unit_cost) VALUES ($1, $2, $3, $4) RETURNING id",
          [result.lastInsertRowid, item.productId, item.quantity, item.unitCost],
          "INSERT INTO delivery_items (delivery_id, product_id, quantity, unit_cost) VALUES (?, ?, ?, ?)"
        );
        await dbRun(
          req.db,
          "INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_type, reference_id, user_id, created_at) VALUES ($1, 'STOCK_OUT', $2, 'pickup', $3, $4, CURRENT_TIMESTAMP) RETURNING id",
          [item.productId, item.quantity, insertedItem.lastInsertRowid, req.user.user_id],
          "INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_type, reference_id, user_id, created_at) VALUES (?, 'STOCK_OUT', ?, 'pickup', ?, ?, datetime('now'))"
        );
      }
      return result;
    });

    publishDataChange("delivery");

    res.status(201).json({
      data: {
        id: deliveryResult.lastInsertRowid,
        vendor_id: vendorId,
        delivery_date: deliveryDate,
        delivery_time: deliveryTime,
        total_amount: totalAmount,
        payment_status: "UNPAID",
        payment_confirmed_at: null,
        payment_confirmed_by: null,
        items: itemPayloads.map((item) => ({
          product_id: item.productId,
          quantity: item.quantity,
          unit_cost: item.unitCost,
          total: item.quantity * item.unitCost,
        })),
      }
    });
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message || "Failed to record vendor pickup" });
  }
});

router.put("/:id", requireRole("SUPERADMIN"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await dbGet(req.db, "SELECT id, vendor_id, delivery_date, delivery_time, total_amount, payment_status FROM deliveries WHERE id = $1", [id], "SELECT id, vendor_id, delivery_date, delivery_time, total_amount, payment_status FROM deliveries WHERE id = ?");
    if (!existing) {
      return res.status(404).json({ error: "Pickup not found" });
    }

    const previousItems = await dbAll(req.db, "SELECT product_id, quantity FROM delivery_items WHERE delivery_id = $1", [id], "SELECT product_id, quantity FROM delivery_items WHERE delivery_id = ?");

    const { vendor_id, pickup_datetime, delivery_date, delivery_time, items, payment_status } = req.body;
    const safeVendorId = Number(vendor_id ?? existing.vendor_id);
    const safePaymentStatus = String(payment_status ?? existing.payment_status ?? "UNPAID").trim().toUpperCase();
    const normalizedItems = Array.isArray(items) && items.length ? items : [{ product_id: req.body.product_id, quantity: req.body.quantity, unit_cost: req.body.unit_price }];
    const computedDate = (delivery_date || (pickup_datetime ? pickup_datetime.split("T")[0] : "") || (delivery_time ? req.body.delivery_date : "") || existing.delivery_date || getBusinessDate());
    const safeDeliveryDate = normalizeDeliveryDate(computedDate);
    const safeDeliveryTime = String(delivery_time || (pickup_datetime ? pickup_datetime.split("T")[1]?.slice(0, 5) : "") || existing.delivery_time || "").slice(0, 5) || null;

    if (!safeVendorId || !normalizedItems.length) {
      return res.status(400).json({ error: "Vendor and at least one item are required" });
    }
    if (!['UNPAID', 'PAID'].includes(safePaymentStatus)) {
      return res.status(400).json({ error: "Payment status must be PAID or UNPAID" });
    }

    const vendor = await dbGet(req.db, "SELECT id FROM vendors WHERE id = $1", [safeVendorId], "SELECT id FROM vendors WHERE id = ?");
    if (!vendor) {
      return res.status(404).json({ error: "Vendor not found" });
    }

    const itemPayloads = [];
    for (const item of normalizedItems) {
      const productId = Number(item.product_id);
      const quantity = Number(item.quantity);
      const unitCost = Number(item.unit_cost ?? 0);
      if (!productId || !Number.isFinite(quantity) || quantity <= 0) {
        throw new Error("Each pickup item must include a valid product and quantity");
      }
      const product = await dbGet(req.db, "SELECT id, selling_price FROM products WHERE id = $1", [productId], "SELECT id, selling_price FROM products WHERE id = ?");
      if (!product) {
        throw new Error(`Product ${productId} not found`);
      }
      const resolvedUnitCost = Number.isFinite(unitCost) && unitCost > 0 ? unitCost : Number(product.selling_price || 0);
      itemPayloads.push({ productId, quantity, unitCost: resolvedUnitCost });
    }

    const totalAmount = itemPayloads.reduce((sum, item) => sum + item.quantity * item.unitCost, 0);
    await withTransaction(req.db, async () => {
      for (const item of previousItems) {
        await dbRun(req.db, "UPDATE products SET current_stock = current_stock + $1 WHERE id = $2 RETURNING id", [item.quantity, item.product_id], "UPDATE products SET current_stock = current_stock + ? WHERE id = ?");
        await dbRun(
          req.db,
          "INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_type, reference_id, user_id, created_at) VALUES ($1, 'STOCK_IN', $2, 'pickup_update_restore', $3, $4, CURRENT_TIMESTAMP) RETURNING id",
          [item.product_id, item.quantity, id, req.user.user_id],
          "INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_type, reference_id, user_id, created_at) VALUES (?, 'STOCK_IN', ?, 'pickup_update_restore', ?, ?, datetime('now'))"
        );
      }

      for (const item of itemPayloads) {
        const stockUpdate = await dbRun(
          req.db,
          "UPDATE products SET current_stock = current_stock - $1 WHERE id = $2 AND current_stock >= $1 RETURNING id",
          [item.quantity, item.productId],
          "UPDATE products SET current_stock = current_stock - ? WHERE id = ? AND current_stock >= ?"
        );
        if (!stockUpdate.changes) throw new Error(`Insufficient stock for product ${item.productId}`);
      }

      await dbRun(req.db, "DELETE FROM delivery_items WHERE delivery_id = $1 RETURNING id", [id], "DELETE FROM delivery_items WHERE delivery_id = ?");
      await dbRun(req.db, "UPDATE deliveries SET vendor_id = $1, delivery_date = $2, delivery_time = $3, total_amount = $4 WHERE id = $5 RETURNING id", [safeVendorId, safeDeliveryDate, safeDeliveryTime, totalAmount, id], "UPDATE deliveries SET vendor_id = ?, delivery_date = ?, delivery_time = ?, total_amount = ? WHERE id = ?");

      if (safePaymentStatus !== String(existing.payment_status || "UNPAID").toUpperCase()) {
        if (safePaymentStatus === "PAID") {
          await dbRun(
            req.db,
            "UPDATE deliveries SET payment_status = 'PAID', payment_confirmed_at = CURRENT_TIMESTAMP, payment_confirmed_by = $1 WHERE id = $2 RETURNING id",
            [req.user.user_id, id],
            "UPDATE deliveries SET payment_status = 'PAID', payment_confirmed_at = datetime('now'), payment_confirmed_by = ? WHERE id = ?"
          );
        } else {
          await dbRun(
            req.db,
            "UPDATE deliveries SET payment_status = 'UNPAID', payment_confirmed_at = NULL, payment_confirmed_by = NULL WHERE id = $1 RETURNING id",
            [id],
            "UPDATE deliveries SET payment_status = 'UNPAID', payment_confirmed_at = NULL, payment_confirmed_by = NULL WHERE id = ?"
          );
        }
      }

      for (const item of itemPayloads) {
        await dbRun(req.db, "INSERT INTO delivery_items (delivery_id, product_id, quantity, unit_cost) VALUES ($1, $2, $3, $4) RETURNING id", [id, item.productId, item.quantity, item.unitCost], "INSERT INTO delivery_items (delivery_id, product_id, quantity, unit_cost) VALUES (?, ?, ?, ?)");
        await dbRun(
          req.db,
          "INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_type, reference_id, user_id, created_at) VALUES ($1, 'STOCK_OUT', $2, 'pickup_update', $3, $4, CURRENT_TIMESTAMP) RETURNING id",
          [item.productId, item.quantity, id, req.user.user_id],
          "INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_type, reference_id, user_id, created_at) VALUES (?, 'STOCK_OUT', ?, 'pickup_update', ?, ?, datetime('now'))"
        );
      }
    });

    const updatedDelivery = await dbGet(
      req.db,
      `SELECT d.id, d.vendor_id, v.vendor_code, v.name AS vendor_name, d.delivery_date, d.delivery_time, d.total_amount,
              COALESCE(d.payment_status, 'UNPAID') AS payment_status, d.payment_confirmed_at, d.payment_confirmed_by,
              confirmer.name AS payment_confirmed_by_name, d.created_at
       FROM deliveries d
       JOIN vendors v ON d.vendor_id = v.id
       LEFT JOIN users confirmer ON confirmer.id = d.payment_confirmed_by
       WHERE d.id = $1`,
      [id],
      `SELECT d.id, d.vendor_id, v.vendor_code, v.name AS vendor_name, d.delivery_date, d.delivery_time, d.total_amount,
              COALESCE(d.payment_status, 'UNPAID') AS payment_status, d.payment_confirmed_at, d.payment_confirmed_by,
              confirmer.name AS payment_confirmed_by_name, d.created_at
       FROM deliveries d
       JOIN vendors v ON d.vendor_id = v.id
       LEFT JOIN users confirmer ON confirmer.id = d.payment_confirmed_by
       WHERE d.id = ?`
    );
    const updatedItems = await dbAll(
      req.db,
      `SELECT di.id, di.product_id, p.name AS product_name, di.quantity, di.unit_cost
       FROM delivery_items di
       JOIN products p ON di.product_id = p.id
       WHERE di.delivery_id = $1`,
      [id],
      `SELECT di.id, di.product_id, p.name AS product_name, di.quantity, di.unit_cost
       FROM delivery_items di
       JOIN products p ON di.product_id = p.id
       WHERE di.delivery_id = ?`
    );

    publishDataChange("delivery");
    res.json({ data: await addDeliveryAccountAmounts(req.db, { ...updatedDelivery, items: updatedItems }) });
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message || "Failed to update vendor pickup" });
  }
});

router.post("/:id/confirm-payment", requireRole("SUPERADMIN", "ADMIN", "STAFF"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid delivery ID" });
    }

    const delivery = await dbGet(
      req.db,
      "SELECT id, payment_status FROM deliveries WHERE id = $1",
      [id],
      "SELECT id, payment_status FROM deliveries WHERE id = ?"
    );
    if (!delivery) {
      return res.status(404).json({ error: "Pickup not found" });
    }

    if (String(delivery.payment_status || "UNPAID").toUpperCase() !== "PAID") {
      await dbRun(
        req.db,
        `UPDATE deliveries
         SET payment_status = 'PAID', payment_confirmed_at = CURRENT_TIMESTAMP, payment_confirmed_by = $1
         WHERE id = $2 AND COALESCE(payment_status, 'UNPAID') <> 'PAID'
         RETURNING id`,
        [req.user.user_id, id],
        `UPDATE deliveries
         SET payment_status = 'PAID', payment_confirmed_at = datetime('now'), payment_confirmed_by = ?
         WHERE id = ? AND COALESCE(payment_status, 'UNPAID') <> 'PAID'`
      );
    }

    const updatedDelivery = await dbGet(
      req.db,
      `SELECT d.id, d.vendor_id, v.vendor_code, v.name AS vendor_name, d.delivery_date, d.delivery_time, d.total_amount,
              COALESCE(d.payment_status, 'UNPAID') AS payment_status, d.payment_confirmed_at, d.payment_confirmed_by,
              confirmer.name AS payment_confirmed_by_name, d.created_at
       FROM deliveries d
       JOIN vendors v ON d.vendor_id = v.id
       LEFT JOIN users confirmer ON confirmer.id = d.payment_confirmed_by
       WHERE d.id = $1`,
      [id],
      `SELECT d.id, d.vendor_id, v.vendor_code, v.name AS vendor_name, d.delivery_date, d.delivery_time, d.total_amount,
              COALESCE(d.payment_status, 'UNPAID') AS payment_status, d.payment_confirmed_at, d.payment_confirmed_by,
              confirmer.name AS payment_confirmed_by_name, d.created_at
       FROM deliveries d
       JOIN vendors v ON d.vendor_id = v.id
       LEFT JOIN users confirmer ON confirmer.id = d.payment_confirmed_by
       WHERE d.id = ?`
    );

    publishDataChange("delivery");
    res.json({ data: await addDeliveryAccountAmounts(req.db, updatedDelivery) });
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message || "Failed to confirm delivery payment" });
  }
});

router.delete("/:id", requireRole("SUPERADMIN", "ADMIN", "STAFF"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const delivery = await dbGet(req.db, "SELECT id, vendor_id, total_amount FROM deliveries WHERE id = $1", [id], "SELECT id, vendor_id, total_amount FROM deliveries WHERE id = ?");
    if (!delivery) {
      return res.status(404).json({ error: "Pickup not found" });
    }

    const items = await dbAll(req.db, "SELECT product_id, quantity FROM delivery_items WHERE delivery_id = $1", [id], "SELECT product_id, quantity FROM delivery_items WHERE delivery_id = ?");

    await withTransaction(req.db, async () => {
      for (const item of items) {
        await dbRun(req.db, "UPDATE products SET current_stock = current_stock + $1 WHERE id = $2 RETURNING id", [item.quantity, item.product_id], "UPDATE products SET current_stock = current_stock + ? WHERE id = ?");
        await dbRun(
          req.db,
          "INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_type, reference_id, user_id, created_at) VALUES ($1, 'STOCK_IN', $2, 'pickup_delete_restore', $3, $4, CURRENT_TIMESTAMP) RETURNING id",
          [item.product_id, item.quantity, id, req.user.user_id],
          "INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_type, reference_id, user_id, created_at) VALUES (?, 'STOCK_IN', ?, 'pickup_delete_restore', ?, ?, datetime('now'))"
        );
      }

      await dbRun(req.db, "DELETE FROM delivery_items WHERE delivery_id = $1 RETURNING id", [id], "DELETE FROM delivery_items WHERE delivery_id = ?");
      await dbRun(req.db, "DELETE FROM deliveries WHERE id = $1 RETURNING id", [id], "DELETE FROM deliveries WHERE id = ?");
    });

    publishDataChange("delivery");
    res.json({ data: { deleted: true, id } });
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message || "Failed to delete vendor pickup" });
  }
});

export default router;
