import express from "express";
import { requireRole } from "../middleware/auth.js";
import { dbAll, dbGet, isInMemoryDb } from "./dbCompat.js";
import { getBusinessDate } from "../businessDate.js";

const router = express.Router();

function getTodayString() {
  return getBusinessDate();
}

function dateFromKey(value) {
  return new Date(`${value}T00:00:00Z`);
}

function dateKey(value) {
  return value.toISOString().slice(0, 10);
}

function addUtcDays(value, days) {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function startOfUtcWeek(value) {
  const start = new Date(value);
  const day = start.getUTCDay();
  start.setUTCDate(start.getUTCDate() - (day === 0 ? 6 : day - 1));
  return start;
}

export function buildCombinedSalesPeriods(sales = [], deliveries = [], returns = [], todayKey = getTodayString()) {
  const today = dateFromKey(todayKey);
  const normalizedRows = [
    ...sales.map((sale, index) => ({
      kind: "recorded",
      date: getCalendarDateKey(sale.sale_date),
      total: Number(sale.total_amount || 0),
      transaction_key: `sale-${sale.id ?? index}`,
    })),
    ...deliveries.map((delivery, index) => ({
      kind: "delivery",
      date: getCalendarDateKey(delivery.delivery_date),
      total: Number(delivery.total_amount || 0),
      transaction_key: `delivery-${delivery.id ?? index}`,
    })),
    ...returns.map((entry, index) => ({
      kind: "return",
      date: getCalendarDateKey(entry.return_date),
      total: Number(entry.total_product_price_returned || 0),
      transaction_key: `return-${entry.return_batch_id || entry.id || index}`,
    })),
  ];
  const summarize = (start, end) => {
    const matches = normalizedRows.filter((row) => row.date >= start && row.date < end);
    const recordedSales = matches
      .filter((row) => row.kind === "recorded")
      .reduce((sum, row) => sum + row.total, 0);
    const deliveryTotal = matches
      .filter((row) => row.kind === "delivery")
      .reduce((sum, row) => sum + row.total, 0);
    const returnTotal = matches
      .filter((row) => row.kind === "return")
      .reduce((sum, row) => sum + row.total, 0);

    return {
      recorded_sales: recordedSales,
      delivery_total: deliveryTotal,
      return_total: returnTotal,
      total: recordedSales + deliveryTotal - returnTotal,
      transactions: new Set(matches.map((row) => row.transaction_key)).size,
    };
  };

  const daily = [];
  for (let offset = 13; offset >= 0; offset -= 1) {
    const startDate = addUtcDays(today, -offset);
    const start = dateKey(startDate);
    daily.push({ period: start, ...summarize(start, dateKey(addUtcDays(startDate, 1))) });
  }

  const currentWeekStart = startOfUtcWeek(today);
  const weekly = [];
  for (let offset = 7; offset >= 0; offset -= 1) {
    const startDate = addUtcDays(currentWeekStart, -offset * 7);
    const endDate = addUtcDays(startDate, 7);
    weekly.push({
      period: dateKey(startDate),
      period_end: dateKey(addUtcDays(endDate, -1)),
      ...summarize(dateKey(startDate), dateKey(endDate)),
    });
  }

  const monthly = [];
  for (let offset = 11; offset >= 0; offset -= 1) {
    const startDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - offset, 1));
    const endDate = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth() + 1, 1));
    monthly.push({
      period: dateKey(startDate).slice(0, 7),
      ...summarize(dateKey(startDate), dateKey(endDate)),
    });
  }

  const weekStart = dateKey(currentWeekStart);
  const weekEndDate = addUtcDays(currentWeekStart, 7);
  const monthStartDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const monthEndDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));

  return {
    daily,
    weekly,
    monthly,
    current: {
      daily: summarize(todayKey, dateKey(addUtcDays(today, 1))),
      weekly: summarize(weekStart, dateKey(weekEndDate)),
      monthly: summarize(dateKey(monthStartDate), dateKey(monthEndDate)),
      week_start: weekStart,
      week_end: dateKey(addUtcDays(weekEndDate, -1)),
      month: dateKey(monthStartDate).slice(0, 7),
    },
  };
}

function buildProductSales(products = [], saleItems = [], deliveryItems = [], returns = []) {
  const productMap = new Map(products.map((product) => [Number(product.id), product]));
  const totals = new Map();

  const getTotal = (productId) => totals.get(productId) || {
    recorded_quantity: 0,
    delivered_quantity: 0,
    returned_quantity: 0,
    recorded_sales: 0,
    delivery_total: 0,
    return_total: 0,
  };

  saleItems.forEach((item) => {
    const productId = Number(item.product_id);
    const row = getTotal(productId);
    row.recorded_quantity += Number(item.quantity || 0);
    row.recorded_sales += Number(item.quantity || 0) * Number(item.unit_price || 0);
    totals.set(productId, row);
  });

  deliveryItems.forEach((item) => {
    const productId = Number(item.product_id);
    const row = getTotal(productId);
    row.delivered_quantity += Number(item.quantity || 0);
    row.delivery_total += Number(item.quantity || 0) * Number(item.unit_cost || 0);
    totals.set(productId, row);
  });

  returns.forEach((entry) => {
    const productId = Number(entry.product_id);
    const row = getTotal(productId);
    row.returned_quantity += Number(entry.quantity || 0);
    row.return_total += Number(entry.total_product_price_returned || 0);
    totals.set(productId, row);
  });

  return [...totals.entries()].map(([productId, total]) => {
    const product = productMap.get(productId) || {};
    return {
      product_id: productId,
      name: product.name || "Unknown product",
      category: product.category || "General",
      image_url: product.image_url || null,
      unit: product.unit || "units",
      ...total,
      net_quantity: total.recorded_quantity + total.delivered_quantity - total.returned_quantity,
      net_sales: total.recorded_sales + total.delivery_total - total.return_total,
    };
  }).sort((a, b) => b.net_sales - a.net_sales || a.name.localeCompare(b.name));
}

export function getCalendarDateKey(value) {
  if (value instanceof Date) return getBusinessDate(value);
  const match = String(value || "").match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : "";
}

export async function getDailyActivityCounts(db, todayKey = getTodayString()) {
  if (isInMemoryDb(db)) {
    const sales = db.sales.filter((sale) => getCalendarDateKey(sale.sale_date) === todayKey);
    const deliveries = db.deliveries.filter((delivery) => getCalendarDateKey(delivery.delivery_date) === todayKey);
    const returns = db.vendor_returns.filter((entry) => getCalendarDateKey(entry.return_date) === todayKey);
    const saleIds = new Set(sales.map((sale) => Number(sale.id)));
    const deliveryIds = new Set(deliveries.map((delivery) => Number(delivery.id)));
    const sumQuantity = (rows) => rows.reduce((sum, row) => sum + Number(row.quantity || 0), 0);

    return {
      todays_transaction_count: sales.length + deliveries.length +
        new Set(returns.map((entry) => entry.return_batch_id || `legacy-${entry.id}`)).size,
      items_sold_today: sumQuantity(db.sale_items.filter((item) => saleIds.has(Number(item.sale_id)))) +
        sumQuantity(db.delivery_items.filter((item) => deliveryIds.has(Number(item.delivery_id)))) -
        sumQuantity(returns),
    };
  }

  // Aggregate each source separately: joining line items across sources would
  // multiply quantities and count a multi-product transaction more than once.
  const counts = await dbGet(db,
    `SELECT
       (SELECT COUNT(*) FROM sales WHERE sale_date = $1) +
       (SELECT COUNT(*) FROM deliveries WHERE delivery_date = $2) +
       (SELECT COUNT(DISTINCT COALESCE(NULLIF(return_batch_id, ''), 'legacy-' || CAST(id AS TEXT)))
          FROM vendor_returns WHERE return_date = $3) AS transaction_count,
       (SELECT COALESCE(SUM(si.quantity), 0) FROM sale_items si
          JOIN sales s ON s.id = si.sale_id WHERE s.sale_date = $4) +
       (SELECT COALESCE(SUM(di.quantity), 0) FROM delivery_items di
          JOIN deliveries d ON d.id = di.delivery_id WHERE d.delivery_date = $5) -
       (SELECT COALESCE(SUM(quantity), 0) FROM vendor_returns WHERE return_date = $6) AS items_sold`,
    Array(6).fill(todayKey)
  );
  return {
    todays_transaction_count: Number(counts.transaction_count || 0),
    items_sold_today: Number(counts.items_sold || 0),
  };
}

export function buildSalesCalendar(sales, deliveries, returns, todayKey = getTodayString()) {
  const today = new Date(`${todayKey}T00:00:00Z`);
  const daily = [];
  const monthly = [];
  const sumFor = (rows, dateKey, start, end) => rows
    .filter((row) => {
      const date = getCalendarDateKey(row[dateKey]);
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

export function buildVendorPaymentSummary(deliveries = [], returns = []) {
  const deductionsByDelivery = new Map();
  let unallocatedReturnAmount = 0;
  for (const entry of returns) {
    const amount = Number(entry.total_product_price_returned || 0);
    if (entry.delivery_id == null) {
      unallocatedReturnAmount += amount;
      continue;
    }
    const deliveryId = Number(entry.delivery_id);
    deductionsByDelivery.set(deliveryId, (deductionsByDelivery.get(deliveryId) || 0) + amount);
  }
  const paidDeliveries = deliveries.filter(
    (delivery) => String(delivery.payment_status || "UNPAID").toUpperCase() === "PAID"
  );
  const unpaidDeliveries = deliveries.filter(
    (delivery) => String(delivery.payment_status || "UNPAID").toUpperCase() !== "PAID"
  );
  const sumOriginalAmounts = (rows) => rows.reduce((sum, delivery) => sum + Number(delivery.total_amount || 0), 0);
  const sumAmountsDue = (rows) => rows.reduce((sum, delivery) => {
    const originalAmount = Number(delivery.total_amount || 0);
    return sum + Math.max(originalAmount - (deductionsByDelivery.get(Number(delivery.id)) || 0), 0);
  }, 0);
  const returnAdjustmentAmount = returns.reduce(
    (sum, entry) => sum + Number(entry.total_product_price_returned || 0),
    0
  );
  const returnCount = new Set(
    returns.map((entry) => entry.return_batch_id || `legacy-${entry.id}`)
  ).size;
  const paidDeliveryAmount = sumAmountsDue(paidDeliveries);
  const unpaidDeliveryAmount = sumOriginalAmounts(unpaidDeliveries);
  const grossDeliveryAmount = sumOriginalAmounts(deliveries);
  const netPayableAmount = Math.max(sumAmountsDue(unpaidDeliveries) - unallocatedReturnAmount, 0);

  return {
    paid_delivery_count: paidDeliveries.length,
    paid_delivery_amount: paidDeliveryAmount,
    unpaid_delivery_count: unpaidDeliveries.length,
    unpaid_delivery_amount: unpaidDeliveryAmount,
    return_count: returnCount,
    return_adjustment_amount: returnAdjustmentAmount,
    unallocated_return_adjustment_amount: unallocatedReturnAmount,
    total_delivery_count: deliveries.length,
    gross_delivery_amount: grossDeliveryAmount,
    net_payable_amount: netPayableAmount,
    // Retain the original field for older deployed clients.
    net_account_amount: netPayableAmount,
  };
}

export function buildVendorDeliveryAccounts(deliveries = [], returns = []) {
  const deductionsByDelivery = new Map();
  for (const entry of returns) {
    if (entry.delivery_id == null) continue;
    const deliveryId = Number(entry.delivery_id);
    deductionsByDelivery.set(
      deliveryId,
      (deductionsByDelivery.get(deliveryId) || 0) + Number(entry.total_product_price_returned || 0)
    );
  }

  return deliveries
    .map((delivery) => {
      const originalAmount = Number(delivery.total_amount || 0);
      const returnDeduction = deductionsByDelivery.get(Number(delivery.id)) || 0;
      return {
        ...delivery,
        original_amount: originalAmount,
        return_deduction: returnDeduction,
        amount_due: Math.max(originalAmount - returnDeduction, 0),
        payment_status: String(delivery.payment_status || "UNPAID").toUpperCase(),
      };
    })
    .sort((a, b) => `${b.delivery_date || ""} ${b.delivery_time || ""} ${b.id}`.localeCompare(`${a.delivery_date || ""} ${a.delivery_time || ""} ${a.id}`));
}

export function buildVendorDailyPaymentHistory(deliveries = [], returns = []) {
  const dates = new Set();
  deliveries.forEach((delivery) => {
    const date = getCalendarDateKey(delivery.delivery_date);
    if (date) dates.add(date);
  });
  returns.forEach((entry) => {
    const date = getCalendarDateKey(entry.return_date);
    if (date) dates.add(date);
  });

  return [...dates]
    .sort((a, b) => b.localeCompare(a))
    .map((accountDate) => ({
      account_date: accountDate,
      ...buildVendorPaymentSummary(
        deliveries.filter((delivery) => getCalendarDateKey(delivery.delivery_date) === accountDate),
        returns.filter((entry) => getCalendarDateKey(entry.return_date) === accountDate)
      ),
    }));
}

router.get("/", requireRole("SUPERADMIN", "STAFF", "VENDOR"), async (req, res) => {
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

router.get("/total-sales", requireRole("SUPERADMIN", "STAFF"), async (req, res) => {
  try {
    const today = getTodayString();
    let sales;
    let deliveries;
    let returns;
    let products;
    let allTimeSummary;

    if (isInMemoryDb(req.db)) {
      sales = req.db.sales.map((sale) => ({ ...sale }));
      deliveries = req.db.deliveries.map((delivery) => ({ ...delivery }));
      returns = req.db.vendor_returns.map((entry) => ({ ...entry }));
      products = buildProductSales(req.db.products, req.db.sale_items, req.db.delivery_items, req.db.vendor_returns);
      const recordedSales = sales.reduce((sum, sale) => sum + Number(sale.total_amount || 0), 0);
      const deliveryTotal = deliveries.reduce((sum, delivery) => sum + Number(delivery.total_amount || 0), 0);
      const returnTotal = returns.reduce((sum, entry) => sum + Number(entry.total_product_price_returned || 0), 0);
      allTimeSummary = {
        recorded_sales: recordedSales,
        delivery_total: deliveryTotal,
        return_total: returnTotal,
        total: recordedSales + deliveryTotal - returnTotal,
        transactions: sales.length + deliveries.length + new Set(returns.map((entry) => entry.return_batch_id || `legacy-${entry.id}`)).size,
      };
    } else {
      const chartStartDate = new Date(Date.UTC(
        dateFromKey(today).getUTCFullYear(),
        dateFromKey(today).getUTCMonth() - 11,
        1
      ));
      const [salesRows, deliveryRows, returnRows, totals, productRows] = await Promise.all([
        dbAll(
          req.db,
          "SELECT id, sale_date, total_amount FROM sales WHERE sale_date >= $1 ORDER BY sale_date ASC",
          [dateKey(chartStartDate)],
          "SELECT id, sale_date, total_amount FROM sales WHERE sale_date >= ? ORDER BY sale_date ASC"
        ),
        dbAll(
          req.db,
          "SELECT id, delivery_date, total_amount FROM deliveries WHERE delivery_date >= $1 ORDER BY delivery_date ASC",
          [dateKey(chartStartDate)],
          "SELECT id, delivery_date, total_amount FROM deliveries WHERE delivery_date >= ? ORDER BY delivery_date ASC"
        ),
        dbAll(
          req.db,
          "SELECT id, return_batch_id, return_date, total_product_price_returned FROM vendor_returns WHERE return_date >= $1 ORDER BY return_date ASC",
          [dateKey(chartStartDate)],
          "SELECT id, return_batch_id, return_date, total_product_price_returned FROM vendor_returns WHERE return_date >= ? ORDER BY return_date ASC"
        ),
        dbGet(
          req.db,
          `SELECT COALESCE((SELECT SUM(total_amount) FROM sales), 0) AS recorded_sales,
                  COALESCE((SELECT SUM(total_amount) FROM deliveries), 0) AS delivery_total,
                  COALESCE((SELECT SUM(total_product_price_returned) FROM vendor_returns), 0) AS return_total,
                  (SELECT COUNT(*) FROM sales) +
                  (SELECT COUNT(*) FROM deliveries) +
                  (SELECT COUNT(DISTINCT COALESCE(return_batch_id, 'legacy-' || CAST(id AS TEXT))) FROM vendor_returns) AS transactions`
        ),
        dbAll(
          req.db,
          `SELECT p.id AS product_id, p.name, p.category, p.image_url, p.unit,
                  activity.recorded_quantity, activity.delivered_quantity, activity.returned_quantity,
                  activity.recorded_sales, activity.delivery_total, activity.return_total,
                  activity.recorded_quantity + activity.delivered_quantity - activity.returned_quantity AS net_quantity,
                  activity.recorded_sales + activity.delivery_total - activity.return_total AS net_sales
             FROM (
               SELECT product_id,
                      SUM(recorded_quantity) AS recorded_quantity,
                      SUM(delivered_quantity) AS delivered_quantity,
                      SUM(returned_quantity) AS returned_quantity,
                      SUM(recorded_sales) AS recorded_sales,
                      SUM(delivery_total) AS delivery_total,
                      SUM(return_total) AS return_total
                 FROM (
                   SELECT product_id, quantity AS recorded_quantity, 0 AS delivered_quantity, 0 AS returned_quantity,
                          quantity * unit_price AS recorded_sales, 0 AS delivery_total, 0 AS return_total
                     FROM sale_items
                   UNION ALL
                   SELECT product_id, 0, quantity, 0, 0, quantity * unit_cost, 0
                     FROM delivery_items
                   UNION ALL
                   SELECT product_id, 0, 0, quantity, 0, 0, total_product_price_returned
                     FROM vendor_returns
                 ) product_activity
                GROUP BY product_id
             ) activity
             JOIN products p ON p.id = activity.product_id
            ORDER BY net_sales DESC, p.name ASC`
        ),
      ]);
      sales = salesRows;
      deliveries = deliveryRows;
      returns = returnRows;
      products = productRows.map((product) => ({
        ...product,
        product_id: Number(product.product_id),
        recorded_quantity: Number(product.recorded_quantity || 0),
        delivered_quantity: Number(product.delivered_quantity || 0),
        returned_quantity: Number(product.returned_quantity || 0),
        recorded_sales: Number(product.recorded_sales || 0),
        delivery_total: Number(product.delivery_total || 0),
        return_total: Number(product.return_total || 0),
        net_quantity: Number(product.net_quantity || 0),
        net_sales: Number(product.net_sales || 0),
        image_url: product.image_url || null,
      }));
      const recordedSales = Number(totals.recorded_sales || 0);
      const deliveryTotal = Number(totals.delivery_total || 0);
      const returnTotal = Number(totals.return_total || 0);
      allTimeSummary = {
        recorded_sales: recordedSales,
        delivery_total: deliveryTotal,
        return_total: returnTotal,
        total: recordedSales + deliveryTotal - returnTotal,
        transactions: Number(totals.transactions || 0),
      };
    }

    const periods = buildCombinedSalesPeriods(sales, deliveries, returns, today);
    const productSalesTotal = products.reduce((sum, product) => sum + Math.max(Number(product.net_sales || 0), 0), 0);

    res.json({
      data: {
        generated_for: today,
        summary: {
          ...periods.current,
          all_time: allTimeSummary,
        },
        daily: periods.daily,
        weekly: periods.weekly,
        monthly: periods.monthly,
        products: products.map((product) => ({
          ...product,
          share_percent: productSalesTotal > 0 ? (Math.max(Number(product.net_sales || 0), 0) / productSalesTotal) * 100 : 0,
        })),
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load total sales analytics" });
  }
});

export async function getStockAlerts(db) {
  const products = isInMemoryDb(db)
    ? db.products.filter((product) => Number(product.active ?? 1) === 1 && Number(product.current_stock || 0) <= 10)
    : await dbAll(db,
        `SELECT id, name, category, image_url, current_stock, minimum_stock, unit
         FROM products WHERE active = 1 AND current_stock <= 10
         ORDER BY current_stock ASC, name ASC, id ASC`
      );
  const alerts = products.map((product) => ({
    id: product.id,
    name: product.name,
    category: product.category,
    image_url: product.image_url || null,
    current_stock: Number(product.current_stock || 0),
    minimum_stock: Number(product.minimum_stock || 0),
    unit: product.unit,
    status: Number(product.current_stock || 0) <= 0 ? "OUT_OF_STOCK" : "LOW_STOCK",
  })).sort((a, b) => a.current_stock - b.current_stock || a.name.localeCompare(b.name) || Number(a.id) - Number(b.id));
  const lowStockProducts = alerts.filter((product) => product.status === "LOW_STOCK");
  const outOfStockProducts = alerts.filter((product) => product.status === "OUT_OF_STOCK");
  return {
    stock_alert_products: alerts,
    low_stock_products: lowStockProducts,
    out_of_stock_products: outOfStockProducts,
    low_stock_count: lowStockProducts.length,
    out_of_stock_count: outOfStockProducts.length,
  };
}

async function operationalDashboard(req, res) {
  const today = getTodayString();
  const activityCounts = await getDailyActivityCounts(req.db, today);
  const stockAlerts = await getStockAlerts(req.db);

  if (isInMemoryDb(req.db)) {
    const salesToday = req.db.sales.filter((sale) => sale.sale_date === today);
    const totalSales = salesToday.reduce((sum, sale) => sum + sale.total_amount, 0);
    const deliveriesToday = req.db.deliveries.filter((delivery) => delivery.delivery_date === today);
    const totalDeliveries = deliveriesToday.reduce((sum, delivery) => sum + Number(delivery.total_amount || 0), 0);
    const returnsToday = req.db.vendor_returns.filter((entry) => entry.return_date === today);
    const totalReturns = returnsToday.reduce((sum, entry) => sum + Number(entry.total_product_price_returned || 0), 0);
    const calculatedSales = totalSales + totalDeliveries - totalReturns;
    const salesCalendar = buildSalesCalendar(req.db.sales, req.db.deliveries, req.db.vendor_returns);

    const activeProducts = req.db.products.filter((p) => Number(p.active ?? 1) === 1);
    const totalCurrentInventory = activeProducts.reduce((sum, p) => sum + Number(p.current_stock || 0), 0);
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
        ...activityCounts,
        total_current_inventory: totalCurrentInventory,
        ...stockAlerts,
        recent_sales: recentSales,
        recent_deliveries: recentDeliveries,
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

  const totalCurrentInventory = (await dbGet(
    req.db,
    "SELECT COALESCE(SUM(current_stock), 0) AS total FROM products WHERE active = 1"
  )).total;

  const calendarSales = await dbAll(req.db, "SELECT sale_date, total_amount FROM sales", [], "SELECT sale_date, total_amount FROM sales");
  const calendarDeliveries = await dbAll(req.db, "SELECT delivery_date, total_amount FROM deliveries", [], "SELECT delivery_date, total_amount FROM deliveries");
  const calendarReturns = await dbAll(req.db, "SELECT return_date, total_product_price_returned FROM vendor_returns", [], "SELECT return_date, total_product_price_returned FROM vendor_returns");
  const salesCalendar = buildSalesCalendar(calendarSales, calendarDeliveries, calendarReturns);
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
      ...activityCounts,
      total_current_inventory: totalCurrentInventory,
      ...stockAlerts,
      recent_sales: recentSales,
      recent_deliveries: recentDeliveries,
      sales_calendar: salesCalendar,
    },
  });
}

async function vendorDashboard(req, res) {
  const today = getTodayString();

  if (isInMemoryDb(req.db)) {
    const vendorDeliveryRecords = req.db.deliveries
      .filter((delivery) => Number(delivery.vendor_id) === Number(req.user.vendor_id));
    const vendorReturnRecords = req.db.vendor_returns
      .filter((entry) => Number(entry.vendor_id) === Number(req.user.vendor_id));
    const todayDeliveryRecords = vendorDeliveryRecords
      .filter((delivery) => getCalendarDateKey(delivery.delivery_date) === today);
    const todayReturnRecords = vendorReturnRecords
      .filter((entry) => getCalendarDateKey(entry.return_date) === today);
    const paymentSummary = buildVendorPaymentSummary(todayDeliveryRecords, todayReturnRecords);
    const todayDeliveryAccounts = buildVendorDeliveryAccounts(todayDeliveryRecords, todayReturnRecords).map((delivery) => ({
      ...delivery,
      items: req.db.delivery_items
        .filter((item) => Number(item.delivery_id) === Number(delivery.id))
        .map((item) => `${req.db.products.find((product) => product.id === item.product_id)?.name || "Unknown"} (${item.quantity})`)
        .join(", "),
    }));
    const dailyHistory = buildVendorDailyPaymentHistory(vendorDeliveryRecords, vendorReturnRecords);
    const deliveries = vendorDeliveryRecords
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
        payment_status: String(delivery.payment_status || "UNPAID").toUpperCase(),
        created_at: delivery.created_at,
      }));

    const todayCount = todayDeliveryRecords.length;

    const todayTotal = todayDeliveryRecords
      .reduce((sum, delivery) => sum + Number(delivery.total_amount || 0), 0);

    return res.json({
      data: {
        vendor_summary: {
          today_delivery_count: todayCount,
          today_delivery_total: todayTotal,
          account_date: today,
          payment_summary: paymentSummary,
          today_delivery_accounts: todayDeliveryAccounts,
          daily_history: dailyHistory,
          recent_deliveries: deliveries,
        },
      },
    });
  }

  const vendorDeliveries = await dbAll(
    req.db,
    `SELECT d.id, d.delivery_date, d.delivery_time, d.total_amount, d.created_at,
            COALESCE(d.payment_status, 'UNPAID') AS payment_status,
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
            COALESCE(d.payment_status, 'UNPAID') AS payment_status,
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

  const vendorPaymentDeliveries = await dbAll(
    req.db,
    `SELECT d.id, d.delivery_date, d.delivery_time, d.total_amount, COALESCE(d.payment_status, 'UNPAID') AS payment_status,
            COALESCE(STRING_AGG(p.name || ' (' || di.quantity || ')', ', ' ORDER BY p.name), '') AS items
     FROM deliveries d
     LEFT JOIN delivery_items di ON di.delivery_id = d.id
     LEFT JOIN products p ON p.id = di.product_id
     WHERE d.vendor_id = $1
     GROUP BY d.id`,
    [req.user.vendor_id],
    `SELECT d.id, d.delivery_date, d.delivery_time, d.total_amount, COALESCE(d.payment_status, 'UNPAID') AS payment_status,
            COALESCE(GROUP_CONCAT(p.name || ' (' || di.quantity || ')', ', '), '') AS items
     FROM deliveries d
     LEFT JOIN delivery_items di ON di.delivery_id = d.id
     LEFT JOIN products p ON p.id = di.product_id
     WHERE d.vendor_id = ?
     GROUP BY d.id`
  );

  const vendorPaymentReturns = await dbAll(
    req.db,
    `SELECT id, return_batch_id, delivery_id, return_date, total_product_price_returned
     FROM vendor_returns WHERE vendor_id = $1`,
    [req.user.vendor_id],
    `SELECT id, return_batch_id, delivery_id, return_date, total_product_price_returned
     FROM vendor_returns WHERE vendor_id = ?`
  );

  const todayPaymentDeliveries = vendorPaymentDeliveries
    .filter((delivery) => getCalendarDateKey(delivery.delivery_date) === today);
  const todayPaymentReturns = vendorPaymentReturns
    .filter((entry) => getCalendarDateKey(entry.return_date) === today);
  const paymentSummary = buildVendorPaymentSummary(todayPaymentDeliveries, todayPaymentReturns);
  const todayDeliveryAccounts = buildVendorDeliveryAccounts(todayPaymentDeliveries, todayPaymentReturns);
  const dailyHistory = buildVendorDailyPaymentHistory(vendorPaymentDeliveries, vendorPaymentReturns);

  return res.json({
    data: {
      vendor_summary: {
        today_delivery_count: todayDeliveryCount,
        today_delivery_total: todayDeliveryTotal,
        account_date: today,
        payment_summary: paymentSummary,
        today_delivery_accounts: todayDeliveryAccounts,
        daily_history: dailyHistory,
        recent_deliveries: vendorDeliveries,
      },
    },
  });
}

export default router;
