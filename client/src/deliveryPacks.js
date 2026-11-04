export function packSize(product, mode = "item") {
  const size = Number(product.quantity_per_case);
  if (mode === "item") return 1;
  if (!Number.isSafeInteger(size) || size <= 0) return 0;
  if (mode === "case") return size;
  return mode === "half-case" && size % 2 === 0 ? size / 2 : 0;
}

export function packLabel(mode, count) {
  if (mode === "case") return `${count} case${count === 1 ? "" : "s"}`;
  if (mode === "half-case") return `${count} half-case${count === 1 ? "" : "s"}`;
  return `${count} Item${count === 1 ? "" : "s"}`;
}
