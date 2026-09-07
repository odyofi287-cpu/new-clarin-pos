import express from "express";
import { requireRole } from "../middleware/auth.js";
import { publishDataChange } from "../events.js";

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

router.get("/", requireRole("SUPERADMIN", "ADMIN", "STAFF", "VENDOR"), (req, res) => {
  try {
    const q = (req.query.q || "").toLowerCase();
    const activeParam = (req.query.active || '').toString().toLowerCase();
    const includeInactive = activeParam === '0' || activeParam === 'false' || activeParam === 'all';
    const products = req.db.prepare(
      `SELECT id, name, category, selling_price, current_stock, minimum_stock, unit, image_url, active FROM products${includeInactive ? '' : ' WHERE active = 1'}`
    ).all();
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
router.post("/", requireRole("SUPERADMIN", "ADMIN", "STAFF"), (req, res) => {
  try {
    const { name, category, selling_price, unit = 'unit', minimum_stock = 0, initial_stock = 0, image_url = null } = req.body;
    const normalizedImageUrl = normalizeImageUrl(image_url);
    if (!name || selling_price == null) return res.status(400).json({ error: 'name and selling_price required' });
    const result = req.db.prepare("INSERT INTO products (name, category, selling_price, current_stock, minimum_stock, unit, image_url, active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)").run(name, category || null, selling_price, initial_stock, minimum_stock, unit, normalizedImageUrl);
    const prodId = result.lastInsertRowid;
    // If initial_stock > 0 create inventory movement
    if (initial_stock > 0) {
      req.db.prepare("INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_type, reference_id, user_id, created_at) VALUES (?, 'STOCK_IN', ?, ?, ?, ?, datetime('now'))").run(prodId, initial_stock, 'initial_stock', null, req.user.user_id || null);
    }
    const prod = req.db.prepare("SELECT id, name, category, selling_price, current_stock, minimum_stock, unit, image_url, active FROM products WHERE id = ?").get(prodId);
    publishDataChange("product");
    res.status(201).json({ data: { ...prod, status: computeStatus(prod) } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

// Edit beverage metadata
router.put('/:id', requireRole('SUPERADMIN','ADMIN','STAFF'), (req,res) => {
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
    const prod = req.db.prepare('SELECT id, current_stock FROM products WHERE id = ?').get(id);
    if (!prod) return res.status(404).json({ error: 'Product not found' });
    const runTx = (fn) => {
      if (req.db && typeof req.db.transaction === 'function') {
        const transaction = req.db.transaction(fn);
        return typeof transaction === 'function' ? transaction() : fn();
      }
      return fn();
    };
    runTx(() => {
      req.db.prepare('UPDATE products SET name = ?, category = ?, selling_price = ?, unit = ?, minimum_stock = ?, image_url = ? WHERE id = ?').run(name, category, selling_price, unit, minimum_stock, normalizedImageUrl, id);
      if (stockValue !== null) {
        req.db.prepare('UPDATE products SET current_stock = ? WHERE id = ?').run(stockValue, id);
        const delta = stockValue - Number(prod.current_stock || 0);
        if (delta !== 0) {
          req.db.prepare("INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_type, reference_id, user_id, created_at) VALUES (?, ?, ?, 'manual_adjustment', ?, ?, datetime('now'))").run(id, delta > 0 ? 'STOCK_IN' : 'STOCK_OUT', Math.abs(delta), id, req.user.user_id || null);
        }
      }
    });
    const updated = req.db.prepare('SELECT id, name, category, selling_price, current_stock, minimum_stock, unit, image_url, active FROM products WHERE id = ?').get(id);
    publishDataChange("product");
    res.json({ data: { ...updated, status: computeStatus(updated) } });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to update product' }); }
});

// Activate / deactivate
router.patch('/:id/activate', requireRole('SUPERADMIN','ADMIN','STAFF'), (req,res)=>{
  try {
    const id = Number(req.params.id);
    const { active } = req.body;
    req.db.prepare('UPDATE products SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
    const updated = req.db.prepare('SELECT id, name, category, selling_price, current_stock, minimum_stock, unit, active FROM products WHERE id = ?').get(id);
    publishDataChange("product");
    res.json({ data: { ...updated, status: computeStatus(updated) } });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to set active flag' }); }
});

// Get product details
router.get('/:id', requireRole('SUPERADMIN','ADMIN','STAFF','VENDOR'), (req,res)=>{
  try {
    const id = Number(req.params.id);
    const prod = req.db.prepare('SELECT id, name, category, selling_price, current_stock, minimum_stock, unit, image_url, active FROM products WHERE id = ?').get(id);
    if (!prod) return res.status(404).json({ error: 'Not found' });
    res.json({ data: { ...prod, status: computeStatus(prod) } });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load product' }); }
});

// Create stock movement (STOCK_IN, STOCK_OUT, ADJUSTMENT)
// Vendor portal is read-only and cannot modify inventory.
router.post('/:id/stock-movements', requireRole('SUPERADMIN','ADMIN','STAFF'), (req,res) => {
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
    const runTx = (fn) => {
      if (req.db && typeof req.db.transaction === 'function') {
        const t = req.db.transaction(fn);
        return typeof t === 'function' ? t() : fn();
      }
      return fn();
    };

    const result = runTx(() => {
      const prod = req.db.prepare('SELECT id, current_stock FROM products WHERE id = ?').get(id);
      if (!prod) throw new Error('Product not found');
      const current = Number(prod.current_stock || 0);
      const newStock = current + change;
      if (newStock < 0) throw new Error('Insufficient stock');
      req.db.prepare('UPDATE products SET current_stock = ? WHERE id = ?').run(newStock, id);
      // insert movement
      req.db.prepare("INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_type, reference_id, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))").run(id, type, qty, reference_type, reference_id, req.user.user_id || null);
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
router.get('/:id/movements', requireRole('SUPERADMIN','ADMIN','STAFF','VENDOR'), (req,res)=>{
  try {
    const id = Number(req.params.id);
    const limit = Number(req.query.limit || 50);
    const offset = Number(req.query.offset || 0);
    let rows = req.db.prepare('SELECT id, product_id, movement_type, quantity, reference_type, reference_id, user_id, created_at FROM inventory_movements WHERE product_id = ? ORDER BY created_at DESC').all(id) || [];
    rows = rows.slice(offset, offset + limit);
    res.json({ data: rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load movements' }); }
});

// Soft-delete product (mark inactive)
router.delete('/:id', requireRole('SUPERADMIN','ADMIN','STAFF'), (req, res) => {
  try {
    const id = Number(req.params.id);
    const prod = req.db.prepare('SELECT id FROM products WHERE id = ?').get(id);
    if (!prod) return res.status(404).json({ error: 'Product not found' });
    // mark as inactive
    req.db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(id);
    const updated = req.db.prepare('SELECT id, name, category, selling_price, current_stock, minimum_stock, unit, active FROM products WHERE id = ?').get(id);
    res.json({ data: { ...updated, status: computeStatus(updated) } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to remove product' });
  }
});

export default router;
