import { dbAll, isInMemoryDb } from "./routes/dbCompat.js";
import { reportDate, reportRange } from "./reportData.js";
import { money } from "./productEconomics.js";

const emptyTotals = () => ({ recorded_sales: 0, delivery_total: 0, return_total: 0, sale_count: 0, delivery_count: 0, return_count: 0 });

export async function accountSalesReport(db, start, end) {
  reportRange({ start_date: start, end_date: end });
  let activity;
  let users;
  if (isInMemoryDb(db)) {
    users = db.users.map((user) => ({ id: user.id, name: user.name, username: user.username, active: user.active, role: db.roles.find((role) => role.id === user.role_id)?.name }));
    const within = (value) => reportDate(value) >= start && reportDate(value) <= end;
    const byActor = new Map();
    const actor = (id) => {
      const key = id == null ? null : Number(id);
      if (!byActor.has(key)) byActor.set(key, { actor_id: key, ...emptyTotals(), return_keys: new Set() });
      return byActor.get(key);
    };
    for (const sale of db.sales.filter((row) => within(row.sale_date))) {
      const row = actor(sale.user_id); row.recorded_sales += Number(sale.total_amount || 0); row.sale_count++;
    }
    for (const delivery of db.deliveries.filter((row) => within(row.delivery_date))) {
      const row = actor(delivery.created_by); row.delivery_total += Number(delivery.total_amount || 0); row.delivery_count++;
    }
    const deliveries = new Map(db.deliveries.map((row) => [Number(row.id), row]));
    for (const entry of db.vendor_returns.filter((row) => within(row.return_date))) {
      // Reverse the original delivery owner's contribution, not the return clerk's.
      const row = actor(deliveries.get(Number(entry.delivery_id))?.created_by);
      row.return_total += Number(entry.total_product_price_returned || 0);
      row.return_keys.add(entry.return_batch_id || `legacy-${entry.id}`);
    }
    activity = [...byActor.values()].map(({ return_keys, ...row }) => ({ ...row, return_count: return_keys.size }));
  } else {
    // One bounded ledger snapshot. Parent totals are never multiplied by item
    // joins, and a multi-product return batch counts only once per account.
    activity = await dbAll(db, `WITH activity AS (
      SELECT user_id AS actor_id, total_amount AS recorded_sales, 0 AS delivery_total, 0 AS return_total,
        1 AS sale_count, 0 AS delivery_count, CAST(NULL AS TEXT) AS return_key
        FROM sales WHERE sale_date BETWEEN $1 AND $2
      UNION ALL
      SELECT created_by, 0, total_amount, 0, 0, 1, CAST(NULL AS TEXT)
        FROM deliveries WHERE delivery_date BETWEEN $3 AND $4
      UNION ALL
      SELECT d.created_by, 0, 0, vr.total_product_price_returned, 0, 0,
        COALESCE(vr.return_batch_id, 'legacy-' || CAST(vr.id AS TEXT))
        FROM vendor_returns vr LEFT JOIN deliveries d ON d.id = vr.delivery_id
        WHERE vr.return_date BETWEEN $5 AND $6
    ) SELECT actor_id, SUM(recorded_sales) AS recorded_sales, SUM(delivery_total) AS delivery_total,
      SUM(return_total) AS return_total, SUM(sale_count) AS sale_count, SUM(delivery_count) AS delivery_count,
      COUNT(DISTINCT return_key) AS return_count FROM activity GROUP BY actor_id`, [start, end, start, end, start, end]);
    users = await dbAll(db, "SELECT u.id, u.name, u.username, u.active, r.name AS role FROM users u LEFT JOIN roles r ON r.id = u.role_id");
  }
  const userMap = new Map(users.map((user) => [Number(user.id), user]));
  const rows = new Map(activity.map((row) => [row.actor_id == null ? null : Number(row.actor_id), row]));
  // Active operational accounts remain visible even with no transactions.
  for (const user of users) {
    if (Number(user.active) === 1 && ["ADMIN", "STAFF"].includes(user.role) && !rows.has(Number(user.id))) rows.set(Number(user.id), emptyTotals());
  }
  const accounts = [...rows.entries()].map(([id, values]) => {
    const user = userMap.get(id);
    const totals = Object.fromEntries(Object.keys(emptyTotals()).map((field) => [field, Number(values[field] || 0)]));
    return { user_id: id, name: user?.name || (id == null ? "Unattributed records" : `Account #${id}`), username: user?.username || null,
      role: user?.role || "UNASSIGNED", active: user ? Number(user.active) === 1 : false,
      ...totals, net_sales: money(totals.recorded_sales + totals.delivery_total - totals.return_total),
      transaction_count: totals.sale_count + totals.delivery_count + totals.return_count };
  }).sort((a, b) => b.net_sales - a.net_sales || a.name.localeCompare(b.name) || Number(a.user_id) - Number(b.user_id));
  const totals = accounts.reduce((sum, row) => {
    for (const field of Object.keys(sum)) sum[field] += row[field];
    return sum;
  }, { ...emptyTotals(), net_sales: 0, transaction_count: 0 });
  for (const field of Object.keys(totals)) totals[field] = money(totals[field]);
  return { start_date: start, end_date: end, totals, accounts };
}
