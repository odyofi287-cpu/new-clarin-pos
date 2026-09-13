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

router.get("/", requireRole("SUPERADMIN", "ADMIN", "STAFF", "VENDOR"), async (req, res) => {
  try {
    const q = (req.query.q || "").toLowerCase();
    const activeParam = (req.query.active || '').toString().toLowerCase();
    const includeInactive = activeParam === '0' || activeParam === 'false' || activeParam === 'all';
    const products = await dbAll(
      req.db,
      `SELECT id, name, category, selling_price, current_stock, minimum_stock, unit, image_url, active FROM products${includeInactive ? '' : ' WHERE active = 1'}`
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
router.post("/", requireRole("SUPERADMIN", "ADMIN", "STAFF"), async (req, res) => {
  try {
    const { name, category, selling_price, unit = 'unit', minimum_stock = 0, initial_stock = 0, image_url = null } = req.body;
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
router.put('/:id', requireRole('SUPERADMIN','ADMIN','STAFF'), async (req,res) => {
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
    const prod = await dbGet(req.db, 'SELECT id, current_stock FROM products WHERE id = $1', [id], 'SELECT id, current_stock FROM products WHERE id = ?');
    if (!prod) return res.status(404).json({ error: 'Product not found' });
    await withTransaction(req.db, async () => {
      await dbRun(req.db, 'UPDATE products SET name = $1, category = $2, selling_price = $3, unit = $4, minimum_stock = $5, image_url = $6 WHERE id = $7 RETURNING id', [name, category, selling_price, unit, minimum_stock, normalizedImageUrl, id], 'UPDATE products SET name = ?, category = ?, selling_price = ?, unit = ?, minimum_stock = ?, image_url = ? WHERE id = ?');
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
router.patch('/:id/activate', requireRole('SUPERADMIN','ADMIN','STAFF'), async (req,res)=>{
  try {
    const id = Number(req.params.id);
    const { active } = req.body;
    await dbRun(req.db, 'UPDATE products SET active = $1 WHERE id = $2 RETURNING id', [active ? 1 : 0, id], 'UPDATE products SET active = ? WHERE id = ?');
    const updated = await dbGet(req.db, 'SELECT id, name, category, selling_price, current_stock, minimum_stock, unit, active FROM products WHERE id = $1', [id], 'SELECT id, name, category, selling_price, current_stock, minimum_stock, unit, active FROM products WHERE id = ?');
    publishDataChange("product");
    res.json({ data: { ...updated, status: computeStatus(updated) } });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to set active flag' }); }
});

// Get product details
router.get('/:id', requireRole('SUPERADMIN','ADMIN','STAFF','VENDOR'), async (req,res)=>{
  try {
    const id = Number(req.params.id);
    const prod = await dbGet(req.db, 'SELECT id, name, category, selling_price, current_stock, minimum_stock, unit, image_url, active FROM products WHERE id = $1', [id], 'SELECT id, name, category, selling_price, current_stock, minimum_stock, unit, image_url, active FROM products WHERE id = ?');
    if (!prod) return res.status(404).json({ error: 'Not found' });
    res.json({ data: { ...prod, status: computeStatus(prod) } });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load product' }); }
});

// Create stock movement (STOCK_IN, STOCK_OUT, ADJUSTMENT)
// Vendor portal is read-only and cannot modify inventory.
router.post('/:id/stock-movements', requireRole('SUPERADMIN','ADMIN','STAFF'), async (req,res) => {
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
      const prod = await dbGet(req.db, 'SELECT id, current_stock FROM products WHERE id = $1', [id], 'SELECT id, current_stock FROM products WHERE id = ?');
      if (!prod) throw new Error('Product not found');
      const current = Number(prod.current_stock || 0);
      const newStock = current + change;
      if (newStock < 0) throw new Error('Insufficient stock');
      await dbRun(req.db, 'UPDATE products SET current_stock = $1 WHERE id = $2 RETURNING id', [newStock, id], 'UPDATE products SET current_stock = ? WHERE id = ?');
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
router.get('/:id/movements', requireRole('SUPERADMIN','ADMIN','STAFF','VENDOR'), async (req,res)=>{
  try {
    const id = Number(req.params.id);
    const limit = Number(req.query.limit || 50);
    const offset = Number(req.query.offset || 0);
    const rows = await dbAll(req.db, 'SELECT id, product_id, movement_type, quantity, reference_type, reference_id, user_id, created_at FROM inventory_movements WHERE product_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3', [id, limit, offset], 'SELECT id, product_id, movement_type, quantity, reference_type, reference_id, user_id, created_at FROM inventory_movements WHERE product_id = ? ORDER BY created_at DESC');
    const pagedRows = Array.isArray(rows) && rows.length > limit && !req.db?.pool ? rows.slice(offset, offset + limit) : rows;
    res.json({ data: pagedRows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load movements' }); }
});

// Soft-delete product (mark inactive)
router.delete('/:id', requireRole('SUPERADMIN','ADMIN','STAFF'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const prod = await dbGet(req.db, 'SELECT id FROM products WHERE id = $1', [id], 'SELECT id FROM products WHERE id = ?');
    if (!prod) return res.status(404).json({ error: 'Product not found' });
    await dbRun(req.db, 'UPDATE products SET active = 0 WHERE id = $1 RETURNING id', [id], 'UPDATE products SET active = 0 WHERE id = ?');
    const updated = await dbGet(req.db, 'SELECT id, name, category, selling_price, current_stock, minimum_stock, unit, active FROM products WHERE id = $1', [id], 'SELECT id, name, category, selling_price, current_stock, minimum_stock, unit, active FROM products WHERE id = ?');
    res.json({ data: { ...updated, status: computeStatus(updated) } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to remove product' });
  }
});

export default router;
