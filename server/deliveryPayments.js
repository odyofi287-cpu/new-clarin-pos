import { dbAll, isInMemoryDb } from "./routes/dbCompat.js";
import { money } from "./productEconomics.js";

// FULLY_RETURNED is a calculated settlement state, not a payment confirmation.
// Keep the stored PAID/UNPAID value and its audit fields unchanged.
export function buildDeliveryPaymentAccounts(deliveries, returns = [], deliveryItems) {
  const deductions = new Map();
  const returned = new Map();
  const delivered = new Map();
  for (const entry of returns) {
    if (entry.delivery_id == null) continue;
    const id = Number(entry.delivery_id);
    deductions.set(id, (deductions.get(id) || 0) + Number(entry.total_product_price_returned || 0));
    const key = `${id}:${Number(entry.product_id)}`;
    returned.set(key, (returned.get(key) || 0) + Number(entry.quantity || 0));
  }
  for (const item of deliveryItems || []) {
    const id = Number(item.delivery_id);
    if (!delivered.has(id)) delivered.set(id, new Map());
    const products = delivered.get(id);
    const productId = Number(item.product_id);
    products.set(productId, (products.get(productId) || 0) + Number(item.quantity || 0));
  }
  return deliveries.map((delivery) => {
    const id = Number(delivery.id);
    const original = money(Number(delivery.total_amount ?? delivery.original_amount ?? 0));
    const deduction = money(deductions.get(id) ?? Number(delivery.return_deduction || 0));
    const recorded = String(delivery.recorded_payment_status ?? delivery.payment_status ?? "UNPAID").toUpperCase();
    const products = delivered.get(id);
    const allItemsReturned = deliveryItems === undefined
      ? delivery.fully_returned === true || delivery.payment_status === "FULLY_RETURNED"
      : Boolean(products?.size) && [...products].every(([productId, quantity]) =>
        quantity > 0 && (returned.get(`${id}:${productId}`) || 0) >= quantity);
    const fullyReturned = recorded !== "PAID" && allItemsReturned;
    return {
      ...delivery,
      recorded_payment_status: recorded === "PAID" ? "PAID" : "UNPAID",
      payment_status: recorded === "PAID" ? "PAID" : fullyReturned ? "FULLY_RETURNED" : "UNPAID",
      fully_returned: fullyReturned,
      original_amount: original,
      return_deduction: deduction,
      amount_due: fullyReturned ? 0 : money(Math.max(original - deduction, 0)),
    };
  });
}

export async function addDeliveryPaymentAccounts(db, value) {
  const rows = Array.isArray(value) ? value : value ? [value] : [];
  if (!rows.length) return value;
  const ids = [...new Set(rows.map((row) => Number(row.id)))];
  let returns, items;
  if (isInMemoryDb(db)) {
    const selected = new Set(ids);
    returns = db.vendor_returns.filter((row) => selected.has(Number(row.delivery_id)));
    items = db.delivery_items.filter((row) => selected.has(Number(row.delivery_id)));
  } else {
    // Bound to the already-authorized deliveries; no full-table scan or per-row query.
    const params = ids.map((_, index) => `$${index + 1}`).join(", ");
    returns = await dbAll(db, `SELECT delivery_id, product_id, quantity, total_product_price_returned
      FROM vendor_returns WHERE delivery_id IN (${params})`, ids);
    items = await dbAll(db, `SELECT delivery_id, product_id, quantity
      FROM delivery_items WHERE delivery_id IN (${params})`, ids);
  }
  const enriched = buildDeliveryPaymentAccounts(rows, returns, items);
  return Array.isArray(value) ? enriched : enriched[0];
}
