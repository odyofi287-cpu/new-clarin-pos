import express from "express";
import { requireRole } from "../middleware/auth.js";
import { publishDataChange } from "../events.js";
import { dbAll, dbGet, dbRun, isInMemoryDb, isPostgresDb, withTransaction } from "./dbCompat.js";
import { getBusinessDate } from "../businessDate.js";
import { money } from "../productEconomics.js";

const router = express.Router();

router.get("/", requireRole("ADMIN", "STAFF"), async (req, res) => {
  try {
    if (isInMemoryDb(req.db)) {
      const sales = req.db.sales
        .slice()
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .map((sale) => {
          const items = req.db.sale_items.filter((item) => item.sale_id === sale.id);
          const user = req.db.users.find((entry) => entry.id === sale.user_id);
          return {
            id: sale.id,
            sale_date: sale.sale_date,
            sold_by: user?.name || "Unknown",
            items: items.map((item) => {
              const product = req.db.products.find((entry) => entry.id === item.product_id);
              return `${product?.name || "Unknown"} (${item.quantity})`;
            }).join(", "),
            item_count: items.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
            total_amount: sale.total_amount,
          };
        });
      return res.json({ data: sales });
    }

    const sales = await dbAll(
      req.db,
      `SELECT s.id, s.sale_date, s.total_amount, u.name AS sold_by,
              COALESCE(SUM(si.quantity), 0) AS item_count,
              COALESCE(STRING_AGG(p.name || ' (' || si.quantity || ')', ', '), '') AS items
         FROM sales s
         LEFT JOIN users u ON u.id = s.user_id
         LEFT JOIN sale_items si ON si.sale_id = s.id
         LEFT JOIN products p ON p.id = si.product_id
        GROUP BY s.id, s.sale_date, s.total_amount, s.created_at, u.name
        ORDER BY s.sale_date DESC, s.created_at DESC`,
      [],
      `SELECT s.id, s.sale_date, s.total_amount, u.name AS sold_by,
              COALESCE(SUM(si.quantity), 0) AS item_count,
              COALESCE(GROUP_CONCAT(p.name || ' (' || si.quantity || ')', ', '), '') AS items
         FROM sales s
         LEFT JOIN users u ON u.id = s.user_id
         LEFT JOIN sale_items si ON si.sale_id = s.id
         LEFT JOIN products p ON p.id = si.product_id
        GROUP BY s.id
        ORDER BY s.sale_date DESC, s.created_at DESC`
    );
    res.json({ data: sales });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load sales history" });
  }
});

router.post("/", requireRole("ADMIN", "STAFF"), async (req, res) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length) {
      return res.status(400).json({ error: "Sale items are required" });
    }

    const cart = items
      .map((item) => ({
        product_id: Number(item.product_id),
        quantity: Number(item.quantity),
      }))
      .filter((item) => item.product_id > 0 && item.quantity > 0)
      .reduce((acc, item) => {
        const existing = acc.find((row) => row.product_id === item.product_id);
        if (existing) {
          existing.quantity += item.quantity;
        } else {
          acc.push(item);
        }
        return acc;
      }, []);

    if (!cart.length || cart.some((item) => !Number.isSafeInteger(item.quantity))) {
      return res.status(400).json({ error: "At least one valid sale item is required" });
    }

    const products = [];
    for (const item of cart) {
      const product = await dbGet(req.db, "SELECT id, name, selling_price, base_price, current_stock, active, deleted_at FROM products WHERE id = $1", [item.product_id]);
      if (!product) {
        throw new Error(`Product not found: ${item.product_id}`);
      }
      if (product.deleted_at || Number(product.active) !== 1) return res.status(400).json({ error: `Product is no longer available for sale: ${product.name}` });
      products.push({ ...product, sellQuantity: item.quantity });
    }

    let totalAmount;
    const saleDate = getBusinessDate();

    const saleResult = await withTransaction(req.db, async () => {
      for (const product of [...products].sort((a, b) => a.id - b.id)) {
        const snapshot = await dbGet(req.db, "SELECT id, name, selling_price, base_price, active, deleted_at FROM products WHERE id = $1 FOR UPDATE", [product.id], "SELECT id, name, selling_price, base_price, active, deleted_at FROM products WHERE id = ?");
        if (!snapshot || snapshot.deleted_at || Number(snapshot.active) !== 1) throw new Error(`Product not found: ${product.id}`);
        Object.assign(product, snapshot);
        const stockUpdate = await dbRun(req.db, "UPDATE products SET current_stock = current_stock - $1 WHERE id = $2 AND current_stock >= $1 AND active = 1 AND deleted_at IS NULL RETURNING id", isPostgresDb(req.db) ? [product.sellQuantity, product.id] : [product.sellQuantity, product.id, product.sellQuantity], "UPDATE products SET current_stock = current_stock - ? WHERE id = ? AND current_stock >= ? AND active = 1 AND deleted_at IS NULL");
        if (!stockUpdate.changes) {
          throw new Error(`Insufficient stock for ${product.name}`);
        }
      }
      totalAmount = money(products.reduce((sum, product) => sum + Number(product.selling_price) * product.sellQuantity, 0));

      const saleInsert = await dbRun(req.db, "INSERT INTO sales (sale_date, total_amount, user_id) VALUES ($1, $2, $3) RETURNING id", [saleDate, totalAmount, req.user.user_id || null], "INSERT INTO sales (sale_date, total_amount, user_id) VALUES (?, ?, ?)");
      const saleId = saleInsert.lastInsertRowid;

      for (const product of products) {
        await dbRun(req.db, "INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, unit_base_price) VALUES ($1, $2, $3, $4, $5) RETURNING id", [saleId, product.id, product.sellQuantity, product.selling_price, product.base_price ?? null], "INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, unit_base_price) VALUES (?, ?, ?, ?, ?)");

        await dbRun(req.db, "INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_type, reference_id, user_id, created_at) VALUES ($1, 'STOCK_OUT', $2, 'SALE', $3, $4, CURRENT_TIMESTAMP) RETURNING id", [product.id, product.sellQuantity, saleId, req.user.user_id || null], "INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_type, reference_id, user_id, created_at) VALUES (?, 'STOCK_OUT', ?, 'SALE', ?, ?, datetime('now'))");
      }

      return { saleId, totalAmount };
    });

    publishDataChange("sale");
    res.status(201).json({ data: { sale_id: saleResult.saleId, total_amount: saleResult.totalAmount } });
  } catch (error) {
    console.error(error);
    if (error.message && (error.message.startsWith("Product not found") || error.message.startsWith("Insufficient stock"))) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: "Failed to process sale" });
  }
});

export default router;
