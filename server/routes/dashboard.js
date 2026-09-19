import express from "express";
import { requireRole } from "../middleware/auth.js";
import { dbAll, dbGet, isInMemoryDb } from "./dbCompat.js";
import { getBusinessDate } from "../businessDate.js";

const router = express.Router();

function getTodayString() {
  return getBusinessDate();
}

function buildSalesCalendar(sales, deliveries, returns) {
  const today = new Date(`${getTodayString()}T00:00:00Z`);
  const daily = [];
  const monthly = [];
  const sumFor = (rows, dateKey, start, end) => rows
    .filter((row) => {
      const date = String(row[dateKey] || "").slice(0, 10);
      return start === end ? date === start : date >= start && date < end;
    })
    .reduce((sum, row) => sum + Number(row.total_amount ?? row.total_product_price_returned ?? 0), 0);

  for (let offset = 30; offset >= 0; offset -= 1) {
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() - offset);
    const key = date.toISOString().slice(0, 10);
    const recordedSales = sumFor(sales, "sale_date", key, key);
    const deliveriesTotal = sumFor(deliveries, "delivery_date", key, key);
    const returnsTotal = sumFor(returns, "return_date", key, key);
    daily.push({ period: key, recorded_sales: recordedSales, vendor_deliveries: deliveriesTotal, vendor_returns: returnsTotal, net_sales: recordedSales + deliveriesTotal - returnsTotal });
  }

  for (let offset = 11; offset >= 0; offset -= 1) {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - offset, 1));
    const key = date.toISOString().slice(0, 7);
    const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
    const recordedSales = sumFor(sales, "sale_date", `${key}-01`, next);
    const deliveriesTotal = sumFor(deliveries, "delivery_date", `${key}-01`, next);
    const returnsTotal = sumFor(returns, "return_date", `${key}-01`, next);
    monthly.push({ period: key, recorded_sales: recordedSales, vendor_deliveries: deliveriesTotal, vendor_returns: returnsTotal, net_sales: recordedSales + deliveriesTotal - returnsTotal });
  }

  return { daily, monthly };
}

router.get("/", requireRole("SUPERADMIN", "ADMIN", "STAFF", "VENDOR"), async (req, res) => {
  try {
    if (req.user.role === "VENDOR") {
      return await vendorDashboard(req, res);
    }
    return await operationalDashboard(req, res);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load dashboard" });
  }
});

async function operationalDashboard(req, res) {
  const today = getTodayString();

  if (isInMemoryDb(req.db)) {
    const salesToday = req.db.sales.filter((sale) => sale.sale_date === today);
    const transactionCount = salesToday.length;
    const totalSales = salesToday.reduce((sum, sale) => sum + sale.total_amount, 0);
    const deliveriesToday = req.db.deliveries.filter((delivery) => delivery.delivery_date === today);
    const totalDeliveries = deliveriesToday.reduce((sum, delivery) => sum + Number(delivery.total_amount || 0), 0);
    const returnsToday = req.db.vendor_returns.filter((entry) => entry.return_date === today);
    const totalReturns = returnsToday.reduce((sum, entry) => sum + Number(entry.total_product_price_returned || 0), 0);
    const calculatedSales = totalSales + totalDeliveries - totalReturns;
    const salesCalendar = buildSalesCalendar(req.db.sales, req.db.deliveries, req.db.vendor_returns);
    const itemsSold = req.db.sale_items
      .filter((item) => salesToday.some((sale) => sale.id === item.sale_id))
      .reduce((sum, item) => sum + item.quantity, 0);

    const activeProducts = req.db.products.filter((p) => Number(p.active ?? 1) === 1);
    const totalCurrentInventory = activeProducts.reduce((sum, p) => sum + Number(p.current_stock || 0), 0);
    const lowStockProducts = activeProducts
      .filter((p) => Number(p.current_stock || 0) > 0 && Number(p.current_stock || 0) <= 10)
      .sort((a, b) => a.current_stock - b.current_stock);
    const outOfStockCount = activeProducts.filter((p) => Number(p.current_stock || 0) <= 0).length;

    const recentSales = req.db.sales
      .slice()
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 5)
      .map((sale) => {
        const items = req.db.sale_items.filter((item) => item.sale_id === sale.id);
        const user = req.db.users.find((u) => u.id === sale.user_id);
        return {
          id: sale.id,
          sale_date: sale.sale_date,
          total_amount: sale.total_amount,
          item_count: items.reduce((sum, item) => sum + item.quantity, 0),
          sold_by: user?.name || "Unknown",
        };
      });

    const recentDeliveries = req.db.deliveries
      .slice()
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 5)
      .map((delivery) => {
        const vendor = req.db.vendors.find((v) => v.id === delivery.vendor_id);
        return {
          id: delivery.id,
          delivery_date: delivery.delivery_date,
          total_amount: delivery.total_amount,
          vendor_name: vendor?.name || "Unknown",
        };
      });

    return res.json({
      data: {
        todays_total_sales: totalSales,
        todays_total_deliveries: totalDeliveries,
        todays_total_vendor_returns: totalReturns,
        calculated_todays_sales: calculatedSales,
        todays_transaction_count: transactionCount,
        items_sold_today: itemsSold,
        total_current_inventory: totalCurrentInventory,
        low_stock_count: lowStockProducts.length,
        out_of_stock_count: outOfStockCount,
        recent_sales: recentSales,
        recent_deliveries: recentDeliveries,
        low_stock_products: lowStockProducts.map((p) => ({
          id: p.id,
          name: p.name,
          category: p.category,
          image_url: p.image_url || null,
          current_stock: p.current_stock,
          minimum_stock: p.minimum_stock,
          unit: p.unit,
        })),
        sales_calendar: salesCalendar,
      },
    });
  }

  const todaysTotalSales = (await dbGet(
    req.db,
    "SELECT COALESCE(SUM(total_amount), 0) AS total FROM sales WHERE sale_date = $1",
    [today],
    "SELECT COALESCE(SUM(total_amount), 0) AS total FROM sales WHERE sale_date = ?"
  )).total;

  const todaysTransactionCount = (await dbGet(
    req.db,
    "SELECT COUNT(*) AS count FROM sales WHERE sale_date = $1",
    [today],
    "SELECT COUNT(*) AS count FROM sales WHERE sale_date = ?"
  )).count;

  const todaysTotalDeliveries = (await dbGet(
    req.db,
    "SELECT COALESCE(SUM(total_amount), 0) AS total FROM deliveries WHERE delivery_date = $1",
    [today],
    "SELECT COALESCE(SUM(total_amount), 0) AS total FROM deliveries WHERE delivery_date = ?"
  )).total;

  const todaysTotalVendorReturns = (await dbGet(
    req.db,
    "SELECT COALESCE(SUM(total_product_price_returned), 0) AS total FROM vendor_returns WHERE return_date = $1",
    [today],
    "SELECT COALESCE(SUM(total_product_price_returned), 0) AS total FROM vendor_returns WHERE return_date = ?"
  )).total;

  const calculatedTodaysSales = Number(todaysTotalSales) + Number(todaysTotalDeliveries) - Number(todaysTotalVendorReturns);

  const itemsSoldToday = (await dbGet(
    req.db,
    `SELECT COALESCE(SUM(si.quantity), 0) AS count
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      WHERE s.sale_date = $1`,
    [today],
    `SELECT COALESCE(SUM(si.quantity), 0) AS count
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      WHERE s.sale_date = ?`
  )).count;

  const totalCurrentInventory = (await dbGet(
    req.db,
    "SELECT COALESCE(SUM(current_stock), 0) AS total FROM products WHERE active = 1"
  )).total;

  const lowStockProducts = await dbAll(
    req.db,
    `SELECT id, name, category, image_url, current_stock, minimum_stock, unit
      FROM products WHERE active = 1 AND current_stock > 0 AND current_stock <= 10
      ORDER BY current_stock ASC LIMIT 10`
  );

  const lowStockCount = lowStockProducts.length;
  const calendarSales = await dbAll(req.db, "SELECT sale_date, total_amount FROM sales", [], "SELECT sale_date, total_amount FROM sales");
  const calendarDeliveries = await dbAll(req.db, "SELECT delivery_date, total_amount FROM deliveries", [], "SELECT delivery_date, total_amount FROM deliveries");
  const calendarReturns = await dbAll(req.db, "SELECT return_date, total_product_price_returned FROM vendor_returns", [], "SELECT return_date, total_product_price_returned FROM vendor_returns");
  const salesCalendar = buildSalesCalendar(calendarSales, calendarDeliveries, calendarReturns);
  const outOfStockCount = (await dbGet(
    req.db,
    "SELECT COUNT(*) AS count FROM products WHERE active = 1 AND current_stock <= 0"
  )).count;

  const recentSales = await dbAll(
    req.db,
    `SELECT s.id, s.sale_date, s.total_amount, u.name AS sold_by, COALESCE(SUM(si.quantity), 0) AS item_count
      FROM sales s
      LEFT JOIN sale_items si ON si.sale_id = s.id
      JOIN users u ON s.user_id = u.id
      GROUP BY s.id, s.sale_date, s.total_amount, u.name, s.created_at
      ORDER BY s.created_at DESC
      LIMIT 5`,
    [],
    `SELECT s.id, s.sale_date, s.total_amount, u.name AS sold_by, COALESCE(SUM(si.quantity), 0) AS item_count
      FROM sales s
      LEFT JOIN sale_items si ON si.sale_id = s.id
      JOIN users u ON s.user_id = u.id
      GROUP BY s.id
      ORDER BY s.created_at DESC
      LIMIT 5`
  );

  const recentDeliveries = await dbAll(
    req.db,
    `SELECT d.id, d.delivery_date, d.total_amount, v.name AS vendor_name
      FROM deliveries d
      JOIN vendors v ON d.vendor_id = v.id
      ORDER BY d.created_at DESC
      LIMIT 5`
  );

  return res.json({
    data: {
      todays_total_sales: todaysTotalSales,
      todays_total_deliveries: todaysTotalDeliveries,
      todays_total_vendor_returns: todaysTotalVendorReturns,
      calculated_todays_sales: calculatedTodaysSales,
      todays_transaction_count: todaysTransactionCount,
      items_sold_today: itemsSoldToday,
      total_current_inventory: totalCurrentInventory,
      low_stock_count: lowStockCount,
      out_of_stock_count: outOfStockCount,
      recent_sales: recentSales,
      recent_deliveries: recentDeliveries,
      low_stock_products: lowStockProducts,
      sales_calendar: salesCalendar,
    },
  });
}

async function vendorDashboard(req, res) {
  const today = getTodayString();

  if (isInMemoryDb(req.db)) {
    const deliveries = req.db.deliveries
      .filter((delivery) => delivery.vendor_id === req.user.vendor_id)
      .slice()
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 10)
      .map((delivery) => ({
        id: delivery.id,
        delivery_date: delivery.delivery_date,
        delivery_time: delivery.delivery_time || null,
        items: req.db.delivery_items
          .filter((item) => item.delivery_id === delivery.id)
          .map((item) => `${req.db.products.find((product) => product.id === item.product_id)?.name || "Unknown"} (${item.quantity})`)
          .join(", "),
        total_amount: delivery.total_amount,
        created_at: delivery.created_at,
      }));

    const todayCount = req.db.deliveries.filter(
      (delivery) => delivery.vendor_id === req.user.vendor_id && delivery.delivery_date === today
    ).length;

    const todayTotal = req.db.deliveries
      .filter((delivery) => delivery.vendor_id === req.user.vendor_id && delivery.delivery_date === today)
      .reduce((sum, delivery) => sum + delivery.total_amount, 0);

    return res.json({
      data: {
        vendor_summary: {
          today_delivery_count: todayCount,
          today_delivery_total: todayTotal,
          recent_deliveries: deliveries,
        },
      },
    });
  }

  const vendorDeliveries = await dbAll(
    req.db,
    `SELECT d.id, d.delivery_date, d.delivery_time, d.total_amount, d.created_at,
            COALESCE(STRING_AGG(p.name || ' (' || di.quantity || ')', ', '), '') AS items
      FROM deliveries d
      LEFT JOIN delivery_items di ON di.delivery_id = d.id
      LEFT JOIN products p ON p.id = di.product_id
      WHERE d.vendor_id = $1
      GROUP BY d.id
      ORDER BY d.created_at DESC
      LIMIT 10`,
    [req.user.vendor_id],
    `SELECT d.id, d.delivery_date, d.delivery_time, d.total_amount, d.created_at,
            COALESCE(GROUP_CONCAT(p.name || ' (' || di.quantity || ')', ', '), '') AS items
      FROM deliveries d
      LEFT JOIN delivery_items di ON di.delivery_id = d.id
      LEFT JOIN products p ON p.id = di.product_id
      WHERE d.vendor_id = ?
      GROUP BY d.id
      ORDER BY d.created_at DESC
      LIMIT 10`
  );

  const todayDeliveryCount = (await dbGet(
    req.db,
    "SELECT COUNT(*) AS count FROM deliveries WHERE vendor_id = $1 AND delivery_date = $2",
    [req.user.vendor_id, today],
    "SELECT COUNT(*) AS count FROM deliveries WHERE vendor_id = ? AND delivery_date = ?"
  )).count;

  const todayDeliveryTotal = (await dbGet(
    req.db,
    "SELECT COALESCE(SUM(total_amount), 0) AS total FROM deliveries WHERE vendor_id = $1 AND delivery_date = $2",
    [req.user.vendor_id, today],
    "SELECT COALESCE(SUM(total_amount), 0) AS total FROM deliveries WHERE vendor_id = ? AND delivery_date = ?"
  )).total;

  return res.json({
    data: {
      vendor_summary: {
        today_delivery_count: todayDeliveryCount,
        today_delivery_total: todayDeliveryTotal,
        recent_deliveries: vendorDeliveries,
      },
    },
  });
}

export default router;
