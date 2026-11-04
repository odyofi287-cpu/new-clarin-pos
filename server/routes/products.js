import express from "express";
import { requireRole } from "../middleware/auth.js";
import { publishDataChange } from "../events.js";
import { dbAll, dbGet, dbRun, withTransaction } from "./dbCompat.js";

const router = express.Router();

function normalizeImageUrl(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !value.startsWith("data:image/")) {
    throw new Error("Product image must be a valid image file");
  }
  if (value.length > 4_500_000) {
    throw new Error("Product image is too large");
  }
  return value;
}
// Helpers
function computeStatus(product) {
  if (!product) return 'UNKNOWN';
  const stock = Number(product.current_stock ?? 0);
  if (stock <= 0) return 'OUT_OF_STOCK';
  if (stock > 0 && stock <= 10) return 'LOW_STOCK';
  return 'OK';
}

router.get("/", requireRole("ADMIN", "STAFF", "VENDOR"), async (req, res) => {
  try {
    const q = (req.query.q || "").toLowerCase();
    const activeParam = (req.query.active || '').toString().toLowerCase();
    const requestedInactive = activeParam === '0' || activeParam === 'false' || activeParam === 'all';
    // Vendor inventory access is read-only and limited to products currently
    // offered by the arena. Operational roles can still request archived rows.
    const includeInactive = req.user.role !== 'VENDOR' && requestedInactive;
    const products = await dbAll(
      req.db,
      `SELECT id, name, category, selling_price, current_stock, minimum_stock, unit, image_url, active FROM products WHERE deleted_at IS NULL${includeInactive ? '' : ' AND active = 1'}`
    );
    const filtered = products
      .filter(p => {
        if (!q) return true;
        return (p.name || "").toLowerCase().includes(q) || (p.category || "").toLowerCase().includes(q);
      })
      .map(p => ({ ...p, status: computeStatus(p) }));
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.json({ data: filtered });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load products" });
  }
});

// Create beverage
router.post("/", requireRole("ADMIN", "STAFF"), async (req, res) => {
  try {
    const { name, category, selling_price, unit = 'item', minimum_stock = 0, initial_stock = 0, image_url = null } = req.body;
    const normalizedImageUrl = normalizeImageUrl(image_url);
    if (!name || selling_price == null) return res.status(400).json({ error: 'name and selling_price required' });
    const result = await withTransaction(req.db, async () => {
      const created = await dbRun(
        req.db,
        "INSERT INTO products (name, category, selling_price, current_stock, minimum_stock, unit, image_url, active) VALUES ($1, $2, $3, $4, $5, $6, $7, 1) RETURNING id",
        [name, category || null, selling_price, initial_stock, minimum_stock, unit, normalizedImageUrl],
        "INSERT INTO products (name, category, selling_price, current_stock, minimum_stock, unit, image_url, active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)"
      );
      if (initial_stock > 0) {
        await dbRun(
          req.db,
          "INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_type, reference_id, user_id, created_at) VALUES ($1, 'STOCK_IN', $2, $3, $4, $5, CURRENT_TIMESTAMP) RETURNING id",
          [created.lastInsertRowid, initial_stock, 'initial_stock', null, req.user.user_id || null],
          "INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_type, reference_id, user_id, created_at) VALUES (?, 'STOCK_IN', ?, ?, ?, ?, datetime('now'))"
        );
      }
      return created;
    });
    const prodId = result.lastInsertRowid;
    const prod = await dbGet(req.db, "SELECT id, name, category, selling_price, current_stock, minimum_stock, unit, image_url, active FROM products WHERE id = $1", [prodId], "SELECT id, name, category, selling_price, current_stock, minimum_stock, unit, image_url, active FROM products WHERE id = ?");
    publishDataChange("product");
    res.status(201).json({ data: { ...prod, status: computeStatus(prod) } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

// Edit beverage metadata
router.put('/:id', requireRole('ADMIN','STAFF'), async (req,res) => {
  try {
    const id = Number(req.params.id);
    const { name, category, selling_price, unit, minimum_stock, current_stock, image_url = null } = req.body;
    const normalizedImageUrl = normalizeImageUrl(image_url);
    let stockValue = null;
    if (current_stock !== undefined) {
      stockValue = Number(current_stock);
      if (!Number.isInteger(stockValue) || stockValue < 0) {
        return res.status(400).json({ error: 'Current stock must be a non-negative whole number' });
      }
    }
    const prod = await dbGet(req.db, 'SELECT id, current_stock, deleted_at FROM products WHERE id = $1', [id], 'SELECT id, current_stock, deleted_at FROM products WHERE id = ?');
    if (!prod) return res.status(404).json({ error: 'Product not found' });
    if (prod.deleted_at) return res.status(410).json({ error: 'This product was permanently removed from the catalog' });
    await withTransaction(req.db, async () => {
      const changed = await dbRun(req.db, 'UPDATE products SET name = $1, category = $2, selling_price = $3, unit = $4, minimum_stock = $5, image_url = $6 WHERE id = $7 AND deleted_at IS NULL RETURNING id', [name, category, selling_price, unit, minimum_stock, normalizedImageUrl, id], 'UPDATE products SET name = ?, category = ?, selling_price = ?, unit = ?, minimum_stock = ?, image_url = ? WHERE id = ? AND deleted_at IS NULL');
      if (!changed.changes) throw new Error('Product is no longer available for editing');
      if (stockValue !== null) {
        await dbRun(req.db, 'UPDATE products SET current_stock = $1 WHERE id = $2 RETURNING id', [stockValue, id], 'UPDATE products SET current_stock = ? WHERE id = ?');
        const delta = stockValue - Number(prod.current_stock || 0);
        if (delta !== 0) {
          await dbRun(req.db, "INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_type, reference_id, user_id, created_at) VALUES ($1, $2, $3, 'manual_adjustment', $4, $5, CURRENT_TIMESTAMP) RETURNING id", [id, delta > 0 ? 'STOCK_IN' : 'STOCK_OUT', Math.abs(delta), id, req.user.user_id || null], "INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_type, reference_id, user_id, created_at) VALUES (?, ?, ?, 'manual_adjustment', ?, ?, datetime('now'))");
        }
      }
    });
    const updated = await dbGet(req.db, 'SELECT id, name, category, selling_price, current_stock, minimum_stock, unit, image_url, active FROM products WHERE id = $1', [id], 'SELECT id, name, category, selling_price, current_stock, minimum_stock, unit, image_url, active FROM products WHERE id = ?');
    publishDataChange("product");
    res.json({ data: { ...updated, status: computeStatus(updated) } });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to update product' }); }
});

// Activate / deactivate
router.patch('/:id/activate', requireRole('ADMIN','STAFF'), async (req,res)=>{
  try {
    const id = Number(req.params.id);
    const { active } = req.body;
    const product = await dbGet(req.db, 'SELECT id, deleted_at FROM products WHERE id = $1', [id], 'SELECT id, deleted_at FROM products WHERE id = ?');
    if (!product) return res.status(404).json({ error: 'Product not found' });
    if (product.deleted_at) return res.status(410).json({ error: 'Deleted products cannot be restored' });
    const changed = await dbRun(req.db, 'UPDATE products SET active = $1 WHERE id = $2 AND deleted_at IS NULL RETURNING id', [active ? 1 : 0, id], 'UPDATE products SET active = ? WHERE id = ? AND deleted_at IS NULL');
    if (!changed.changes) return res.status(410).json({ error: 'Deleted products cannot be restored' });
    const updated = await dbGet(req.db, 'SELECT id, name, category, selling_price, current_stock, minimum_stock, unit, active FROM products WHERE id = $1', [id], 'SELECT id, name, category, selling_price, current_stock, minimum_stock, unit, active FROM products WHERE id = ?');
    publishDataChange("product");
    res.json({ data: { ...updated, status: computeStatus(updated) } });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to set active flag' }); }
});

// Get product details
router.get('/:id', requireRole('ADMIN','STAFF','VENDOR'), async (req,res)=>{
  try {
    const id = Number(req.params.id);
    const prod = await dbGet(req.db, 'SELECT id, name, category, selling_price, current_stock, minimum_stock, unit, image_url, active, deleted_at FROM products WHERE id = $1', [id], 'SELECT id, name, category, selling_price, current_stock, minimum_stock, unit, image_url, active, deleted_at FROM products WHERE id = ?');
    if (!prod) return res.status(404).json({ error: 'Not found' });
    res.json({ data: { ...prod, status: computeStatus(prod) } });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load product' }); }
});

// Create stock movement (STOCK_IN, STOCK_OUT, ADJUSTMENT)
// Vendor portal is read-only and cannot modify inventory.
router.post('/:id/stock-movements', requireRole('ADMIN','STAFF'), async (req,res) => {
  try {
    const id = Number(req.params.id);
    const { type, quantity, reference_type = null, reference_id = null, note = null, delta } = req.body;
    if (!['STOCK_IN','STOCK_OUT','ADJUSTMENT'].includes(type)) return res.status(400).json({ error: 'invalid type' });
    if (typeof quantity !== 'number' && typeof delta !== 'number') return res.status(400).json({ error: 'quantity or delta required' });
    const qty = Math.abs(Number(quantity || Math.abs(delta || 0)));
    let change = 0;
    if (type === 'STOCK_IN') change = qty;
    else if (type === 'STOCK_OUT') change = -qty;
    else if (type === 'ADJUSTMENT') change = Number(delta || 0);

    // vendor may only create STOCK_IN
    if (req.user.role === 'VENDOR' && type !== 'STOCK_IN') return res.status(403).json({ error: 'Vendors may only add stock via STOCK_IN' });

    // Transaction wrapper: if db supports transaction, use it
    const result = await withTransaction(req.db, async () => {
      const prod = await dbGet(req.db, 'SELECT id, current_stock, deleted_at FROM products WHERE id = $1', [id], 'SELECT id, current_stock, deleted_at FROM products WHERE id = ?');
      if (!prod) throw new Error('Product not found');
      if (prod.deleted_at) throw new Error('Deleted products only accept stock adjustments from their existing deliveries and returns');
      const current = Number(prod.current_stock || 0);
      const newStock = current + change;
      if (newStock < 0) throw new Error('Insufficient stock');
      const changed = await dbRun(req.db, 'UPDATE products SET current_stock = $1 WHERE id = $2 AND deleted_at IS NULL RETURNING id', [newStock, id], 'UPDATE products SET current_stock = ? WHERE id = ? AND deleted_at IS NULL');
      if (!changed.changes) throw new Error('Product is no longer available for manual stock changes');
      await dbRun(req.db, "INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_type, reference_id, user_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP) RETURNING id", [id, type, qty, reference_type, reference_id, req.user.user_id || null], "INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_type, reference_id, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))");
      return { id, previous: current, current: newStock };
    });

    publishDataChange("inventory");
    res.json({ data: result });
  } catch (err) {
    console.error(err);
    if (err.message === 'Insufficient stock') return res.status(400).json({ error: err.message });
    res.status(500).json({ error: 'Failed to apply movement' });
  }
});

// Movement history
router.get('/:id/movements', requireRole('ADMIN','STAFF','VENDOR'), async (req,res)=>{
  try {
    const id = Number(req.params.id);
    const limit = Number(req.query.limit || 50);
    const offset = Number(req.query.offset || 0);
    const rows = await dbAll(req.db, 'SELECT id, product_id, movement_type, quantity, reference_type, reference_id, user_id, created_at FROM inventory_movements WHERE product_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3', [id, limit, offset], 'SELECT id, product_id, movement_type, quantity, reference_type, reference_id, user_id, created_at FROM inventory_movements WHERE product_id = ? ORDER BY created_at DESC');
    const pagedRows = Array.isArray(rows) && rows.length > limit && !req.db?.pool ? rows.slice(offset, offset + limit) : rows;
    res.json({ data: pagedRows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load movements' }); }
});

// Remove a product from the catalog permanently, without breaking any history
// foreign keys. Return restocking changes only current_stock, never this marker.
router.delete('/:id/permanent', requireRole('ADMIN', 'STAFF'), async (req, res) => {
  try {
    const account = await dbGet(req.db,
      'SELECT u.id, u.active, u.vendor_id, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1 AND u.active = 1',
      [Number(req.user.user_id)],
      'SELECT u.id, u.active, u.vendor_id, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ? AND u.active = 1');
    if (!account || Number(account.active) !== 1 || !['ADMIN', 'STAFF'].includes(account.role)) {
      return res.status(403).json({ error: 'An active Admin or Staff account is required to delete products' });
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid product ID' });
    const product = await dbGet(req.db, 'SELECT id, deleted_at FROM products WHERE id = $1', [id], 'SELECT id, deleted_at FROM products WHERE id = ?');
    if (!product) return res.status(404).json({ error: 'Product not found' });
    await dbRun(req.db,
      'UPDATE products SET active = 0, deleted_at = CURRENT_TIMESTAMP WHERE id = $1 AND deleted_at IS NULL RETURNING id', [id],
      'UPDATE products SET active = 0, deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL');
    publishDataChange('product');
    res.json({ data: { id, deleted: true, history_preserved: true } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Unable to delete this product from the catalog' });
  }
});

// Archive product (reversible, unlike permanent catalog deletion).
router.delete('/:id', requireRole('ADMIN','STAFF'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const prod = await dbGet(req.db, 'SELECT id, deleted_at FROM products WHERE id = $1', [id], 'SELECT id, deleted_at FROM products WHERE id = ?');
    if (!prod) return res.status(404).json({ error: 'Product not found' });
    if (prod.deleted_at) return res.status(410).json({ error: 'This product was permanently removed from the catalog' });
    await dbRun(req.db, 'UPDATE products SET active = 0 WHERE id = $1 AND deleted_at IS NULL RETURNING id', [id], 'UPDATE products SET active = 0 WHERE id = ? AND deleted_at IS NULL');
    const updated = await dbGet(req.db, 'SELECT id, name, category, selling_price, current_stock, minimum_stock, unit, active FROM products WHERE id = $1', [id], 'SELECT id, name, category, selling_price, current_stock, minimum_stock, unit, active FROM products WHERE id = ?');
    publishDataChange('product');
    res.json({ data: { ...updated, status: computeStatus(updated) } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to remove product' });
  }
});

export default router;
