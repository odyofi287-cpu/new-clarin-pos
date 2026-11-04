export function formatItemQuantity(value) {
  const quantity = Number(value || 0);
  return `${quantity.toLocaleString("en-PH")} ${quantity === 1 ? "Item" : "Items"}`;
}
