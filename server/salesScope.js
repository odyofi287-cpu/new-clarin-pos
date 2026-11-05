import { dbAll, isInMemoryDb } from "./routes/dbCompat.js";

// Identity comes only from the verified session, never a report query parameter.
export function requireSalesIdentity(req, res, next) {
  if (req.user?.role === "STAFF" && (!Number.isSafeInteger(Number(req.user.user_id)) || Number(req.user.user_id) <= 0)) {
    return res.status(403).json({ error: "A signed-in Staff account is required" });
  }
  res.set("Cache-Control", "no-store");
  next();
}

export function salesScope(user) {
  return { sales_scope: user.role === "ADMIN" ? "all" : "own", sales_account_id: user.role === "ADMIN" ? null : Number(user.user_id) };
}

// A read-only ledger snapshot for the existing report builders. Filtering happens
// in SQL before any financial rows leave the database. Admin keeps the original
// aggregation paths; Staff receives only their own parent records and line items.
// Return attribution follows the original delivery, not the return clerk.
export async function salesReportingDb(db, user) {
  if (user.role === "ADMIN") return db;
  const id = Number(user.user_id);
  if (user.role !== "STAFF" || !Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid sales reporting account");
  if (isInMemoryDb(db)) {
    const sales = db.sales.filter((row) => Number(row.user_id) === id);
    const deliveries = db.deliveries.filter((row) => Number(row.created_by) === id);
    const saleIds = new Set(sales.map((row) => Number(row.id)));
    const deliveryIds = new Set(deliveries.map((row) => Number(row.id)));
    const vendorIds = new Set(deliveries.map((row) => Number(row.vendor_id)));
    return {
      sales, deliveries,
      sale_items: db.sale_items.filter((row) => saleIds.has(Number(row.sale_id))),
      delivery_items: db.delivery_items.filter((row) => deliveryIds.has(Number(row.delivery_id))),
      vendor_returns: db.vendor_returns.filter((row) => row.delivery_id != null && deliveryIds.has(Number(row.delivery_id))),
      products: db.products,
      users: (db.users || []).filter((row) => Number(row.id) === id || (row.vendor_id != null && vendorIds.has(Number(row.vendor_id)))),
      vendors: db.vendors || [],
    };
  }
  const [sales, deliveries, saleItems, deliveryItems, returns, products, users, vendors] = await Promise.all([
    dbAll(db, "SELECT s.* FROM sales s WHERE s.user_id = $1", [id]),
    dbAll(db, "SELECT d.* FROM deliveries d WHERE d.created_by = $1", [id]),
    dbAll(db, "SELECT si.* FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.user_id = $1", [id]),
    dbAll(db, "SELECT di.* FROM delivery_items di JOIN deliveries d ON d.id = di.delivery_id WHERE d.created_by = $1", [id]),
    dbAll(db, "SELECT vr.* FROM vendor_returns vr JOIN deliveries d ON d.id = vr.delivery_id WHERE d.created_by = $1", [id]),
    dbAll(db, "SELECT id, name, category, image_url, unit, volume_ml, current_stock, minimum_stock, active, deleted_at, quantity_per_case, base_price, markup_price, legacy_base_price, selling_price FROM products"),
    dbAll(db, "SELECT u.id, u.name, u.username, u.vendor_id, u.active FROM users u WHERE u.id = $1 OR EXISTS (SELECT 1 FROM deliveries d WHERE d.vendor_id = u.vendor_id AND d.created_by = $2)", [id, id]),
    dbAll(db, "SELECT v.id, v.name FROM vendors v WHERE EXISTS (SELECT 1 FROM deliveries d WHERE d.vendor_id = v.id AND d.created_by = $1)", [id]),
  ]);
  return { sales, deliveries, sale_items: saleItems, delivery_items: deliveryItems, vendor_returns: returns, products, users, vendors };
}
