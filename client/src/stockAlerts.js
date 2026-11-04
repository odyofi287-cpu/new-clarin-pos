// Keep dashboard shortcuts and inventory lists aligned with the dashboard API:
// low stock means 1–10 items; zero/negative stock means out of stock.
export const LOW_STOCK_LIMIT = 10;

export function productStockStatus(product) {
  const stock = Number(product.current_stock);
  if (stock <= 0) return "out-of-stock";
  if (stock <= LOW_STOCK_LIMIT) return "low-stock";
  return "in-stock";
}

export function normalizeStockFilter(filter) {
  return filter === "low-stock" || filter === "out-of-stock" ? filter : "all";
}

export function productCategory(product) {
  return String(product.category || "").trim() || "General";
}

export function inventoryCategories(products = []) {
  return [...new Set(activeInventoryProducts(products).map(productCategory))].sort((a, b) => a.localeCompare(b));
}

export function activeInventoryProducts(products = [], filter = "all", search = "", category = "") {
  const stockFilter = normalizeStockFilter(filter);
  const query = search.trim().toLowerCase();
  return products.filter((product) => !product.deleted_at && Number(product.active ?? 1) === 1)
    .filter((product) => stockFilter === "all" || productStockStatus(product) === stockFilter)
    .filter((product) => !category || productCategory(product) === category)
    .filter((product) => !query || `${product.name || ""} ${product.category || ""}`.toLowerCase().includes(query));
}

// Quantity changes within one status do not repeatedly reopen a dismissed popup.
// A new affected product or a change between low/out of stock does reopen it.
export function stockAlertKey(products = []) {
  return activeInventoryProducts(products)
    .filter((product) => productStockStatus(product) !== "in-stock")
    .map((product) => `${product.id}:${productStockStatus(product)}`)
    .sort()
    .join("|");
}
