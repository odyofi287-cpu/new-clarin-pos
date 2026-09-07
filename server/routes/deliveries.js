import express from "express";
import { requireRole } from "../middleware/auth.js";
import { publishDataChange } from "../events.js";

const router = express.Router();

function normalizeDeliveryDate(value) {
  const text = String(value || "").trim();
  const isoDate = text.match(/^\d{4}-\d{2}-\d{2}/);
  if (isoDate) return isoDate[0];

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString().slice(0, 10) : parsed.toISOString().slice(0, 10);
}

function executeTransaction(db, fn) {
  if (db && typeof db.transaction === "function") {
    const transaction = db.transaction(fn);
    return typeof transaction === "function" ? transaction() : fn();
  }
  return fn();
}

router.get("/", requireRole("SUPERADMIN", "ADMIN", "STAFF", "VENDOR"), (req, res) => {
  try {
    const filters = [];
    const params = [];
    if (req.user.role === "VENDOR") {
      filters.push("d.vendor_id = ?");
      params.push(req.user.vendor_id);
    }

    if (req.query.start_date) {
      filters.push("d.delivery_date >= ?");
      params.push(req.query.start_date);
    }
    if (req.query.end_date) {
      filters.push("d.delivery_date <= ?");
      params.push(req.query.end_date);
    }

    const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const deliveries = req.db.prepare(
      `SELECT d.id, d.vendor_id, v.name AS vendor_name, d.delivery_date, d.total_amount, d.created_at
       FROM deliveries d
       JOIN vendors v ON d.vendor_id = v.id
       ${whereClause}`
    ).all(...params);

    res.json({ data: deliveries });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load deliveries" });
  }
});

router.get("/:id", requireRole("SUPERADMIN", "ADMIN", "STAFF", "VENDOR"), (req, res) => {
  try {
    const id = Number(req.params.id);
    const params = [id];
    let vendorFilter = "";
    if (req.user.role === "VENDOR") {
      vendorFilter = "AND d.vendor_id = ?";
      params.push(req.user.vendor_id);
    }

    const delivery = req.db.prepare(
      `SELECT d.id, d.vendor_id, v.name AS vendor_name, d.delivery_date, d.total_amount, d.created_at
       FROM deliveries d
       JOIN vendors v ON d.vendor_id = v.id
       WHERE d.id = ? ${vendorFilter}`
    ).get(...params);

    if (!delivery) {
      if (req.user.role === "VENDOR") {
        const exists = req.db.prepare("SELECT 1 FROM deliveries WHERE id = ?").get(id);
        if (exists) {
          return res.status(403).json({ error: "Forbidden" });
        }
      }
      return res.status(404).json({ error: "Delivery not found" });
    }

    const items = req.db.prepare(
      `SELECT di.id, di.product_id, p.name AS product_name, di.quantity, di.unit_cost
       FROM delivery_items di
       JOIN products p ON di.product_id = p.id
       WHERE di.delivery_id = ?`
    ).all(id);

    res.json({ data: { ...delivery, items } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load delivery" });
  }
});

router.post("/", requireRole("SUPERADMIN", "ADMIN", "STAFF"), (req, res) => {
  try {
    const { vendor_id, pickup_datetime, delivery_date, delivery_time, items } = req.body;
    const vendorId = Number(vendor_id);
    const normalizedItems = Array.isArray(items) ? items : [{ product_id: req.body.product_id, quantity: req.body.quantity, unit_cost: req.body.unit_price }];

    if (!vendorId || !normalizedItems.length) {
      return res.status(400).json({ error: "Vendor and at least one item are required" });
    }

    const computedDate = delivery_date || (pickup_datetime ? pickup_datetime.split("T")[0] : "") || new Date().toISOString().split("T")[0];
    const deliveryDate = normalizeDeliveryDate(computedDate);

    const vendor = req.db.prepare("SELECT id FROM vendors WHERE id = ?").get(vendorId);
    if (!vendor) {
      return res.status(404).json({ error: "Vendor not found" });
    }

    const itemPayloads = normalizedItems.map((item) => {
      const productId = Number(item.product_id);
      const quantity = Number(item.quantity);
      const unitCost = Number(item.unit_cost ?? 0);
      if (!productId || !Number.isFinite(quantity) || quantity <= 0) {
        throw new Error("Each pickup item must include a valid product and quantity");
      }
      const product = req.db.prepare("SELECT id, current_stock, selling_price FROM products WHERE id = ?").get(productId);
      if (!product) {
        throw new Error(`Product ${productId} not found`);
      }
      const resolvedUnitCost = Number.isFinite(unitCost) && unitCost > 0 ? unitCost : Number(product.selling_price || 0);
      return { productId, quantity, unitCost: resolvedUnitCost, product };
    });

    const totalAmount = itemPayloads.reduce((sum, item) => sum + item.quantity * item.unitCost, 0);
    const deliveryResult = executeTransaction(req.db, () => {
      for (const item of itemPayloads) {
        const stockUpdate = req.db.prepare(
          "UPDATE products SET current_stock = current_stock - ? WHERE id = ? AND current_stock >= ?"
        ).run(item.quantity, item.productId, item.quantity);
        if (!stockUpdate.changes) throw new Error(`Insufficient stock for product ${item.productId}`);
      }

      const result = req.db.prepare(
        "INSERT INTO deliveries (vendor_id, delivery_date, total_amount, created_by) VALUES (?, ?, ?, ?)"
      ).run(vendorId, deliveryDate, totalAmount, req.user.user_id);

      itemPayloads.forEach((item) => {
        const itemId = req.db.prepare(
          "INSERT INTO delivery_items (delivery_id, product_id, quantity, unit_cost) VALUES (?, ?, ?, ?)"
        ).run(result.lastInsertRowid, item.productId, item.quantity, item.unitCost).lastInsertRowid;
        req.db.prepare(
          "INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_type, reference_id, user_id, created_at) VALUES (?, 'STOCK_OUT', ?, 'pickup', ?, ?, datetime('now'))"
        ).run(item.productId, item.quantity, itemId, req.user.user_id);
      });
      return result;
    });

    publishDataChange("delivery");

    res.status(201).json({
      data: {
        id: deliveryResult.lastInsertRowid,
        vendor_id: vendorId,
        delivery_date: deliveryDate,
        total_amount: totalAmount,
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

router.put("/:id", requireRole("SUPERADMIN"), (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = req.db.prepare("SELECT id, vendor_id, delivery_date, total_amount FROM deliveries WHERE id = ?").get(id);
    if (!existing) {
      return res.status(404).json({ error: "Pickup not found" });
    }

    const previousItems = req.db.prepare(
      "SELECT product_id, quantity FROM delivery_items WHERE delivery_id = ?"
    ).all(id);

    const { vendor_id, pickup_datetime, delivery_date, delivery_time, items } = req.body;
    const safeVendorId = Number(vendor_id ?? existing.vendor_id);
    const normalizedItems = Array.isArray(items) && items.length ? items : [{ product_id: req.body.product_id, quantity: req.body.quantity, unit_cost: req.body.unit_price }];
    const computedDate = (delivery_date || (pickup_datetime ? pickup_datetime.split("T")[0] : "") || (delivery_time ? req.body.delivery_date : "") || existing.delivery_date || new Date().toISOString().split("T")[0]);
    const safeDeliveryDate = normalizeDeliveryDate(computedDate);

    if (!safeVendorId || !normalizedItems.length) {
      return res.status(400).json({ error: "Vendor and at least one item are required" });
    }

    const vendor = req.db.prepare("SELECT id FROM vendors WHERE id = ?").get(safeVendorId);
    if (!vendor) {
      return res.status(404).json({ error: "Vendor not found" });
    }

    const itemPayloads = normalizedItems.map((item) => {
      const productId = Number(item.product_id);
      const quantity = Number(item.quantity);
      const unitCost = Number(item.unit_cost ?? 0);
      if (!productId || !Number.isFinite(quantity) || quantity <= 0) {
        throw new Error("Each pickup item must include a valid product and quantity");
      }
      const product = req.db.prepare("SELECT id, selling_price FROM products WHERE id = ?").get(productId);
      if (!product) {
        throw new Error(`Product ${productId} not found`);
      }
      const resolvedUnitCost = Number.isFinite(unitCost) && unitCost > 0 ? unitCost : Number(product.selling_price || 0);
      return { productId, quantity, unitCost: resolvedUnitCost };
    });

    const totalAmount = itemPayloads.reduce((sum, item) => sum + item.quantity * item.unitCost, 0);
    executeTransaction(req.db, () => {
      previousItems.forEach((item) => {
        req.db.prepare("UPDATE products SET current_stock = current_stock + ? WHERE id = ?").run(item.quantity, item.product_id);
        req.db.prepare(
          "INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_type, reference_id, user_id, created_at) VALUES (?, 'STOCK_IN', ?, 'pickup_update_restore', ?, ?, datetime('now'))"
        ).run(item.product_id, item.quantity, id, req.user.user_id);
      });

      for (const item of itemPayloads) {
        const stockUpdate = req.db.prepare(
          "UPDATE products SET current_stock = current_stock - ? WHERE id = ? AND current_stock >= ?"
        ).run(item.quantity, item.productId, item.quantity);
        if (!stockUpdate.changes) throw new Error(`Insufficient stock for product ${item.productId}`);
      }

      req.db.prepare("DELETE FROM delivery_items WHERE delivery_id = ?").run(id);
      req.db.prepare("UPDATE deliveries SET vendor_id = ?, delivery_date = ?, total_amount = ? WHERE id = ?").run(safeVendorId, safeDeliveryDate, totalAmount, id);

      itemPayloads.forEach((item) => {
        req.db.prepare("INSERT INTO delivery_items (delivery_id, product_id, quantity, unit_cost) VALUES (?, ?, ?, ?)").run(id, item.productId, item.quantity, item.unitCost);
        req.db.prepare(
          "INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_type, reference_id, user_id, created_at) VALUES (?, 'STOCK_OUT', ?, 'pickup_update', ?, ?, datetime('now'))"
        ).run(item.productId, item.quantity, id, req.user.user_id);
      });
    });

    const updatedDelivery = req.db.prepare(
      `SELECT d.id, d.vendor_id, v.name AS vendor_name, d.delivery_date, d.total_amount, d.created_at
       FROM deliveries d
       JOIN vendors v ON d.vendor_id = v.id
       WHERE d.id = ?`
    ).get(id);
    const updatedItems = req.db.prepare(
      `SELECT di.id, di.product_id, p.name AS product_name, di.quantity, di.unit_cost
       FROM delivery_items di
       JOIN products p ON di.product_id = p.id
       WHERE di.delivery_id = ?`
    ).all(id);

    publishDataChange("delivery");
    res.json({ data: { ...updatedDelivery, items: updatedItems } });
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message || "Failed to update vendor pickup" });
  }
});

router.delete("/:id", requireRole("SUPERADMIN", "ADMIN", "STAFF"), (req, res) => {
  try {
    const id = Number(req.params.id);
    const delivery = req.db.prepare("SELECT id, vendor_id, total_amount FROM deliveries WHERE id = ?").get(id);
    if (!delivery) {
      return res.status(404).json({ error: "Pickup not found" });
    }

    const items = req.db.prepare(
      "SELECT product_id, quantity FROM delivery_items WHERE delivery_id = ?"
    ).all(id);

    executeTransaction(req.db, () => {
      items.forEach((item) => {
        req.db.prepare("UPDATE products SET current_stock = current_stock + ? WHERE id = ?").run(item.quantity, item.product_id);
        req.db.prepare(
          "INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_type, reference_id, user_id, created_at) VALUES (?, 'STOCK_IN', ?, 'pickup_delete_restore', ?, ?, datetime('now'))"
        ).run(item.product_id, item.quantity, id, req.user.user_id);
      });

      req.db.prepare("DELETE FROM delivery_items WHERE delivery_id = ?").run(id);
      req.db.prepare("DELETE FROM deliveries WHERE id = ?").run(id);
    });

    publishDataChange("delivery");
    res.json({ data: { deleted: true, id } });
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message || "Failed to delete vendor pickup" });
  }
});

export default router;
