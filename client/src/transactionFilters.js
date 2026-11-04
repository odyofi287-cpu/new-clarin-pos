export const UNATTRIBUTED_ACCOUNT = "unattributed";
export const transactionActorKey = (record) => record.actor_id == null ? UNATTRIBUTED_ACCOUNT : String(record.actor_id);

export function filterTransactions(records, { product = "", account = "" }) {
  return records.filter((record) => (!product || (record.product_refs || []).some((item) => String(item.id) === product))
    && (!account || transactionActorKey(record) === account));
}

export function transactionFilterOptions(records, catalog = []) {
  const products = new Map(catalog.map((product) => [String(product.id), { id: String(product.id), name: product.name }]));
  const accounts = new Map();
  for (const record of records) {
    for (const product of record.product_refs || []) products.set(String(product.id), { id: String(product.id), name: product.name });
    const id = transactionActorKey(record);
    accounts.set(id, { id, name: record.actor_name || record.sold_by || (id === UNATTRIBUTED_ACCOUNT ? "Unattributed account" : `Account #${id}`), username: record.actor_username || "" });
  }
  return { products: [...products.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    accounts: [...accounts.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) };
}
