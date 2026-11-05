import express from "express";
import { requireRole, requireCurrentStaff } from "../middleware/auth.js";
import { publishDataChange } from "../events.js";
import { dbAll, dbGet, dbRun, isInMemoryDb, isPostgresDb, withTransaction } from "./dbCompat.js";
import { getBusinessTimestamp } from "../businessDate.js";
import { deliveryQuantity, money } from "../productEconomics.js";
import { productReferences } from "../historyMetadata.js";
import { requireSalesIdentity, requireStaffDeliveryOwnership } from "../salesScope.js";

const router = express.Router();
router.use(requireSalesIdentity);

async function getDeliveryReturns(db, deliveryId) {
  if (isInMemoryDb(db)) {
    return db.vendor_returns.filter((entry) => Number(entry.delivery_id) === deliveryId);
  }
  return await dbAll(db,
    "SELECT product_id, quantity FROM vendor_returns WHERE delivery_id = $1",
    [deliveryId]
  );
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

router.get("/", requireRole("ADMIN", "STAFF", "VENDOR"), async (req, res) => {
  try {
    const pgFilters = [];
    const sqliteFilters = [];
    const params = [];
    if (req.user.role === "STAFF") {
      pgFilters.push("d.created_by = $1"); sqliteFilters.push("d.created_by = ?");
      params.push(Number(req.user.user_id));
    }
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
              d.created_by AS actor_id, creator.name AS actor_name, creator.username AS actor_username,
              JSON_AGG(JSON_BUILD_OBJECT('id', di.product_id, 'name', p.name)) AS product_refs,
              COALESCE(d.payment_status, 'UNPAID') AS payment_status, d.payment_confirmed_at, d.payment_confirmed_by,
              confirmer.name AS payment_confirmed_by_name, d.created_at,
              COALESCE(STRING_AGG(p.name || ' (' || di.quantity::text || ')', ', ' ORDER BY p.name), '') AS items
       FROM deliveries d
       JOIN vendors v ON d.vendor_id = v.id
       LEFT JOIN users creator ON creator.id = d.created_by
       LEFT JOIN users confirmer ON confirmer.id = d.payment_confirmed_by
       LEFT JOIN delivery_items di ON di.delivery_id = d.id
       LEFT JOIN products p ON p.id = di.product_id
       ${pgWhereClause}
       GROUP BY d.id, v.id, confirmer.id, creator.id
       ORDER BY d.delivery_date DESC, d.delivery_time DESC NULLS LAST, d.id DESC`,
      params,
      `SELECT d.id, d.vendor_id, v.vendor_code, v.name AS vendor_name, d.delivery_date, d.delivery_time, d.total_amount,
              d.created_by AS actor_id, creator.name AS actor_name, creator.username AS actor_username,
              JSON_GROUP_ARRAY(JSON_OBJECT('id', di.product_id, 'name', p.name)) AS product_refs,
              COALESCE(d.payment_status, 'UNPAID') AS payment_status, d.payment_confirmed_at, d.payment_confirmed_by,
              confirmer.name AS payment_confirmed_by_name, d.created_at,
              COALESCE(GROUP_CONCAT(p.name || ' (' || di.quantity || ')', ', '), '') AS items
       FROM deliveries d
       JOIN vendors v ON d.vendor_id = v.id
       LEFT JOIN users creator ON creator.id = d.created_by
       LEFT JOIN users confirmer ON confirmer.id = d.payment_confirmed_by
       LEFT JOIN delivery_items di ON di.delivery_id = d.id
       LEFT JOIN products p ON p.id = di.product_id
       ${sqliteWhereClause}
       GROUP BY d.id, v.id
       ORDER BY d.delivery_date DESC, d.delivery_time DESC, d.id DESC`
    );

    res.json({ data: await addDeliveryAccountAmounts(req.db, deliveries.map((delivery) => ({ ...delivery, product_refs: productReferences(delivery.product_refs) }))) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load deliveries" });
  }
});

router.get("/:id", requireRole("ADMIN", "STAFF", "VENDOR"), requireStaffDeliveryOwnership(), async (req, res) => {
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
      `SELECT di.id, di.product_id, p.name AS product_name, di.quantity, di.unit_cost, di.entry_unit, di.entry_quantity, di.case_size
       FROM delivery_items di
       JOIN products p ON di.product_id = p.id
       WHERE di.delivery_id = $1`,
      [id],
      `SELECT di.id, di.product_id, p.name AS product_name, di.quantity, di.unit_cost, di.entry_unit, di.entry_quantity, di.case_size
       FROM delivery_items di
       JOIN products p ON di.product_id = p.id
       WHERE di.delivery_id = ?`
    );

    res.json({ data: await addDeliveryAccountAmounts(req.db, { ...delivery, items: items.map(({ unit_base_price, ...item }) => item) }) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load delivery" });
  }
});

router.post("/", requireRole("ADMIN", "STAFF"), async (req, res) => {
  try {
    const { vendor_id, items } = req.body;
    const vendorId = Number(vendor_id);
    const normalizedItems = Array.isArray(items) ? items : [{ product_id: req.body.product_id, quantity: req.body.quantity, unit_cost: req.body.unit_price }];

    if (!vendorId || !normalizedItems.length) {
      return res.status(400).json({ error: "Vendor and at least one item are required" });
    }

    const vendor = await dbGet(req.db, "SELECT id FROM vendors WHERE id = $1", [vendorId], "SELECT id FROM vendors WHERE id = ?");
    if (!vendor) {
      return res.status(404).json({ error: "Vendor not found" });
    }

    const itemPayloads = [];
    for (const item of normalizedItems) {
      const productId = Number(item.product_id);
      const quantity = Number(item.entry_quantity ?? item.quantity);
      if (!productId || !Number.isFinite(quantity) || quantity <= 0) {
        throw new Error("Each pickup item must include a valid product and quantity");
      }
      const product = await dbGet(req.db, "SELECT id, current_stock, selling_price, base_price, quantity_per_case, active, deleted_at FROM products WHERE id = $1", [productId]);
      if (!product) {
        throw new Error(`Product ${productId} not found`);
      }
      if (product.deleted_at || Number(product.active) !== 1) throw new Error(`Product ${productId} is no longer available for new deliveries`);
      itemPayloads.push({ productId, ...deliveryQuantity(item, product), unitCost: Number(product.selling_price), unitBasePrice: product.base_price ?? null, input: item });
    }

    let totalAmount;
    let recordedAt;
    const deliveryResult = await withTransaction(req.db, async () => {
      for (const item of [...itemPayloads].sort((a, b) => a.productId - b.productId)) {
        const product = await dbGet(req.db, "SELECT id, selling_price, base_price, quantity_per_case, active, deleted_at FROM products WHERE id = $1 FOR UPDATE", [item.productId], "SELECT id, selling_price, base_price, quantity_per_case, active, deleted_at FROM products WHERE id = ?");
        if (!product || product.deleted_at || Number(product.active) !== 1) throw new Error(`Product ${item.productId} is no longer available for new deliveries`);
        Object.assign(item, deliveryQuantity(item.input, product), { unitCost: Number(product.selling_price), unitBasePrice: product.base_price ?? null });
        const stockUpdate = await dbRun(
          req.db,
          "UPDATE products SET current_stock = current_stock - $1 WHERE id = $2 AND current_stock >= $1 AND active = 1 AND deleted_at IS NULL RETURNING id",
          isPostgresDb(req.db) ? [item.quantity, item.productId] : [item.quantity, item.productId, item.quantity],
          "UPDATE products SET current_stock = current_stock - ? WHERE id = ? AND current_stock >= ? AND active = 1 AND deleted_at IS NULL"
        );
        if (!stockUpdate.changes) throw new Error(`Insufficient stock for product ${item.productId}`);
      }
      totalAmount = money(itemPayloads.reduce((sum, item) => sum + item.quantity * item.unitCost, 0));

      recordedAt = getBusinessTimestamp();
      const result = await dbRun(
        req.db,
        "INSERT INTO deliveries (vendor_id, delivery_date, delivery_time, total_amount, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
        [vendorId, recordedAt.date, recordedAt.time, totalAmount, req.user.user_id, recordedAt.created_at],
        "INSERT INTO deliveries (vendor_id, delivery_date, delivery_time, total_amount, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      );

      for (const item of itemPayloads) {
        const insertedItem = await dbRun(
          req.db,
          "INSERT INTO delivery_items (delivery_id, product_id, quantity, unit_cost, unit_base_price, entry_unit, entry_quantity, case_size) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
          [result.lastInsertRowid, item.productId, item.quantity, item.unitCost, item.unitBasePrice, item.entryUnit, item.entryQuantity, item.caseSize],
          "INSERT INTO delivery_items (delivery_id, product_id, quantity, unit_cost, unit_base_price, entry_unit, entry_quantity, case_size) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
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
        delivery_date: recordedAt.date,
        delivery_time: recordedAt.time,
        created_at: recordedAt.created_at,
        total_amount: totalAmount,
        payment_status: "UNPAID",
        payment_confirmed_at: null,
        payment_confirmed_by: null,
        items: itemPayloads.map((item) => ({
          product_id: item.productId,
          quantity: item.quantity,
          unit_cost: item.unitCost,
          entry_unit: item.entryUnit,
          entry_quantity: item.entryQuantity,
          case_size: item.caseSize,
          total: item.quantity * item.unitCost,
        })),
      }
    });
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message || "Failed to record vendor pickup" });
  }
});

router.put("/:id", requireCurrentStaff, requireStaffDeliveryOwnership(), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await dbGet(req.db, "SELECT id, vendor_id, delivery_date, delivery_time, total_amount, payment_status FROM deliveries WHERE id = $1", [id], "SELECT id, vendor_id, delivery_date, delivery_time, total_amount, payment_status FROM deliveries WHERE id = ?");
    if (!existing) {
      return res.status(404).json({ error: "Pickup not found" });
    }

    const { vendor_id, items, payment_status } = req.body;
    const safeVendorId = Number(vendor_id ?? existing.vendor_id);
    const safePaymentStatus = String(payment_status ?? existing.payment_status ?? "UNPAID").trim().toUpperCase();
    const normalizedItems = Array.isArray(items) && items.length ? items : [{ product_id: req.body.product_id, quantity: req.body.quantity, unit_cost: req.body.unit_price }];

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
      const quantity = Number(item.entry_quantity ?? item.quantity);
      if (!productId || !Number.isFinite(quantity) || quantity <= 0) {
        throw new Error("Each pickup item must include a valid product and quantity");
      }
      const product = await dbGet(req.db, "SELECT id, selling_price, base_price, quantity_per_case FROM products WHERE id = $1", [productId]);
      if (!product) {
        throw new Error(`Product ${productId} not found`);
      }
      itemPayloads.push({ productId, ...deliveryQuantity(item, product), unitCost: Number(product.selling_price || 0), unitBasePrice: product.base_price ?? null });
    }

    let totalAmount = itemPayloads.reduce((sum, item) => sum + item.quantity * item.unitCost, 0);
    await withTransaction(req.db, async () => {
      const lockedDelivery = await dbGet(req.db,
        "SELECT id, vendor_id FROM deliveries WHERE id = $1 FOR UPDATE", [id],
        "SELECT id, vendor_id FROM deliveries WHERE id = ?");
      if (!lockedDelivery) throw new Error("Pickup not found");
      const deliveryReturns = await getDeliveryReturns(req.db, id);
      if (deliveryReturns.length && safeVendorId !== Number(lockedDelivery.vendor_id)) {
        throw new Error("Remove this pickup's returns before changing its vendor");
      }
      const returnedQuantities = new Map();
      for (const entry of deliveryReturns) {
        const productId = Number(entry.product_id);
        returnedQuantities.set(productId, (returnedQuantities.get(productId) || 0) + Number(entry.quantity));
      }
      for (const [productId, quantity] of returnedQuantities) {
        const deliveredQuantity = itemPayloads.filter((item) => item.productId === productId)
          .reduce((sum, item) => sum + item.quantity, 0);
        if (deliveredQuantity < quantity) {
          throw new Error(`Product ${productId} already has ${quantity} returned items; remove those returns before reducing its delivered quantity`);
        }
      }
      const previousItems = await dbAll(req.db,
        "SELECT product_id, quantity, unit_cost, unit_base_price FROM delivery_items WHERE delivery_id = $1", [id]);
      for (const item of itemPayloads) {
        const product = await dbGet(req.db,
          "SELECT id, active, deleted_at, selling_price, base_price FROM products WHERE id = $1 FOR UPDATE", [item.productId],
          "SELECT id, active, deleted_at, selling_price, base_price FROM products WHERE id = ?");
        if (!product) throw new Error(`Product ${item.productId} not found`);
        const originalLines = previousItems.filter((row) => Number(row.product_id) === item.productId);
        const originalCount = originalLines.reduce((sum, row) => sum + Number(row.quantity), 0);
        if (originalCount) {
          // Editing a delivery does not revalue its original price/cost using today's catalog.
          item.unitCost = originalLines.reduce((sum, row) => sum + Number(row.quantity) * Number(row.unit_cost), 0) / originalCount;
          item.unitBasePrice = originalLines.every((row) => row.unit_base_price != null)
            ? originalLines.reduce((sum, row) => sum + Number(row.quantity) * Number(row.unit_base_price), 0) / originalCount : null;
        } else {
          item.unitCost = Number(product.selling_price);
          item.unitBasePrice = product.base_price ?? null;
        }
        if (product.deleted_at || Number(product.active) !== 1) {
          const original = previousItems.filter((row) => Number(row.product_id) === item.productId);
          const originalQuantity = original.reduce((sum, row) => sum + Number(row.quantity), 0);
          const requestedQuantity = itemPayloads.filter((row) => row.productId === item.productId).reduce((sum, row) => sum + row.quantity, 0);
          if (!originalQuantity || requestedQuantity > originalQuantity) {
            throw new Error(`Removed product ${item.productId} can only retain or reduce its existing delivery quantity`);
          }
          // Preserve the historical price of removed products in old deliveries.
          item.unitCost = original.reduce((sum, row) => sum + Number(row.quantity) * Number(row.unit_cost), 0) / originalQuantity;
        }
      }
      totalAmount = itemPayloads.reduce((sum, item) => sum + item.quantity * item.unitCost, 0);
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
          isPostgresDb(req.db) ? [item.quantity, item.productId] : [item.quantity, item.productId, item.quantity],
          "UPDATE products SET current_stock = current_stock - ? WHERE id = ? AND current_stock >= ?"
        );
        if (!stockUpdate.changes) throw new Error(`Insufficient stock for product ${item.productId}`);
      }

      await dbRun(req.db, "DELETE FROM delivery_items WHERE delivery_id = $1 RETURNING id", [id], "DELETE FROM delivery_items WHERE delivery_id = ?");
      // An edit changes delivery contents, never the original recording time.
      await dbRun(req.db, "UPDATE deliveries SET vendor_id = $1, total_amount = $2 WHERE id = $3 RETURNING id", [safeVendorId, totalAmount, id], "UPDATE deliveries SET vendor_id = ?, total_amount = ? WHERE id = ?");

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
        await dbRun(req.db, "INSERT INTO delivery_items (delivery_id, product_id, quantity, unit_cost, unit_base_price, entry_unit, entry_quantity, case_size) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id", [id, item.productId, item.quantity, item.unitCost, item.unitBasePrice, item.entryUnit, item.entryQuantity, item.caseSize], "INSERT INTO delivery_items (delivery_id, product_id, quantity, unit_cost, unit_base_price, entry_unit, entry_quantity, case_size) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
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

router.post("/:id/confirm-payment", requireRole("ADMIN", "STAFF"), requireStaffDeliveryOwnership(), async (req, res) => {
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

router.delete("/:id", requireCurrentStaff, requireStaffDeliveryOwnership(), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const delivery = await dbGet(req.db, "SELECT id, vendor_id, total_amount FROM deliveries WHERE id = $1", [id], "SELECT id, vendor_id, total_amount FROM deliveries WHERE id = ?");
    if (!delivery) {
      return res.status(404).json({ error: "Pickup not found" });
    }

    await withTransaction(req.db, async () => {
      const lockedDelivery = await dbGet(req.db,
        "SELECT id FROM deliveries WHERE id = $1 FOR UPDATE", [id],
        "SELECT id FROM deliveries WHERE id = ?");
      if (!lockedDelivery) throw new Error("Pickup not found");
      if ((await getDeliveryReturns(req.db, id)).length) {
        throw new Error("Remove this pickup's returns before deleting the pickup to avoid restocking returned items twice");
      }
      const items = await dbAll(req.db,
        "SELECT product_id, quantity FROM delivery_items WHERE delivery_id = $1", [id]);
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
