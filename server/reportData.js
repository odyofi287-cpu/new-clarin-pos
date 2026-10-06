import { dbAll, dbGet, isInMemoryDb } from "./routes/dbCompat.js";
import { getBusinessDate, BUSINESS_TIME_ZONE } from "./businessDate.js";

export function reportDate(value) {
  if (value instanceof Date) return getBusinessDate(value);
  return String(value || "").slice(0, 10);
}

export function validReportDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && value >= "0001-01-01" && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export function reportRange(query) {
  const today = getBusinessDate();
  const start = query.start_date ?? today;
  const end = query.end_date ?? start;
  if (!validReportDate(start) || !validReportDate(end)) throw new Error("Choose valid calendar dates.");
  if (start > end) throw new Error("The start date must be on or before the end date.");
  return { start, end };
}

export async function allTimeSalesRange(db) {
  const today = getBusinessDate();
  let first, last;
  if (isInMemoryDb(db)) {
    const dates = [...db.sales.map((s) => reportDate(s.sale_date)), ...db.deliveries.map((d) => reportDate(d.delivery_date)), ...db.vendor_returns.map((r) => reportDate(r.return_date))].filter(Boolean).sort();
    first = dates[0]; last = dates.at(-1);
  } else {
    const row = await dbGet(db, `SELECT MIN(activity_date) AS first_date, MAX(activity_date) AS last_date FROM (
      SELECT sale_date AS activity_date FROM sales UNION ALL SELECT delivery_date FROM deliveries UNION ALL SELECT return_date FROM vendor_returns
    ) activity`);
    first = reportDate(row.first_date); last = reportDate(row.last_date);
  }
  return { start: first || today, end: last && last > today ? last : today };
}

const n = (value) => Number(value || 0);
const inRange = (value, start, end) => reportDate(value) >= start && reportDate(value) <= end;
const total = (rows, key) => rows.reduce((sum, row) => sum + n(row[key]), 0);

export async function salesReport(db, start, end) {
  if (isInMemoryDb(db)) {
    return db.sales.filter((sale) => inRange(sale.sale_date, start, end)).map((sale) => {
      const items = db.sale_items.filter((item) => item.sale_id === sale.id);
      return {
        transaction_id: sale.id, sale_date: reportDate(sale.sale_date),
        staff: db.users.find((user) => user.id === sale.user_id)?.name || "Unknown",
        items: items.map((item) => `${db.products.find((p) => p.id === item.product_id)?.name || "Unknown"} (${item.quantity})`).join(", "),
        quantity: total(items, "quantity"), total_amount: n(sale.total_amount),
      };
    }).sort((a, b) => b.sale_date.localeCompare(a.sale_date) || b.transaction_id - a.transaction_id);
  }
  const rows = await dbAll(db, `SELECT s.id AS transaction_id, s.sale_date, u.name AS staff,
      COALESCE(STRING_AGG(p.name || ' (' || si.quantity::text || ')', ', ' ORDER BY p.name), '') AS items,
      COALESCE(SUM(si.quantity), 0) AS quantity, s.total_amount
    FROM sales s LEFT JOIN sale_items si ON si.sale_id = s.id
    LEFT JOIN products p ON p.id = si.product_id LEFT JOIN users u ON u.id = s.user_id
    WHERE s.sale_date BETWEEN $1 AND $2
    GROUP BY s.id, s.sale_date, u.name, s.total_amount ORDER BY s.sale_date DESC, s.id DESC`, [start, end],
    `SELECT s.id AS transaction_id, s.sale_date, u.name AS staff,
      COALESCE(GROUP_CONCAT(p.name || ' (' || si.quantity || ')', ', '), '') AS items,
      COALESCE(SUM(si.quantity), 0) AS quantity, s.total_amount
    FROM sales s LEFT JOIN sale_items si ON si.sale_id = s.id
    LEFT JOIN products p ON p.id = si.product_id LEFT JOIN users u ON u.id = s.user_id
    WHERE s.sale_date BETWEEN ? AND ? GROUP BY s.id ORDER BY s.sale_date DESC, s.id DESC`);
  return rows.map((row) => ({ ...row, sale_date: reportDate(row.sale_date), quantity: n(row.quantity), total_amount: n(row.total_amount) }));
}

export async function inventoryReport(db, start, end) {
  let rows;
  if (isInMemoryDb(db)) {
    rows = db.products.filter((p) => n(p.active ?? 1) === 1).map((p) => {
      const movements = db.inventory_movements.filter((m) => m.product_id === p.id && inRange(getBusinessDate(new Date(m.created_at)), start, end));
      return { product: p.name, stock_in: total(movements.filter((m) => m.movement_type === "STOCK_IN"), "quantity"),
        stock_out: total(movements.filter((m) => m.movement_type === "STOCK_OUT"), "quantity"), current_stock: n(p.current_stock), minimum_stock: n(p.minimum_stock) };
    });
  } else {
    // UTC timestamps are compared against Manila midnight boundaries, without
    // casting the indexed created_at column to a date.
    rows = await dbAll(db, `SELECT p.name AS product,
      COALESCE(SUM(CASE WHEN im.movement_type = 'STOCK_IN' THEN im.quantity ELSE 0 END), 0) AS stock_in,
      COALESCE(SUM(CASE WHEN im.movement_type = 'STOCK_OUT' THEN im.quantity ELSE 0 END), 0) AS stock_out,
      p.current_stock, p.minimum_stock FROM products p
      LEFT JOIN inventory_movements im ON im.product_id = p.id
        AND im.created_at >= ($1::date::timestamp AT TIME ZONE '${BUSINESS_TIME_ZONE}')
        AND im.created_at < (($2::date + 1)::timestamp AT TIME ZONE '${BUSINESS_TIME_ZONE}')
      WHERE p.active = 1 GROUP BY p.id, p.name, p.current_stock, p.minimum_stock ORDER BY p.name`, [start, end],
      `SELECT p.name AS product,
      COALESCE(SUM(CASE WHEN im.movement_type = 'STOCK_IN' THEN im.quantity ELSE 0 END), 0) AS stock_in,
      COALESCE(SUM(CASE WHEN im.movement_type = 'STOCK_OUT' THEN im.quantity ELSE 0 END), 0) AS stock_out,
      p.current_stock, p.minimum_stock FROM products p
      LEFT JOIN inventory_movements im ON im.product_id = p.id
        AND datetime(im.created_at) >= datetime(?, '-8 hours')
        AND datetime(im.created_at) < datetime(?, '+1 day', '-8 hours')
      WHERE p.active = 1 GROUP BY p.id ORDER BY p.name`);
  }
  return rows.map((row) => ({ ...row, stock_in: n(row.stock_in), stock_out: n(row.stock_out), current_stock: n(row.current_stock), minimum_stock: n(row.minimum_stock),
    stock_status: n(row.current_stock) <= 0 ? "OUT_OF_STOCK" : n(row.current_stock) <= n(row.minimum_stock) ? "LOW_STOCK" : "OK",
  })).sort((a, b) => a.product.localeCompare(b.product));
}

export async function deliveryReport(db, start, end, user) {
  let rows;
  if (isInMemoryDb(db)) {
    rows = db.deliveries.filter((d) => inRange(d.delivery_date, start, end) && (user.role !== "VENDOR" || d.vendor_id === user.vendor_id)).map((d) => {
      const items = db.delivery_items.filter((item) => item.delivery_id === d.id);
      const account = db.users.find((u) => u.vendor_id === d.vendor_id && n(u.active ?? 1) === 1);
      return { delivery_id: d.id, vendor: account?.username || db.vendors.find((v) => v.id === d.vendor_id)?.name || "Unknown",
        delivery_date: reportDate(d.delivery_date), products: items.map((item) => `${db.products.find((p) => p.id === item.product_id)?.name || "Unknown"} (${item.quantity})`).join(", "),
        quantity: total(items, "quantity"), amount: n(d.total_amount) };
    });
  } else {
    const own = user.role === "VENDOR";
    const params = own ? [start, end, user.vendor_id || -1] : [start, end];
    const vendorName = "COALESCE((SELECT u.username FROM users u WHERE u.vendor_id = v.id AND u.active = 1 ORDER BY u.id LIMIT 1), v.name)";
    rows = await dbAll(db, `SELECT d.id AS delivery_id, ${vendorName} AS vendor, d.delivery_date,
      COALESCE(STRING_AGG(p.name || ' (' || di.quantity::text || ')', ', ' ORDER BY p.name), '') AS products,
      COALESCE(SUM(di.quantity), 0) AS quantity, d.total_amount AS amount
      FROM deliveries d JOIN vendors v ON v.id = d.vendor_id
      LEFT JOIN delivery_items di ON di.delivery_id = d.id LEFT JOIN products p ON p.id = di.product_id
      WHERE d.delivery_date BETWEEN $1 AND $2${own ? " AND d.vendor_id = $3" : ""}
      GROUP BY d.id, v.id, v.name, d.delivery_date, d.total_amount ORDER BY d.delivery_date DESC, d.id DESC`, params,
      `SELECT d.id AS delivery_id, ${vendorName} AS vendor, d.delivery_date,
      COALESCE(GROUP_CONCAT(p.name || ' (' || di.quantity || ')', ', '), '') AS products,
      COALESCE(SUM(di.quantity), 0) AS quantity, d.total_amount AS amount
      FROM deliveries d JOIN vendors v ON v.id = d.vendor_id
      LEFT JOIN delivery_items di ON di.delivery_id = d.id LEFT JOIN products p ON p.id = di.product_id
      WHERE d.delivery_date BETWEEN ? AND ?${own ? " AND d.vendor_id = ?" : ""}
      GROUP BY d.id ORDER BY d.delivery_date DESC, d.id DESC`);
  }
  return rows.map((row) => ({ ...row, delivery_date: reportDate(row.delivery_date), quantity: n(row.quantity), amount: n(row.amount) }))
    .sort((a, b) => b.delivery_date.localeCompare(a.delivery_date) || b.delivery_id - a.delivery_id);
}

export async function totalSalesReport(db, start, end) {
  let events, activity;
  if (isInMemoryDb(db)) {
    const sales = db.sales.filter((s) => inRange(s.sale_date, start, end));
    const deliveries = db.deliveries.filter((d) => inRange(d.delivery_date, start, end));
    const returns = db.vendor_returns.filter((r) => inRange(r.return_date, start, end));
    events = [...sales.map((s) => ({ kind: "recorded_sales", date: reportDate(s.sale_date), amount: n(s.total_amount), transaction_key: `sale-${s.id}` })),
      ...deliveries.map((d) => ({ kind: "delivery_total", date: reportDate(d.delivery_date), amount: n(d.total_amount), transaction_key: `delivery-${d.id}` })),
      ...returns.map((r) => ({ kind: "return_total", date: reportDate(r.return_date), amount: n(r.total_product_price_returned), transaction_key: `return-${r.return_batch_id || `legacy-${r.id}`}` }))];
    const saleIds = new Set(sales.map((s) => s.id));
    const deliveryIds = new Set(deliveries.map((d) => d.id));
    activity = [...db.sale_items.filter((i) => saleIds.has(i.sale_id)).map((i) => ({ product_id: i.product_id, recorded_quantity: n(i.quantity), recorded_sales: n(i.quantity) * n(i.unit_price) })),
      ...db.delivery_items.filter((i) => deliveryIds.has(i.delivery_id)).map((i) => ({ product_id: i.product_id, delivered_quantity: n(i.quantity), delivery_total: n(i.quantity) * n(i.unit_cost) })),
      ...returns.map((r) => ({ product_id: r.product_id, returned_quantity: n(r.quantity), return_total: n(r.total_product_price_returned) }))];
    activity = activity.map((a) => ({ ...db.products.find((p) => p.id === a.product_id), ...a }));
  } else {
    [events, activity] = await Promise.all([
      dbAll(db, `SELECT 'recorded_sales' AS kind, sale_date AS date, total_amount AS amount, 'sale-' || CAST(id AS TEXT) AS transaction_key FROM sales WHERE sale_date BETWEEN $1 AND $2
        UNION ALL SELECT 'delivery_total', delivery_date, total_amount, 'delivery-' || CAST(id AS TEXT) FROM deliveries WHERE delivery_date BETWEEN $1 AND $2
        UNION ALL SELECT 'return_total', return_date, total_product_price_returned, 'return-' || COALESCE(return_batch_id, 'legacy-' || CAST(id AS TEXT)) FROM vendor_returns WHERE return_date BETWEEN $1 AND $2`, [start, end],
        `WITH bounds AS (SELECT ? AS start_date, ? AS end_date)
        SELECT 'recorded_sales' AS kind, sale_date AS date, total_amount AS amount, 'sale-' || CAST(id AS TEXT) AS transaction_key FROM sales WHERE sale_date BETWEEN (SELECT start_date FROM bounds) AND (SELECT end_date FROM bounds)
        UNION ALL SELECT 'delivery_total', delivery_date, total_amount, 'delivery-' || CAST(id AS TEXT) FROM deliveries WHERE delivery_date BETWEEN (SELECT start_date FROM bounds) AND (SELECT end_date FROM bounds)
        UNION ALL SELECT 'return_total', return_date, total_product_price_returned, 'return-' || COALESCE(return_batch_id, 'legacy-' || CAST(id AS TEXT)) FROM vendor_returns WHERE return_date BETWEEN (SELECT start_date FROM bounds) AND (SELECT end_date FROM bounds)`),
      dbAll(db, `SELECT p.id AS product_id, p.name, p.category, p.unit, p.image_url,
        SUM(a.recorded_quantity) AS recorded_quantity, SUM(a.delivered_quantity) AS delivered_quantity, SUM(a.returned_quantity) AS returned_quantity,
        SUM(a.recorded_sales) AS recorded_sales, SUM(a.delivery_total) AS delivery_total, SUM(a.return_total) AS return_total
        FROM (
          SELECT i.product_id, i.quantity AS recorded_quantity, 0 AS delivered_quantity, 0 AS returned_quantity, i.quantity * i.unit_price AS recorded_sales, 0 AS delivery_total, 0 AS return_total FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE s.sale_date BETWEEN $1 AND $2
          UNION ALL SELECT i.product_id, 0, i.quantity, 0, 0, i.quantity * i.unit_cost, 0 FROM delivery_items i JOIN deliveries d ON d.id = i.delivery_id WHERE d.delivery_date BETWEEN $1 AND $2
          UNION ALL SELECT product_id, 0, 0, quantity, 0, 0, total_product_price_returned FROM vendor_returns WHERE return_date BETWEEN $1 AND $2
        ) a JOIN products p ON p.id = a.product_id GROUP BY p.id, p.name, p.category, p.unit, p.image_url`, [start, end],
        `WITH bounds AS (SELECT ? AS start_date, ? AS end_date)
        SELECT p.id AS product_id, p.name, p.category, p.unit, p.image_url,
        SUM(a.recorded_quantity) AS recorded_quantity, SUM(a.delivered_quantity) AS delivered_quantity, SUM(a.returned_quantity) AS returned_quantity,
        SUM(a.recorded_sales) AS recorded_sales, SUM(a.delivery_total) AS delivery_total, SUM(a.return_total) AS return_total FROM (
          SELECT i.product_id, i.quantity AS recorded_quantity, 0 AS delivered_quantity, 0 AS returned_quantity, i.quantity * i.unit_price AS recorded_sales, 0 AS delivery_total, 0 AS return_total FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE s.sale_date BETWEEN (SELECT start_date FROM bounds) AND (SELECT end_date FROM bounds)
          UNION ALL SELECT i.product_id, 0, i.quantity, 0, 0, i.quantity * i.unit_cost, 0 FROM delivery_items i JOIN deliveries d ON d.id = i.delivery_id WHERE d.delivery_date BETWEEN (SELECT start_date FROM bounds) AND (SELECT end_date FROM bounds)
          UNION ALL SELECT product_id, 0, 0, quantity, 0, 0, total_product_price_returned FROM vendor_returns WHERE return_date BETWEEN (SELECT start_date FROM bounds) AND (SELECT end_date FROM bounds)
        ) a JOIN products p ON p.id = a.product_id GROUP BY p.id`),
    ]);
  }
  const productMap = new Map();
  for (const row of activity) {
    const p = productMap.get(n(row.product_id)) || { product_id: n(row.product_id), name: row.name, category: row.category || "General", unit: row.unit || "units", image_url: row.image_url || null,
      recorded_quantity: 0, delivered_quantity: 0, returned_quantity: 0, recorded_sales: 0, delivery_total: 0, return_total: 0 };
    for (const key of ["recorded_quantity", "delivered_quantity", "returned_quantity", "recorded_sales", "delivery_total", "return_total"]) p[key] += n(row[key]);
    productMap.set(p.product_id, p);
  }
  const products = [...productMap.values()].map((p) => ({ ...p, net_quantity: p.recorded_quantity + p.delivered_quantity - p.returned_quantity, net_sales: p.recorded_sales + p.delivery_total - p.return_total }))
    .sort((a, b) => b.net_sales - a.net_sales || a.name.localeCompare(b.name));
  const summarize = (rows) => {
    const sum = { recorded_sales: 0, delivery_total: 0, return_total: 0, transactions: new Set(rows.map((r) => r.transaction_key)).size };
    rows.forEach((row) => { sum[row.kind] += n(row.amount); });
    return { ...sum, total: sum.recorded_sales + sum.delivery_total - sum.return_total };
  };
  const periods = (kind) => {
    const groups = new Map();
    for (const event of events) {
      const date = reportDate(event.date);
      let period = date;
      if (kind === "monthly") period = date.slice(0, 7);
      if (kind === "weekly") {
        const day = new Date(`${date}T00:00:00Z`);
        day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
        period = day.toISOString().slice(0, 10);
      }
      if (!groups.has(period)) groups.set(period, []);
      groups.get(period).push(event);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([period, rows]) => ({ period, ...summarize(rows) }));
  };
  return { products, totals: summarize(events), daily: periods("daily"), weekly: periods("weekly"), monthly: periods("monthly") };
}
