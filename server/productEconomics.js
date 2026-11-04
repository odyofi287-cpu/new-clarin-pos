import { isInMemoryDb, isPostgresDb } from "./routes/dbCompat.js";

// Nullable costs deliberately keep legacy transactions out of profit totals.
const columns = {
  products: { volume_ml: "NUMERIC", quantity_per_case: "INTEGER", base_price: "NUMERIC", markup_price: "NUMERIC" },
  sale_items: { unit_base_price: "NUMERIC" },
  delivery_items: { unit_base_price: "NUMERIC", entry_unit: "TEXT NOT NULL DEFAULT 'item'", entry_quantity: "INTEGER", case_size: "INTEGER" },
  vendor_returns: { unit_base_price: "NUMERIC" },
};

export function ensureProductEconomicsSchema(db) {
  if (isInMemoryDb(db)) return;
  if (isPostgresDb(db)) return (async () => {
    for (const [table, fields] of Object.entries(columns)) {
      for (const [name, type] of Object.entries(fields)) await db.client().query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${name} ${type}`);
    }
  })();
  for (const [table, fields] of Object.entries(columns)) {
    const existing = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!existing.length) continue;
    for (const [name, type] of Object.entries(fields)) {
      if (!existing.some((field) => field.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
}

export const money = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

function numberField(value, label, { integer = false, positive = false } = {}) {
  if (value == null || String(value).trim() === "" || typeof value === "boolean") throw new Error(`${label} is required`);
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1_000_000_000 || (positive && number === 0) || (integer && !Number.isSafeInteger(number))) {
    throw new Error(`${label} must be a valid ${positive ? "positive" : "non-negative"} ${integer ? "whole number" : "number"}`);
  }
  if (!integer && Math.abs(number * 100 - Math.round(number * 100)) > 0.00001) throw new Error(`${label} supports at most two decimal places`);
  return integer ? number : money(number);
}

export function productEconomicsInput(body, existing = {}) {
  const value = (name) => body[name] === undefined ? existing[name] : body[name];
  const pricingSupplied = body.base_price !== undefined || body.markup_price !== undefined;
  const base = value("base_price");
  const markup = value("markup_price");
  const known = pricingSupplied || (base != null && markup != null);
  const basePrice = known ? numberField(base, "Product base price") : null;
  const markupPrice = known ? numberField(markup, "Mark-up price") : null;
  const volume = value("volume_ml");
  const caseSize = value("quantity_per_case");
  return {
    base_price: basePrice,
    markup_price: markupPrice,
    selling_price: known ? money(basePrice + markupPrice) : numberField(body.selling_price ?? existing.selling_price, "Selling price"),
    volume_ml: volume == null ? null : numberField(volume, "Product volume (mL)", { positive: true }),
    quantity_per_case: caseSize == null ? null : numberField(caseSize, "Quantity per case", { integer: true, positive: true }),
  };
}

export function deliveryQuantity(item, product) {
  const entryUnit = item.entry_unit || "item";
  if (!["item", "half-case", "case"].includes(entryUnit)) throw new Error("Choose Item, Half-case, or Case for a delivery");
  const count = numberField(item.entry_quantity ?? item.quantity, "Delivery quantity", { integer: true, positive: true });
  const caseSize = product.quantity_per_case == null ? null : Number(product.quantity_per_case);
  if (entryUnit !== "item" && (!Number.isSafeInteger(caseSize) || caseSize <= 0)) throw new Error("Set the product quantity per case before delivering cases");
  if (entryUnit === "half-case" && caseSize % 2 !== 0) throw new Error("Half-case delivery requires an even quantity per case");
  const quantity = count * (entryUnit === "item" ? 1 : entryUnit === "case" ? caseSize : caseSize / 2);
  if (!Number.isSafeInteger(quantity) || quantity > 2_000_000_000) throw new Error("Delivery quantity is too large");
  return { quantity, entryUnit, entryQuantity: count, caseSize: entryUnit === "item" ? null : caseSize };
}
