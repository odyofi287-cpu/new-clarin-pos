// Stable IDs keep filters correct for duplicate names, punctuation, renames,
// and products permanently hidden from the active catalog.
export function productReferences(value) {
  let rows = value;
  if (typeof rows === "string") { try { rows = JSON.parse(rows); } catch { rows = []; } }
  if (!Array.isArray(rows)) return [];
  const result = new Map();
  for (const row of rows) {
    const id = Number(row?.id);
    if (Number.isSafeInteger(id) && id > 0) result.set(id, { id, name: String(row.name || `Product #${id}`) });
  }
  return [...result.values()];
}
