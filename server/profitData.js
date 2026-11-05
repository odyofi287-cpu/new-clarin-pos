import { dbAll, isInMemoryDb } from "./routes/dbCompat.js";
import { allTimeSalesRange, reportDate, reportRange } from "./reportData.js";
import { money } from "./productEconomics.js";

export async function getProfitEvents(db, start, end) {
  if (isInMemoryDb(db)) {
    const sales = new Map(db.sales.map((row) => [Number(row.id), row]));
    const deliveries = new Map(db.deliveries.map((row) => [Number(row.id), row]));
    const products = new Map(db.products.map((row) => [Number(row.id), row]));
    const originalReturnCost = (entry) => {
      if (entry.unit_base_price != null) return { cost: entry.unit_base_price, estimated: false };
      const items = db.delivery_items.filter((item) => Number(item.delivery_id) === Number(entry.delivery_id) && Number(item.product_id) === Number(entry.product_id));
      const quantity = items.reduce((sum, item) => sum + Number(item.quantity), 0);
      const baseline = products.get(Number(entry.product_id))?.legacy_base_price ?? null;
      return items.length && quantity > 0 && items.every((item) => (item.unit_base_price ?? baseline) != null)
        ? { cost: items.reduce((sum, item) => sum + Number(item.quantity) * Number(item.unit_base_price ?? baseline), 0) / quantity, estimated: items.some((item) => item.unit_base_price == null) }
        : { cost: null, estimated: false };
    };
    return [
      ...db.sale_items.map((item) => ({ ...item, actor_id: sales.get(Number(item.sale_id))?.user_id ?? null, was_missing: item.unit_base_price == null, date: reportDate(sales.get(Number(item.sale_id))?.sale_date), kind: "recorded", revenue: Number(item.quantity) * Number(item.unit_price) })),
      ...db.delivery_items.map((item) => ({ ...item, actor_id: deliveries.get(Number(item.delivery_id))?.created_by ?? null, was_missing: item.unit_base_price == null, date: reportDate(deliveries.get(Number(item.delivery_id))?.delivery_date), kind: "delivery", revenue: Number(item.quantity) * Number(item.unit_cost) })),
      ...db.vendor_returns.map((item) => { const original = originalReturnCost(item); return { ...item, actor_id: deliveries.get(Number(item.delivery_id))?.created_by ?? null, was_missing: item.unit_base_price == null, unit_base_price: original.cost, uses_estimate: original.estimated, date: reportDate(item.return_date), kind: "return", revenue: -Number(item.total_product_price_returned) }; }),
    ].filter((item) => item.date >= start && item.date <= end).map((item) => {
      const resolvedCost = item.unit_base_price ?? products.get(Number(item.product_id))?.legacy_base_price ?? null;
      return {
        date: item.date, kind: item.kind, product_id: item.product_id, actor_id: item.actor_id == null ? null : Number(item.actor_id), quantity: Number(item.quantity), revenue: item.revenue,
        known_revenue: resolvedCost == null ? 0 : item.revenue,
        base_cost: resolvedCost == null ? 0 : Number(item.quantity) * Number(resolvedCost) * (item.kind === "return" ? -1 : 1),
        missing_cost_items: resolvedCost == null ? Number(item.quantity) : 0,
        missing_cost_lines: resolvedCost == null ? 1 : 0,
        reconstructed_cost_items: item.was_missing && resolvedCost != null ? Number(item.quantity) : 0,
        estimated_cost_items: (item.unit_base_price == null || item.uses_estimate) && resolvedCost != null ? Number(item.quantity) : 0,
      };
    });
  }
  // Saved transaction costs take precedence. Only gaps use the immutable
  // catalog baseline; reporting never rewrites a transaction or uses live prices.
  return dbAll(db, `WITH events AS (
      SELECT s.sale_date AS event_date, 'recorded' AS kind, si.product_id, si.quantity, s.user_id AS actor_id,
        si.quantity * si.unit_price AS revenue, si.unit_base_price, 1 AS direction,
        CASE WHEN si.unit_base_price IS NULL THEN 1 ELSE 0 END AS was_missing, 0 AS uses_estimate
        FROM sales s JOIN sale_items si ON si.sale_id = s.id WHERE s.sale_date BETWEEN $1 AND $2
      UNION ALL
      SELECT d.delivery_date, 'delivery', di.product_id, di.quantity, d.created_by, di.quantity * di.unit_cost, di.unit_base_price, 1,
        CASE WHEN di.unit_base_price IS NULL THEN 1 ELSE 0 END, 0
        FROM deliveries d JOIN delivery_items di ON di.delivery_id = d.id WHERE d.delivery_date BETWEEN $3 AND $4
      UNION ALL
      SELECT vr.return_date, 'return', vr.product_id, vr.quantity, origin.created_by, -vr.total_product_price_returned,
        COALESCE(vr.unit_base_price, (SELECT CASE WHEN COUNT(*) = COUNT(COALESCE(original.unit_base_price, basis.legacy_base_price))
          THEN SUM(original.quantity * COALESCE(original.unit_base_price, basis.legacy_base_price)) * 1.0 / NULLIF(SUM(original.quantity), 0) ELSE NULL END
          FROM delivery_items original LEFT JOIN products basis ON basis.id = original.product_id
          WHERE original.delivery_id = vr.delivery_id AND original.product_id = vr.product_id)), -1,
        CASE WHEN vr.unit_base_price IS NULL THEN 1 ELSE 0 END,
        CASE WHEN vr.unit_base_price IS NULL AND EXISTS (SELECT 1 FROM delivery_items original
          WHERE original.delivery_id = vr.delivery_id AND original.product_id = vr.product_id AND original.unit_base_price IS NULL) THEN 1 ELSE 0 END
        FROM vendor_returns vr LEFT JOIN deliveries origin ON origin.id = vr.delivery_id WHERE vr.return_date BETWEEN $5 AND $6
    ), resolved AS (SELECT events.*, COALESCE(events.unit_base_price, p.legacy_base_price) AS resolved_cost
      FROM events LEFT JOIN products p ON p.id = events.product_id)
    SELECT event_date AS date, kind, product_id, actor_id, SUM(quantity) AS quantity, SUM(revenue) AS revenue,
      SUM(CASE WHEN resolved_cost IS NOT NULL THEN revenue ELSE 0 END) AS known_revenue,
      SUM(CASE WHEN resolved_cost IS NOT NULL THEN quantity * resolved_cost * direction ELSE 0 END) AS base_cost,
      SUM(CASE WHEN resolved_cost IS NULL THEN quantity ELSE 0 END) AS missing_cost_items,
      SUM(CASE WHEN resolved_cost IS NULL THEN 1 ELSE 0 END) AS missing_cost_lines,
      SUM(CASE WHEN was_missing = 1 AND resolved_cost IS NOT NULL THEN quantity ELSE 0 END) AS reconstructed_cost_items,
      SUM(CASE WHEN (unit_base_price IS NULL OR uses_estimate = 1) AND resolved_cost IS NOT NULL THEN quantity ELSE 0 END) AS estimated_cost_items
    FROM resolved GROUP BY event_date, kind, product_id, actor_id ORDER BY event_date`, [start, end, start, end, start, end]);
}

export function summarizeProfit(events) {
  const result = { gross_profit: 0, net_sales: 0, known_revenue: 0, base_cost: 0, missing_cost_items: 0, missing_cost_lines: 0, reconstructed_cost_items: 0, estimated_cost_items: 0, recorded_profit: 0, delivery_profit: 0, return_profit: 0,
    capital: 0, recorded_capital: 0, delivery_capital: 0, return_capital: 0,
    recorded_sales: 0, delivery_sales: 0, return_sales: 0,
    recorded_quantity: 0, delivered_quantity: 0, returned_quantity: 0, net_quantity: 0 };
  for (const row of events) {
    result.net_sales += Number(row.revenue || 0);
    result.known_revenue += Number(row.known_revenue || 0);
    result.base_cost += Number(row.base_cost || 0);
    result.missing_cost_items += Number(row.missing_cost_items || 0);
    result.missing_cost_lines += Number(row.missing_cost_lines || 0);
    result.reconstructed_cost_items += Number(row.reconstructed_cost_items || 0);
    result.estimated_cost_items += Number(row.estimated_cost_items || 0);
    result[`${row.kind}_capital`] += Number(row.base_cost || 0);
    result[`${row.kind}_sales`] += Number(row.revenue || 0);
    const quantityField = { recorded: "recorded_quantity", delivery: "delivered_quantity", return: "returned_quantity" }[row.kind];
    result[quantityField] += Number(row.quantity || 0);
    const profit = Number(row.known_revenue || 0) - Number(row.base_cost || 0);
    result.gross_profit += profit;
    result[`${row.kind}_profit`] += profit;
  }
  for (const field of Object.keys(result)) result[field] = money(result[field]);
  // Capital is the historical base cost of sold/delivered items, net of returns.
  // Keep base_cost for existing dashboard/report consumers.
  result.capital = result.base_cost;
  result.net_quantity = result.recorded_quantity + result.delivered_quantity - result.returned_quantity;
  result.gross_profit = money(result.known_revenue - result.capital);
  return result;
}

export async function buildAccountProfitBreakdown(db, events, start, end) {
  reportRange({ start_date: start, end_date: end });
  const selected = events.filter((row) => reportDate(row.date) >= start && reportDate(row.date) <= end);
  const users = isInMemoryDb(db)
    ? db.users.map((user) => ({ id: user.id, name: user.name, username: user.username, active: user.active, role: db.roles.find((role) => Number(role.id) === Number(user.role_id))?.name }))
    : await dbAll(db, "SELECT u.id, u.name, u.username, u.active, r.name AS role FROM users u LEFT JOIN roles r ON r.id = u.role_id");
  const groups = new Map();
  for (const row of selected) {
    const id = row.actor_id == null ? null : Number(row.actor_id);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(row);
  }
  for (const user of users) {
    if (Number(user.active) === 1 && ["ADMIN", "STAFF"].includes(user.role) && !groups.has(Number(user.id))) groups.set(Number(user.id), []);
  }
  const userMap = new Map(users.map((user) => [Number(user.id), user]));
  const accounts = [...groups].map(([id, rows]) => {
    const user = userMap.get(id);
    return { user_id: id, name: user?.name || (id == null ? "Unattributed records" : `Account #${id}`), username: user?.username || null,
      role: user?.role || "UNASSIGNED", active: user ? Number(user.active) === 1 : false, ...summarizeProfit(rows) };
  }).sort((a, b) => b.gross_profit - a.gross_profit || a.name.localeCompare(b.name) || Number(a.user_id) - Number(b.user_id));
  const totals = summarizeProfit(selected);
  const rounding_difference = Object.fromEntries(["capital", "gross_profit"].map((key) => [key, money(totals[key] - accounts.reduce((sum, row) => sum + row[key], 0))]));
  return { start_date: start, end_date: end, totals, accounts, rounding_difference };
}

export async function profitReport(db, start, end, today, { includeAccounts = false } = {}) {
  const year = today.slice(0, 4);
  const allTimeRange = await allTimeSalesRange(db);
  const first = [start, `${year}-01-01`, allTimeRange.start].sort()[0];
  const last = [end, `${year}-12-31`, allTimeRange.end].sort().at(-1);
  const events = await getProfitEvents(db, first, last);
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
    ...(includeAccounts ? { account_breakdown: await buildAccountProfitBreakdown(db, selected, start, end) } : {}),
    all_time_range: { start_date: allTimeRange.start, end_date: allTimeRange.end },
    summary: {
      range: summarizeProfit(selected),
      daily: summarizeProfit(events.filter((row) => reportDate(row.date) === today)),
      monthly: summarizeProfit(events.filter((row) => reportDate(row.date).slice(0, 7) === today.slice(0, 7))),
      yearly: summarizeProfit(events.filter((row) => reportDate(row.date).slice(0, 4) === year)),
      all_time: summarizeProfit(events),
    },
    all_time: [{ period: "All time", ...summarizeProfit(events) }],
    daily: groupBy((row) => reportDate(row.date)).sort((a, b) => b.period.localeCompare(a.period)),
    monthly: groupBy((row) => reportDate(row.date).slice(0, 7)).sort((a, b) => b.period.localeCompare(a.period)),
    yearly: groupBy((row) => reportDate(row.date).slice(0, 4)).sort((a, b) => b.period.localeCompare(a.period)),
    products: groupBy((row) => Number(row.product_id)).map(({ period, ...totals }) => {
      const product = productMap.get(period);
      return { product_id: period, name: product?.name || "Retained product", category: product?.category, image_url: product?.image_url || null, volume_ml: product?.volume_ml, ...totals };
    }).sort((a, b) => b.gross_profit - a.gross_profit || a.name.localeCompare(b.name)),
  };
}
