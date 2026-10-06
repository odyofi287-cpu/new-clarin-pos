import { dbGet, dbRun, isInMemoryDb } from "./dbCompat.js";

export async function restockVendorReturn(db, entry, userId) {
  const result = await dbRun(db,
    "UPDATE products SET current_stock = current_stock + $1 WHERE id = $2 RETURNING id",
    [entry.quantity, entry.product_id],
    "UPDATE products SET current_stock = current_stock + ? WHERE id = ?"
  );
  if (!result.changes) throw new Error(`Product ${entry.product_id} not found`);
  await dbRun(db,
    `INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_type, reference_id, user_id, created_at)
     VALUES ($1, 'STOCK_IN', $2, 'VENDOR_RETURN', $3, $4, CURRENT_TIMESTAMP) RETURNING id`,
    [entry.product_id, entry.quantity, entry.id, userId],
    `INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_type, reference_id, user_id, created_at)
     VALUES (?, 'STOCK_IN', ?, 'VENDOR_RETURN', ?, ?, datetime('now'))`
  );
}

export async function reverseVendorReturnStock(db, entry, userId) {
  // Older returns did not restock inventory. Reverse only a recorded stock-in,
  // so deleting historical returns cannot deduct stock that was never restored.
  const quantity = isInMemoryDb(db)
    ? db.inventory_movements.filter((movement) => movement.reference_type === "VENDOR_RETURN"
        && movement.movement_type === "STOCK_IN"
        && Number(movement.reference_id) === Number(entry.id)
        && Number(movement.product_id) === Number(entry.product_id))
      .reduce((sum, movement) => sum + Number(movement.quantity), 0)
    : Number((await dbGet(db,
        `SELECT COALESCE(SUM(quantity), 0) AS quantity FROM inventory_movements
         WHERE reference_type = 'VENDOR_RETURN' AND movement_type = 'STOCK_IN'
           AND reference_id = $1 AND product_id = $2`,
        [entry.id, entry.product_id]
      )).quantity);
  if (!quantity) return;

  const result = await dbRun(db,
    "UPDATE products SET current_stock = current_stock - $1 WHERE id = $2 AND current_stock >= $3 RETURNING id",
    [quantity, entry.product_id, quantity],
    "UPDATE products SET current_stock = current_stock - ? WHERE id = ? AND current_stock >= ?"
  );
  if (!result.changes) {
    throw new Error(`Cannot remove this return: product ${entry.product_id} needs ${quantity} units in stock to reverse its restock`);
  }
  await dbRun(db,
    `INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_type, reference_id, user_id, created_at)
     VALUES ($1, 'STOCK_OUT', $2, 'VENDOR_RETURN_REMOVAL', $3, $4, CURRENT_TIMESTAMP) RETURNING id`,
    [entry.product_id, quantity, entry.id, userId],
    `INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_type, reference_id, user_id, created_at)
     VALUES (?, 'STOCK_OUT', ?, 'VENDOR_RETURN_REMOVAL', ?, ?, datetime('now'))`
  );
}
