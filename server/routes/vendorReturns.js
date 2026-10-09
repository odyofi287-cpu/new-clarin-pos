import express from "express";
import { randomUUID } from "node:crypto";
import { requireRole } from "../middleware/auth.js";
import { publishDataChange } from "../events.js";
import { dbAll, dbGet, dbRun, isInMemoryDb, withTransaction } from "./dbCompat.js";
import { getBusinessDate } from "../businessDate.js";
import { restockVendorReturn, reverseVendorReturnStock } from "./returnInventory.js";

const router = express.Router();

function groupReturnRows(rows) {
  const groups = new Map();

  for (const row of rows) {
    const groupId = row.return_batch_id || `legacy-${row.id}`;
    const group = groups.get(groupId) || {
      id: Number(row.id),
      return_batch_id: row.return_batch_id || null,
      delivery_id: row.delivery_id || null,
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
    group.id = Math.min(Number(group.id), Number(row.id));
    groups.set(groupId, group);
  }

  return [...groups.values()].map((group) => ({
    ...group,
    return_code: `RTN-${String(group.id).padStart(4, "0")}`,
    return_ids: group.return_ids.sort((a, b) => Number(a) - Number(b)),
  }));
}

function getDateKey(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const match = String(value || "").match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : "";
}

async function getVendorDeliveryOptions(db, vendorId, businessDate = getBusinessDate()) {
  if (isInMemoryDb(db)) {
    return db.deliveries
      .filter((delivery) => Number(delivery.vendor_id) === Number(vendorId)
        && getDateKey(delivery.delivery_date) === businessDate)
      .map((delivery) => {
        const deliveryItems = db.delivery_items.filter((item) => Number(item.delivery_id) === Number(delivery.id));
        const deliveryReturns = db.vendor_returns.filter((entry) => Number(entry.delivery_id) === Number(delivery.id));
        const returnDeduction = deliveryReturns.reduce((sum, entry) => sum + Number(entry.total_product_price_returned || 0), 0);
        const originalAmount = Number(delivery.total_amount || 0);
        return {
          ...delivery,
          original_amount: originalAmount,
          return_deduction: returnDeduction,
          amount_due: Math.max(originalAmount - returnDeduction, 0),
          item_count: deliveryItems.length,
          items: deliveryItems.map((item) => `${db.products.find((product) => Number(product.id) === Number(item.product_id))?.name || "Unknown"} (${item.quantity})`).join(", "),
          payment_status: String(delivery.payment_status || "UNPAID").toUpperCase(),
          returnable: String(delivery.payment_status || "UNPAID").toUpperCase() !== "PAID",
        };
      })
      .sort((a, b) => `${b.delivery_time || ""}-${b.id}`.localeCompare(`${a.delivery_time || ""}-${a.id}`));
  }

  const rows = await dbAll(
    db,
    `SELECT d.id, d.vendor_id, d.delivery_date, d.delivery_time, d.total_amount AS original_amount,
            COALESCE(d.payment_status, 'UNPAID') AS payment_status,
            COALESCE(r.return_deduction, 0) AS return_deduction,
            COALESCE(i.item_count, 0) AS item_count,
            COALESCE(i.items, '') AS items
     FROM deliveries d
     LEFT JOIN (
       SELECT delivery_id, SUM(total_product_price_returned) AS return_deduction
       FROM vendor_returns WHERE delivery_id IS NOT NULL GROUP BY delivery_id
     ) r ON r.delivery_id = d.id
     LEFT JOIN (
       SELECT di.delivery_id, COUNT(*) AS item_count,
              STRING_AGG(p.name || ' (' || di.quantity::text || ')', ', ' ORDER BY p.name) AS items
       FROM delivery_items di JOIN products p ON p.id = di.product_id
       GROUP BY di.delivery_id
     ) i ON i.delivery_id = d.id
     WHERE d.vendor_id = $1 AND d.delivery_date = $2
     ORDER BY d.delivery_time DESC NULLS LAST, d.id DESC`,
    [vendorId, businessDate],
    `SELECT d.id, d.vendor_id, d.delivery_date, d.delivery_time, d.total_amount AS original_amount,
            COALESCE(d.payment_status, 'UNPAID') AS payment_status,
            COALESCE(r.return_deduction, 0) AS return_deduction,
            COALESCE(i.item_count, 0) AS item_count,
            COALESCE(i.items, '') AS items
     FROM deliveries d
     LEFT JOIN (
       SELECT delivery_id, SUM(total_product_price_returned) AS return_deduction
       FROM vendor_returns WHERE delivery_id IS NOT NULL GROUP BY delivery_id
     ) r ON r.delivery_id = d.id
     LEFT JOIN (
       SELECT di.delivery_id, COUNT(*) AS item_count,
              GROUP_CONCAT(p.name || ' (' || di.quantity || ')', ', ') AS items
       FROM delivery_items di JOIN products p ON p.id = di.product_id
       GROUP BY di.delivery_id
     ) i ON i.delivery_id = d.id
     WHERE d.vendor_id = ? AND d.delivery_date = ?
     ORDER BY d.delivery_time DESC, d.id DESC`
  );

  return rows.map((delivery) => {
    const originalAmount = Number(delivery.original_amount || 0);
    const returnDeduction = Number(delivery.return_deduction || 0);
    const paymentStatus = String(delivery.payment_status || "UNPAID").toUpperCase();
    return {
      ...delivery,
      original_amount: originalAmount,
      return_deduction: returnDeduction,
      amount_due: Math.max(originalAmount - returnDeduction, 0),
      item_count: Number(delivery.item_count || 0),
      payment_status: paymentStatus,
      returnable: paymentStatus !== "PAID",
    };
  });
}

async function getVendorReturnableProducts(db, vendorId, deliveryId, businessDate = getBusinessDate()) {
  if (isInMemoryDb(db)) {
    const delivery = db.deliveries.find((entry) => Number(entry.id) === Number(deliveryId)
      && Number(entry.vendor_id) === Number(vendorId)
      && getDateKey(entry.delivery_date) === businessDate
      && String(entry.payment_status || "UNPAID").toUpperCase() !== "PAID");
    if (!delivery) return [];
    const deliveredByProduct = new Map();
    const costByProduct = new Map();
    const returnedByProduct = new Map();

    for (const item of db.delivery_items) {
      if (Number(item.delivery_id) !== Number(deliveryId)) continue;
      const productId = Number(item.product_id);
      deliveredByProduct.set(productId, (deliveredByProduct.get(productId) || 0) + Number(item.quantity || 0));
      costByProduct.set(productId, (costByProduct.get(productId) || 0) + (Number(item.quantity || 0) * Number(item.unit_cost || 0)));
    }
    for (const entry of db.vendor_returns) {
      if (Number(entry.delivery_id) !== Number(deliveryId)) continue;
      const productId = Number(entry.product_id);
      returnedByProduct.set(productId, (returnedByProduct.get(productId) || 0) + Number(entry.quantity || 0));
    }

    return [...deliveredByProduct.entries()]
      .map(([productId, deliveredQuantity]) => {
        const product = db.products.find((entry) => Number(entry.id) === productId);
        const returnedQuantity = returnedByProduct.get(productId) || 0;
        return product ? {
          ...product,
          selling_price: deliveredQuantity > 0 ? (costByProduct.get(productId) || 0) / deliveredQuantity : Number(product.selling_price || 0),
          image_url: product.image_url || null,
          delivered_quantity: deliveredQuantity,
          returned_quantity: returnedQuantity,
          returnable_quantity: Math.max(deliveredQuantity - returnedQuantity, 0),
        } : null;
      })
      .filter((product) => product && product.returnable_quantity > 0)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  const rows = await dbAll(
    db,
    `SELECT p.id, p.name, p.category, p.image_url, p.selling_price, p.current_stock, p.minimum_stock, p.unit, p.active,
            delivered.delivered_quantity, delivered.unit_cost,
            COALESCE(returned.returned_quantity, 0) AS returned_quantity
     FROM (
       SELECT di.product_id, SUM(di.quantity) AS delivered_quantity,
              CASE WHEN SUM(di.quantity) > 0 THEN SUM(di.quantity * di.unit_cost) / SUM(di.quantity) ELSE 0 END AS unit_cost
       FROM deliveries d
       JOIN delivery_items di ON di.delivery_id = d.id
       WHERE d.id = $1
         AND d.vendor_id = $2
         AND d.delivery_date = $3
         AND UPPER(COALESCE(d.payment_status, 'UNPAID')) <> 'PAID'
       GROUP BY di.product_id
     ) delivered
     JOIN products p ON p.id = delivered.product_id
     LEFT JOIN (
       SELECT product_id, SUM(quantity) AS returned_quantity
       FROM vendor_returns
       WHERE delivery_id = $4
       GROUP BY product_id
     ) returned ON returned.product_id = delivered.product_id
     ORDER BY p.name ASC`,
    [deliveryId, vendorId, businessDate, deliveryId],
    `SELECT p.id, p.name, p.category, p.image_url, p.selling_price, p.current_stock, p.minimum_stock, p.unit, p.active,
            delivered.delivered_quantity, delivered.unit_cost,
            COALESCE(returned.returned_quantity, 0) AS returned_quantity
     FROM (
       SELECT di.product_id, SUM(di.quantity) AS delivered_quantity,
              CASE WHEN SUM(di.quantity) > 0 THEN SUM(di.quantity * di.unit_cost) / SUM(di.quantity) ELSE 0 END AS unit_cost
       FROM deliveries d
       JOIN delivery_items di ON di.delivery_id = d.id
       WHERE d.id = ?
         AND d.vendor_id = ?
         AND d.delivery_date = ?
         AND UPPER(COALESCE(d.payment_status, 'UNPAID')) <> 'PAID'
       GROUP BY di.product_id
     ) delivered
     JOIN products p ON p.id = delivered.product_id
     LEFT JOIN (
       SELECT product_id, SUM(quantity) AS returned_quantity
       FROM vendor_returns
       WHERE delivery_id = ?
       GROUP BY product_id
     ) returned ON returned.product_id = delivered.product_id
     ORDER BY p.name ASC`
  );

  return rows
    .map((product) => {
      const deliveredQuantity = Number(product.delivered_quantity || 0);
      const returnedQuantity = Number(product.returned_quantity || 0);
      return {
        ...product,
        selling_price: Number(product.unit_cost ?? product.selling_price ?? 0),
        delivered_quantity: deliveredQuantity,
        returned_quantity: returnedQuantity,
        returnable_quantity: Math.max(deliveredQuantity - returnedQuantity, 0),
      };
    })
    .filter((product) => product.returnable_quantity > 0);
}

router.get("/", requireRole("ADMIN", "STAFF", "VENDOR"), async (req, res) => {
  try {
    let sql = `
      SELECT vr.id, vr.return_batch_id, vr.delivery_id, vr.vendor_id, v.name AS vendor_name, vr.product_id, p.name AS product_name,
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
      SELECT vr.id, vr.return_batch_id, vr.delivery_id, vr.vendor_id, v.name AS vendor_name, vr.product_id, p.name AS product_name,
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

router.get("/eligible-deliveries", requireRole("ADMIN", "STAFF", "VENDOR"), async (req, res) => {
  try {
    const vendorId = Number(req.query.vendor_id);
    if (!Number.isInteger(vendorId) || vendorId <= 0) {
      return res.status(400).json({ error: "A valid vendor is required" });
    }
    if (req.user.role === "VENDOR" && Number(req.user.vendor_id) !== vendorId) {
      return res.status(403).json({ error: "You can only view deliveries for your own vendor account" });
    }

    const vendor = await dbGet(req.db, "SELECT id FROM vendors WHERE id = $1", [vendorId], "SELECT id FROM vendors WHERE id = ?");
    if (!vendor) return res.status(404).json({ error: "Vendor not found" });

    const businessDate = getBusinessDate();
    const deliveries = await getVendorDeliveryOptions(req.db, vendorId, businessDate);
    res.json({ data: deliveries, business_date: businessDate });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load today's deliveries for this vendor" });
  }
});

router.get("/eligible-products", requireRole("ADMIN", "STAFF", "VENDOR"), async (req, res) => {
  try {
    const vendorId = Number(req.query.vendor_id);
    const deliveryId = Number(req.query.delivery_id);
    if (!Number.isInteger(vendorId) || vendorId <= 0) {
      return res.status(400).json({ error: "A valid vendor is required" });
    }
    if (!Number.isInteger(deliveryId) || deliveryId <= 0) {
      return res.status(400).json({ error: "Select a valid delivery before loading products" });
    }
    if (req.user.role === "VENDOR" && Number(req.user.vendor_id) !== vendorId) {
      return res.status(403).json({ error: "You can only view products delivered to your own vendor account" });
    }

    const vendor = await dbGet(req.db, "SELECT id FROM vendors WHERE id = $1", [vendorId], "SELECT id FROM vendors WHERE id = ?");
    if (!vendor) {
      return res.status(404).json({ error: "Vendor not found" });
    }

    const businessDate = getBusinessDate();
    const delivery = await dbGet(
      req.db,
      "SELECT id, vendor_id, delivery_date, payment_status FROM deliveries WHERE id = $1",
      [deliveryId],
      "SELECT id, vendor_id, delivery_date, payment_status FROM deliveries WHERE id = ?"
    );
    if (!delivery || Number(delivery.vendor_id) !== vendorId || getDateKey(delivery.delivery_date) !== businessDate) {
      return res.status(404).json({ error: "The selected delivery is not available for this vendor today" });
    }
    if (String(delivery.payment_status || "UNPAID").toUpperCase() === "PAID") {
      return res.status(400).json({ error: "Paid deliveries are closed and cannot accept returns" });
    }

    const products = await getVendorReturnableProducts(req.db, vendorId, deliveryId, businessDate);
    res.json({ data: products, business_date: businessDate, delivery_id: deliveryId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load delivered products for this vendor" });
  }
});

router.post("/", requireRole("ADMIN", "STAFF"), async (req, res) => {
  try {
    const {
      vendor_id,
      delivery_id,
      return_date,
      return_time,
    } = req.body;

    const vendorId = Number(vendor_id);
    const deliveryId = Number(delivery_id);
    const requestedItems = Array.isArray(req.body.items) && req.body.items.length
      ? req.body.items
      : [{
          product_id: req.body.product_id,
          quantity: req.body.quantity,
          total_product_price_returned: req.body.total_product_price_returned,
        }];

    if (!vendorId || !deliveryId || !requestedItems.length) {
      return res.status(400).json({ error: "Vendor, delivery, and at least one returned product are required" });
    }
    if (!return_date) {
      return res.status(400).json({ error: "Return date is required" });
    }
    if (!return_time) {
      return res.status(400).json({ error: "Return time is required" });
    }
    const businessDate = getBusinessDate();
    if (getDateKey(return_date) !== businessDate) {
      return res.status(400).json({ error: `Returns can only be recorded for today's deliveries (${businessDate})` });
    }
    const vendor = await dbGet(req.db, "SELECT id, name FROM vendors WHERE id = $1", [vendorId], "SELECT id, name FROM vendors WHERE id = ?");
    if (!vendor) {
      return res.status(404).json({ error: "Vendor not found" });
    }
    if (req.user.role === "VENDOR" && Number(req.user.vendor_id) !== vendorId) {
      return res.status(403).json({ error: "You can only record returns for your own vendor profile" });
    }
    const delivery = await dbGet(
      req.db,
      "SELECT id, vendor_id, delivery_date, payment_status FROM deliveries WHERE id = $1",
      [deliveryId],
      "SELECT id, vendor_id, delivery_date, payment_status FROM deliveries WHERE id = ?"
    );
    if (!delivery || Number(delivery.vendor_id) !== vendorId || getDateKey(delivery.delivery_date) !== businessDate) {
      return res.status(400).json({ error: "The selected delivery does not belong to this vendor's current-day account" });
    }
    if (String(delivery.payment_status || "UNPAID").toUpperCase() === "PAID") {
      return res.status(400).json({ error: "Paid deliveries are closed and cannot accept returns" });
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
      if (!isInMemoryDb(req.db)) {
        const lockedDelivery = await dbGet(
          req.db,
          "SELECT id, vendor_id, delivery_date, payment_status FROM deliveries WHERE id = $1 FOR UPDATE",
          [deliveryId],
          "SELECT id, vendor_id, delivery_date, payment_status FROM deliveries WHERE id = ?"
        );
        if (!lockedDelivery
          || Number(lockedDelivery.vendor_id) !== vendorId
          || getDateKey(lockedDelivery.delivery_date) !== businessDate
          || String(lockedDelivery.payment_status || "UNPAID").toUpperCase() === "PAID") {
          throw new Error("The selected delivery is no longer available for returns");
        }
      }

      const eligibleProducts = await getVendorReturnableProducts(req.db, vendorId, deliveryId, businessDate);
      const eligibleById = new Map(eligibleProducts.map((product) => [Number(product.id), product]));
      const requestedByProduct = new Map();
      for (const item of returnItems) {
        requestedByProduct.set(item.productId, (requestedByProduct.get(item.productId) || 0) + item.qty);
      }
      for (const [productId, requestedQuantity] of requestedByProduct) {
        const eligibleProduct = eligibleById.get(productId);
        if (!eligibleProduct) {
          const product = returnItems.find((item) => item.productId === productId)?.product;
          throw new Error(`${product?.name || `Product ${productId}`} has no delivered units available for return from this vendor`);
        }
        if (requestedQuantity > Number(eligibleProduct.returnable_quantity || 0)) {
          throw new Error(`Only ${eligibleProduct.returnable_quantity} delivered ${eligibleProduct.unit || "units"} of ${eligibleProduct.name} remain available for return`);
        }
        for (const item of returnItems.filter((entry) => entry.productId === productId)) {
          item.totalPrice = Number(eligibleProduct.selling_price || 0) * item.qty;
        }
      }

      const rows = [];
      for (const item of [...returnItems].sort((a, b) => a.productId - b.productId)) {
        const result = await dbRun(
          req.db,
          `INSERT INTO vendor_returns (vendor_id, delivery_id, product_id, quantity, total_product_price_returned, return_date, return_time, created_by, return_batch_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
          [vendorId, deliveryId, item.productId, item.qty, item.totalPrice, return_date, return_time, req.user.user_id || req.user.id, returnBatchId],
          `INSERT INTO vendor_returns (vendor_id, delivery_id, product_id, quantity, total_product_price_returned, return_date, return_time, created_by, return_batch_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        await restockVendorReturn(req.db, {
          id: result.lastInsertRowid,
          product_id: item.productId,
          quantity: item.qty,
        }, req.user.user_id || req.user.id);
        rows.push({
          id: result.lastInsertRowid,
          vendor_id: vendorId,
          delivery_id: deliveryId,
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
    const primaryReturnId = Math.min(...createdReturns.map((item) => Number(item.id)));
    res.status(201).json({
      data: {
        id: primaryReturnId,
        return_id: primaryReturnId,
        delivery_id: deliveryId,
        return_code: `RTN-${String(primaryReturnId).padStart(4, "0")}`,
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

async function removeReturns(db, field, value, userId) {
  return await withTransaction(db, async () => {
    // Lock the return rows so concurrent removal requests cannot reverse the
    // same stock-in twice. The caller selects only fixed, internal field names.
    const entries = isInMemoryDb(db)
      ? db.vendor_returns.filter((entry) => entry[field] === value)
      : await dbAll(db,
          `SELECT id, product_id, quantity FROM vendor_returns WHERE ${field} = $1 ORDER BY id FOR UPDATE`,
          [value],
          `SELECT id, product_id, quantity FROM vendor_returns WHERE ${field} = ? ORDER BY id`
        );
    if (!entries.length) {
      const error = new Error("Vendor return not found");
      error.status = 404;
      throw error;
    }
    for (const entry of [...entries].sort((a, b) => Number(a.product_id) - Number(b.product_id) || Number(a.id) - Number(b.id))) {
      await reverseVendorReturnStock(db, entry, userId);
    }
    return await dbRun(db,
      `DELETE FROM vendor_returns WHERE ${field} = $1 RETURNING id`,
      [value],
      `DELETE FROM vendor_returns WHERE ${field} = ?`
    );
  });
}

router.delete("/batch/:batchId", requireRole("ADMIN", "STAFF"), async (req, res) => {
  try {
    const batchId = String(req.params.batchId || "").trim();
    if (!batchId) {
      return res.status(400).json({ error: "Return batch ID is required" });
    }

    const result = await removeReturns(req.db, "return_batch_id", batchId, req.user.user_id || req.user.id);
    publishDataChange("vendor-return");
    res.json({ data: { deleted: true, return_batch_id: batchId, count: result.changes } });
  } catch (error) {
    console.error(error);
    res.status(error.status || 400).json({ error: error.message || "Failed to remove vendor return batch" });
  }
});

router.delete("/:id", requireRole("ADMIN", "STAFF"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    await removeReturns(req.db, "id", id, req.user.user_id || req.user.id);

    publishDataChange("vendor-return");
    res.json({ data: { deleted: true, id } });
  } catch (error) {
    console.error(error);
    res.status(error.status || 400).json({ error: error.message || "Failed to remove vendor return" });
  }
});

export default router;
