import express from "express";
import { requireRole } from "../middleware/auth.js";
import { publishDataChange } from "../events.js";

const router = express.Router();

router.post("/", requireRole("SUPERADMIN", "ADMIN", "STAFF"), (req, res) => {
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

    if (!cart.length) {
      return res.status(400).json({ error: "At least one valid sale item is required" });
    }

    const products = cart.map((item) => {
      const product = req.db.prepare("SELECT id, name, selling_price, current_stock FROM products WHERE id = ?").get(item.product_id);
      if (!product) {
        throw new Error(`Product not found: ${item.product_id}`);
      }
      return { ...product, sellQuantity: item.quantity };
    });

    const totalAmount = products.reduce((sum, product) => sum + product.selling_price * product.sellQuantity, 0);
    const saleDate = new Date().toISOString().split("T")[0];

    const executeTransaction = (fn) => {
      if (req.db && typeof req.db.transaction === "function") {
        const tx = req.db.transaction(fn);
        return typeof tx === "function" ? tx() : fn();
      }
      return fn();
    };

    const saleResult = executeTransaction(() => {
      for (const product of products) {
        const stockUpdate = req.db.prepare(
          "UPDATE products SET current_stock = current_stock - ? WHERE id = ? AND current_stock >= ?"
        ).run(product.sellQuantity, product.id, product.sellQuantity);
        if (!stockUpdate.changes) {
          throw new Error(`Insufficient stock for ${product.name}`);
        }
      }

      const saleInsert = req.db.prepare(
        "INSERT INTO sales (sale_date, total_amount, user_id) VALUES (?, ?, ?)"
      ).run(saleDate, totalAmount, req.user.user_id || null);
      const saleId = saleInsert.lastInsertRowid || saleInsert.lastInsertRowid;

      products.forEach((product) => {
        req.db.prepare(
          "INSERT INTO sale_items (sale_id, product_id, quantity, unit_price) VALUES (?, ?, ?, ?)"
        ).run(saleId, product.id, product.sellQuantity, product.selling_price);

        req.db.prepare(
          "INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_type, reference_id, user_id, created_at) VALUES (?, 'STOCK_OUT', ?, 'SALE', ?, ?, datetime('now'))"
        ).run(product.id, product.sellQuantity, saleId, req.user.user_id || null);
      });

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
