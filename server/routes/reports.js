import express from "express";
import { requireRole } from "../middleware/auth.js";
import { dbAll, isInMemoryDb } from "./dbCompat.js";

const router = express.Router();

function getTodayString() {
  return new Date().toISOString().split("T")[0];
}

function dateRange(req) {
  const start = req.query.start_date || "0000-01-01";
  const end = req.query.end_date || "9999-12-31";
  return { start, end };
}

function normalizeReportDate(value) {
  const text = String(value || "").trim();
  const isoDate = text.match(/^\d{4}-\d{2}-\d{2}/);
  return isoDate ? isoDate[0] : text;
}

function escapeCsv(value) {
  if (value == null) return "";
  const stringValue = String(value);
  if (/[",\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

function toCsv(rows, headers) {
  const lines = [headers.map((h) => escapeCsv(h.label)).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCsv(Object.prototype.hasOwnProperty.call(row, h.key) ? row[h.key] : "")).join(","));
  }
  return lines.join("\n");
}

router.get("/sales", requireRole("SUPERADMIN", "ADMIN", "STAFF"), async (req, res) => {
  try {
    const { start, end } = dateRange(req);
    if (isInMemoryDb(req.db)) {
      const sales = req.db.sales
        .filter((sale) => sale.sale_date >= start && sale.sale_date <= end)
        .slice()
        .sort((a, b) => b.sale_date.localeCompare(a.sale_date))
        .map((sale) => {
          const items = req.db.sale_items
            .filter((item) => item.sale_id === sale.id)
            .map((item) => {
              const product = req.db.products.find((p) => p.id === item.product_id);
              return `${product?.name || "Unknown"} (${item.quantity})`;
            });
          const quantity = req.db.sale_items
            .filter((item) => item.sale_id === sale.id)
            .reduce((sum, item) => sum + item.quantity, 0);
          const staff = req.db.users.find((u) => u.id === sale.user_id)?.name || "Unknown";
          return {
            transaction_id: sale.id,
            sale_date: sale.sale_date,
            staff,
            items: items.join(", "),
            quantity,
            total_amount: sale.total_amount,
          };
        });
      return res.json({ data: sales });
    }

    const rows = await dbAll(
      req.db,
      `SELECT s.id AS transaction_id, s.sale_date, u.name AS staff,
        COALESCE(STRING_AGG(p.name || ' (' || si.quantity::text || ')', ', ' ORDER BY p.name), '') AS items,
        COALESCE(SUM(si.quantity), 0) AS quantity,
        s.total_amount
      FROM sales s
      LEFT JOIN sale_items si ON si.sale_id = s.id
      LEFT JOIN products p ON p.id = si.product_id
      JOIN users u ON u.id = s.user_id
      WHERE s.sale_date BETWEEN $1 AND $2
      GROUP BY s.id, s.sale_date, u.name, s.total_amount
      ORDER BY s.sale_date DESC`,
      [start, end],
      `SELECT s.id AS transaction_id, s.sale_date, u.name AS staff,
        GROUP_CONCAT(p.name || ' (' || si.quantity || ')', ', ') AS items,
        COALESCE(SUM(si.quantity), 0) AS quantity,
        s.total_amount
      FROM sales s
      LEFT JOIN sale_items si ON si.sale_id = s.id
      LEFT JOIN products p ON p.id = si.product_id
      JOIN users u ON u.id = s.user_id
      WHERE s.sale_date BETWEEN ? AND ?
      GROUP BY s.id
      ORDER BY s.sale_date DESC`
    );

    res.json({ data: rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load sales report" });
  }
});

router.get("/sales/csv", requireRole("SUPERADMIN", "ADMIN", "STAFF"), async (req, res) => {
  try {
    const { start, end } = dateRange(req);
    let rows;
    if (isInMemoryDb(req.db)) {
      rows = req.db.sales
        .filter((sale) => sale.sale_date >= start && sale.sale_date <= end)
        .slice()
        .sort((a, b) => b.sale_date.localeCompare(a.sale_date))
        .map((sale) => {
          const saleItems = req.db.sale_items.filter((item) => item.sale_id === sale.id);
          return {
            transaction_id: sale.id,
            sale_date: sale.sale_date,
            staff: req.db.users.find((user) => user.id === sale.user_id)?.name || "Unknown",
            items: saleItems.map((item) => `${req.db.products.find((product) => product.id === item.product_id)?.name || "Unknown"} (${item.quantity})`).join(", "),
            quantity: saleItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
            total_amount: sale.total_amount,
          };
        });
    } else {
      rows = await dbAll(
        req.db,
          `SELECT s.id AS transaction_id, s.sale_date, u.name AS staff,
            COALESCE(STRING_AGG(p.name || ' (' || si.quantity::text || ')', ', ' ORDER BY p.name), '') AS items,
            COALESCE(SUM(si.quantity), 0) AS quantity,
            s.total_amount
          FROM sales s
          LEFT JOIN sale_items si ON si.sale_id = s.id
          LEFT JOIN products p ON p.id = si.product_id
          JOIN users u ON u.id = s.user_id
          WHERE s.sale_date BETWEEN $1 AND $2
          GROUP BY s.id, s.sale_date, u.name, s.total_amount
          ORDER BY s.sale_date DESC`,
        [start, end],
        `SELECT s.id AS transaction_id, s.sale_date, u.name AS staff,
            GROUP_CONCAT(p.name || ' (' || si.quantity || ')', ', ') AS items,
            COALESCE(SUM(si.quantity), 0) AS quantity,
            s.total_amount
          FROM sales s
          LEFT JOIN sale_items si ON si.sale_id = s.id
          LEFT JOIN products p ON p.id = si.product_id
          JOIN users u ON u.id = s.user_id
          WHERE s.sale_date BETWEEN ? AND ?
          GROUP BY s.id
          ORDER BY s.sale_date DESC`
      )
    }

    const csv = toCsv(rows, [
      { label: "Transaction ID", key: "transaction_id" },
      { label: "Date", key: "sale_date" },
      { label: "Staff", key: "staff" },
      { label: "Items", key: "items" },
      { label: "Quantity", key: "quantity" },
      { label: "Total", key: "total_amount" },
    ]);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="sales-report-${start}-${end}.csv"`);
    res.send(csv);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to export sales report" });
  }
});

router.get("/inventory", requireRole("SUPERADMIN", "ADMIN", "STAFF"), async (req, res) => {
  try {
    const { start, end } = dateRange(req);
    if (isInMemoryDb(req.db)) {
      const rows = req.db.products
        .filter((product) => Number(product.active ?? 1) === 1)
        .map((product) => {
          const movements = req.db.inventory_movements.filter(
            (movement) => movement.product_id === product.id && movement.created_at.slice(0, 10) >= start && movement.created_at.slice(0, 10) <= end
          );
          const stockIn = movements.filter((m) => m.movement_type === "STOCK_IN").reduce((sum, m) => sum + Number(m.quantity), 0);
          const stockOut = movements.filter((m) => m.movement_type === "STOCK_OUT").reduce((sum, m) => sum + Number(m.quantity), 0);
          const currentStock = Number(product.current_stock || 0);
          const minimumStock = Number(product.minimum_stock || 0);
          const status = currentStock <= 0 ? "OUT_OF_STOCK" : currentStock <= minimumStock ? "LOW_STOCK" : "OK";
          return {
            product: product.name,
            stock_in: stockIn,
            stock_out: stockOut,
            current_stock: currentStock,
            minimum_stock: minimumStock,
            stock_status: status,
          };
        })
        .sort((a, b) => a.product.localeCompare(b.product));
      return res.json({ data: rows });
    }

    const rows = await dbAll(
      req.db,
      `SELECT p.name AS product, 
        COALESCE(SUM(CASE WHEN im.movement_type = 'STOCK_IN' THEN im.quantity ELSE 0 END), 0) AS stock_in,
        COALESCE(SUM(CASE WHEN im.movement_type = 'STOCK_OUT' THEN im.quantity ELSE 0 END), 0) AS stock_out,
        p.current_stock,
        p.minimum_stock
      FROM products p
      LEFT JOIN inventory_movements im ON im.product_id = p.id AND DATE(im.created_at) BETWEEN $1 AND $2
      WHERE p.active = 1
      GROUP BY p.id, p.name, p.current_stock, p.minimum_stock
      ORDER BY p.name ASC`,
      [start, end],
      `SELECT p.name AS product, 
        COALESCE(SUM(CASE WHEN im.movement_type = 'STOCK_IN' THEN im.quantity ELSE 0 END), 0) AS stock_in,
        COALESCE(SUM(CASE WHEN im.movement_type = 'STOCK_OUT' THEN im.quantity ELSE 0 END), 0) AS stock_out,
        p.current_stock,
        p.minimum_stock
      FROM products p
      LEFT JOIN inventory_movements im ON im.product_id = p.id AND date(im.created_at) BETWEEN ? AND ?
      WHERE p.active = 1
      GROUP BY p.id
      ORDER BY p.name ASC`
    );

    const formatted = rows.map((row) => ({
      ...row,
      stock_status: row.current_stock <= 0 ? "OUT_OF_STOCK" : row.current_stock <= row.minimum_stock ? "LOW_STOCK" : "OK",
    }));
    res.json({ data: formatted });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load inventory report" });
  }
});

router.get("/inventory/csv", requireRole("SUPERADMIN", "ADMIN", "STAFF"), async (req, res) => {
  try {
    const { start, end } = dateRange(req);
    let rows;
    if (isInMemoryDb(req.db)) {
      rows = req.db.products
        .filter((product) => Number(product.active ?? 1) === 1)
        .map((product) => {
          const movements = req.db.inventory_movements.filter((movement) => movement.product_id === product.id && movement.created_at.slice(0, 10) >= start && movement.created_at.slice(0, 10) <= end);
          const stockIn = movements.filter((movement) => movement.movement_type === "STOCK_IN").reduce((sum, movement) => sum + Number(movement.quantity || 0), 0);
          const stockOut = movements.filter((movement) => movement.movement_type === "STOCK_OUT").reduce((sum, movement) => sum + Number(movement.quantity || 0), 0);
          const currentStock = Number(product.current_stock || 0);
          const minimumStock = Number(product.minimum_stock || 0);
          return {
            product: product.name,
            stock_in: stockIn,
            stock_out: stockOut,
            current_stock: currentStock,
            minimum_stock: minimumStock,
            stock_status: currentStock <= 0 ? "OUT_OF_STOCK" : currentStock <= minimumStock ? "LOW_STOCK" : "OK",
          };
        })
        .sort((a, b) => a.product.localeCompare(b.product));
    } else {
      rows = await dbAll(
        req.db,
          `SELECT p.name AS product, 
            COALESCE(SUM(CASE WHEN im.movement_type = 'STOCK_IN' THEN im.quantity ELSE 0 END), 0) AS stock_in,
            COALESCE(SUM(CASE WHEN im.movement_type = 'STOCK_OUT' THEN im.quantity ELSE 0 END), 0) AS stock_out,
            p.current_stock,
            p.minimum_stock
          FROM products p
          LEFT JOIN inventory_movements im ON im.product_id = p.id AND DATE(im.created_at) BETWEEN $1 AND $2
          WHERE p.active = 1
          GROUP BY p.id, p.name, p.current_stock, p.minimum_stock
          ORDER BY p.name ASC`,
        [start, end],
        `SELECT p.name AS product, 
            COALESCE(SUM(CASE WHEN im.movement_type = 'STOCK_IN' THEN im.quantity ELSE 0 END), 0) AS stock_in,
            COALESCE(SUM(CASE WHEN im.movement_type = 'STOCK_OUT' THEN im.quantity ELSE 0 END), 0) AS stock_out,
            p.current_stock,
            p.minimum_stock
          FROM products p
          LEFT JOIN inventory_movements im ON im.product_id = p.id AND date(im.created_at) BETWEEN ? AND ?
          WHERE p.active = 1
          GROUP BY p.id
          ORDER BY p.name ASC`
      )
    }

    const formatted = rows.map((row) => ({
          ...row,
          stock_status: row.current_stock <= 0 ? "OUT_OF_STOCK" : row.current_stock <= row.minimum_stock ? "LOW_STOCK" : "OK",
        }));

    const csv = toCsv(formatted, [
      { label: "Product", key: "product" },
      { label: "Stock In", key: "stock_in" },
      { label: "Stock Out", key: "stock_out" },
      { label: "Current Stock", key: "current_stock" },
      { label: "Minimum Stock", key: "minimum_stock" },
      { label: "Stock Status", key: "stock_status" },
    ]);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="inventory-report-${start}-${end}.csv"`);
    res.send(csv);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to export inventory report" });
  }
});

router.get("/vendor-deliveries", requireRole("SUPERADMIN", "ADMIN", "STAFF", "VENDOR"), async (req, res) => {
  try {
    const { start, end } = dateRange(req);
    if (isInMemoryDb(req.db)) {
      let deliveries = req.db.deliveries.filter(
        (delivery) => delivery.delivery_date >= start && delivery.delivery_date <= end
      );
      if (req.user.role === "VENDOR") {
        deliveries = deliveries.filter((delivery) => delivery.vendor_id === req.user.vendor_id);
      }
      const rows = deliveries
        .slice()
        .sort((a, b) => b.delivery_date.localeCompare(a.delivery_date))
        .map((delivery) => {
          const items = req.db.delivery_items
            .filter((item) => item.delivery_id === delivery.id)
            .map((item) => {
              const product = req.db.products.find((p) => p.id === item.product_id);
              return `${product?.name || "Unknown"} (${item.quantity})`;
            });
          const vendor = req.db.vendors.find((v) => v.id === delivery.vendor_id);
          return {
            vendor: vendor?.name || "Unknown",
            delivery_date: normalizeReportDate(delivery.delivery_date),
            products: items.join(", "),
            quantity: req.db.delivery_items
              .filter((item) => item.delivery_id === delivery.id)
              .reduce((sum, item) => sum + item.quantity, 0),
            amount: delivery.total_amount,
          };
        });
      return res.json({ data: rows });
    }

    let sql = `SELECT v.name AS vendor, d.delivery_date, COALESCE(STRING_AGG(p.name || ' (' || di.quantity::text || ')', ', ' ORDER BY p.name), '') AS products, COALESCE(SUM(di.quantity), 0) AS quantity, d.total_amount AS amount
      FROM deliveries d
      JOIN vendors v ON v.id = d.vendor_id
      LEFT JOIN delivery_items di ON di.delivery_id = d.id
      LEFT JOIN products p ON p.id = di.product_id
      WHERE d.delivery_date BETWEEN $1 AND $2`;
    const params = [start, end];
    if (req.user.role === "VENDOR") {
      sql += ` AND d.vendor_id = $${params.length + 1}`;
      params.push(req.user.vendor_id);
    }
    sql += " GROUP BY d.id, v.name, d.delivery_date, d.total_amount ORDER BY d.delivery_date DESC";

    const sqliteSql = `SELECT v.name AS vendor, d.delivery_date, COALESCE(GROUP_CONCAT(p.name || ' (' || di.quantity || ')', ', '), '') AS products, COALESCE(SUM(di.quantity), 0) AS quantity, d.total_amount AS amount
      FROM deliveries d
      JOIN vendors v ON v.id = d.vendor_id
      LEFT JOIN delivery_items di ON di.delivery_id = d.id
      LEFT JOIN products p ON p.id = di.product_id
      WHERE d.delivery_date BETWEEN ? AND ?${req.user.role === "VENDOR" ? " AND d.vendor_id = ?" : ""}
      GROUP BY d.id ORDER BY d.delivery_date DESC`;

    const rows = await dbAll(req.db, sql, params, sqliteSql);
    res.json({ data: rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load vendor delivery report" });
  }
});

router.get("/vendor-deliveries/csv", requireRole("SUPERADMIN", "ADMIN", "STAFF", "VENDOR"), async (req, res) => {
  try {
    const { start, end } = dateRange(req);
    let rows;
    if (isInMemoryDb(req.db)) {
      let deliveries = req.db.deliveries.filter((delivery) => delivery.delivery_date >= start && delivery.delivery_date <= end);
      if (req.user.role === "VENDOR") deliveries = deliveries.filter((delivery) => delivery.vendor_id === req.user.vendor_id);
      rows = deliveries
        .slice()
        .sort((a, b) => b.delivery_date.localeCompare(a.delivery_date))
        .map((delivery) => {
          const items = req.db.delivery_items.filter((item) => item.delivery_id === delivery.id);
          return {
            vendor: req.db.vendors.find((vendor) => vendor.id === delivery.vendor_id)?.name || "Unknown",
            delivery_date: normalizeReportDate(delivery.delivery_date),
            products: items.map((item) => `${req.db.products.find((product) => product.id === item.product_id)?.name || "Unknown"} (${item.quantity})`).join(", "),
            quantity: items.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
            amount: delivery.total_amount,
          };
        });
    } else {
      const params = [start, end];
      let sql = `SELECT v.name AS vendor, d.delivery_date, COALESCE(STRING_AGG(p.name || ' (' || di.quantity::text || ')', ', ' ORDER BY p.name), '') AS products, COALESCE(SUM(di.quantity), 0) AS quantity, d.total_amount AS amount
      FROM deliveries d
      JOIN vendors v ON v.id = d.vendor_id
      LEFT JOIN delivery_items di ON di.delivery_id = d.id
      LEFT JOIN products p ON p.id = di.product_id
      WHERE d.delivery_date BETWEEN $1 AND $2`;
    if (req.user.role === "VENDOR") {
      sql += ` AND d.vendor_id = $${params.length + 1}`;
      params.push(req.user.vendor_id);
    }
    sql += " GROUP BY d.id, v.name, d.delivery_date, d.total_amount ORDER BY d.delivery_date DESC";
      rows = await dbAll(req.db, sql, params, `SELECT v.name AS vendor, d.delivery_date, COALESCE(GROUP_CONCAT(p.name || ' (' || di.quantity || ')', ', '), '') AS products, COALESCE(SUM(di.quantity), 0) AS quantity, d.total_amount AS amount
      FROM deliveries d
      JOIN vendors v ON v.id = d.vendor_id
      LEFT JOIN delivery_items di ON di.delivery_id = d.id
      LEFT JOIN products p ON p.id = di.product_id
      WHERE d.delivery_date BETWEEN ? AND ?${req.user.role === "VENDOR" ? " AND d.vendor_id = ?" : ""}
      GROUP BY d.id ORDER BY d.delivery_date DESC`);
    }
    const csv = toCsv(rows, [
      { label: "Vendor", key: "vendor" },
      { label: "Delivery Date", key: "delivery_date" },
      { label: "Products", key: "products" },
      { label: "Quantity", key: "quantity" },
      { label: "Amount", key: "amount" },
    ]);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="vendor-deliveries-report-${start}-${end}.csv"`);
    res.send(csv);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to export vendor delivery report" });
  }
});

export default router;
