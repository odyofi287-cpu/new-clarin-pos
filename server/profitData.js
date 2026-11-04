import { dbAll, isInMemoryDb } from "./routes/dbCompat.js";
import { reportDate } from "./reportData.js";
import { money } from "./productEconomics.js";

export async function getProfitEvents(db, start, end) {
  if (isInMemoryDb(db)) {
    const sales = new Map(db.sales.map((row) => [Number(row.id), row]));
    const deliveries = new Map(db.deliveries.map((row) => [Number(row.id), row]));
    return [
      ...db.sale_items.map((item) => ({ ...item, date: reportDate(sales.get(Number(item.sale_id))?.sale_date), kind: "recorded", revenue: Number(item.quantity) * Number(item.unit_price) })),
      ...db.delivery_items.map((item) => ({ ...item, date: reportDate(deliveries.get(Number(item.delivery_id))?.delivery_date), kind: "delivery", revenue: Number(item.quantity) * Number(item.unit_cost) })),
      ...db.vendor_returns.map((item) => ({ ...item, date: reportDate(item.return_date), kind: "return", revenue: -Number(item.total_product_price_returned) })),
    ].filter((item) => item.date >= start && item.date <= end).map((item) => ({
      date: item.date, kind: item.kind, product_id: item.product_id, revenue: item.revenue,
      known_revenue: item.unit_base_price == null ? 0 : item.revenue,
      base_cost: item.unit_base_price == null ? 0 : Number(item.quantity) * Number(item.unit_base_price) * (item.kind === "return" ? -1 : 1),
      missing_cost_items: item.unit_base_price == null ? Number(item.quantity) : 0,
      missing_cost_lines: item.unit_base_price == null ? 1 : 0,
    }));
  }
  // Aggregate before returning data, use date indexes, and never join cost to
  // today's catalog: costs and selling prices come from transaction snapshots.
  return dbAll(db, `SELECT event_date AS date, kind, product_id, SUM(revenue) AS revenue,
    SUM(CASE WHEN unit_base_price IS NOT NULL THEN revenue ELSE 0 END) AS known_revenue,
    SUM(CASE WHEN unit_base_price IS NOT NULL THEN quantity * unit_base_price * direction ELSE 0 END) AS base_cost,
    SUM(CASE WHEN unit_base_price IS NULL THEN quantity ELSE 0 END) AS missing_cost_items,
    SUM(CASE WHEN unit_base_price IS NULL THEN 1 ELSE 0 END) AS missing_cost_lines
    FROM (
      SELECT s.sale_date AS event_date, 'recorded' AS kind, si.product_id, si.quantity,
        si.quantity * si.unit_price AS revenue, si.unit_base_price, 1 AS direction
        FROM sales s JOIN sale_items si ON si.sale_id = s.id WHERE s.sale_date BETWEEN $1 AND $2
      UNION ALL
      SELECT d.delivery_date, 'delivery', di.product_id, di.quantity, di.quantity * di.unit_cost, di.unit_base_price, 1
        FROM deliveries d JOIN delivery_items di ON di.delivery_id = d.id WHERE d.delivery_date BETWEEN $3 AND $4
      UNION ALL
      SELECT vr.return_date, 'return', vr.product_id, vr.quantity, -vr.total_product_price_returned, vr.unit_base_price, -1
        FROM vendor_returns vr WHERE vr.return_date BETWEEN $5 AND $6
    ) events GROUP BY event_date, kind, product_id ORDER BY event_date`, [start, end, start, end, start, end]);
}

export function summarizeProfit(events) {
  const result = { gross_profit: 0, net_sales: 0, known_revenue: 0, base_cost: 0, missing_cost_items: 0, missing_cost_lines: 0, recorded_profit: 0, delivery_profit: 0, return_profit: 0 };
  for (const row of events) {
    result.net_sales += Number(row.revenue || 0);
    result.known_revenue += Number(row.known_revenue || 0);
    result.base_cost += Number(row.base_cost || 0);
    result.missing_cost_items += Number(row.missing_cost_items || 0);
    result.missing_cost_lines += Number(row.missing_cost_lines || 0);
    const profit = Number(row.known_revenue || 0) - Number(row.base_cost || 0);
    result.gross_profit += profit;
    result[`${row.kind}_profit`] += profit;
  }
  for (const field of Object.keys(result)) result[field] = money(result[field]);
  return result;
}

export async function profitReport(db, start, end, today) {
  const year = today.slice(0, 4);
  const events = await getProfitEvents(db, start < `${year}-01-01` ? start : `${year}-01-01`, end > `${year}-12-31` ? end : `${year}-12-31`);
  const selected = events.filter((row) => reportDate(row.date) >= start && reportDate(row.date) <= end);
  const groupBy = (keyFor) => {
    const groups = new Map();
    for (const row of selected) {
      const key = keyFor(row);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    return [...groups.entries()].map(([period, rows]) => ({ period, ...summarizeProfit(rows) }));
  };
  const products = isInMemoryDb(db) ? db.products : await dbAll(db, "SELECT id, name, category, image_url, volume_ml FROM products");
  const productMap = new Map(products.map((product) => [Number(product.id), product]));
  return {
    generated_for: today, start_date: start, end_date: end,
    summary: {
      range: summarizeProfit(selected),
      daily: summarizeProfit(events.filter((row) => reportDate(row.date) === today)),
      monthly: summarizeProfit(events.filter((row) => reportDate(row.date).slice(0, 7) === today.slice(0, 7))),
      yearly: summarizeProfit(events.filter((row) => reportDate(row.date).slice(0, 4) === year)),
    },
    daily: groupBy((row) => reportDate(row.date)).sort((a, b) => b.period.localeCompare(a.period)),
    monthly: groupBy((row) => reportDate(row.date).slice(0, 7)).sort((a, b) => b.period.localeCompare(a.period)),
    yearly: groupBy((row) => reportDate(row.date).slice(0, 4)).sort((a, b) => b.period.localeCompare(a.period)),
    products: groupBy((row) => Number(row.product_id)).map(({ period, ...totals }) => {
      const product = productMap.get(period);
      return { product_id: period, name: product?.name || "Retained product", category: product?.category, image_url: product?.image_url || null, volume_ml: product?.volume_ml, ...totals };
    }).sort((a, b) => b.gross_profit - a.gross_profit || a.name.localeCompare(b.name)),
  };
}
