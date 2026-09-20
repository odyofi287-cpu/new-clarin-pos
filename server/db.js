import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from 'module';
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "data");
const dbFile = path.join(dataDir, "pos.db");

function parseBooleanEnv(value, defaultValue) {
  if (value == null || value === "") return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return defaultValue;
}

function shouldSeedInitialData() {
  // Optional hardening flag for public deployments.
  if (process.env.NODE_ENV === "test") return true;
  return parseBooleanEnv(process.env.SEED_INITIAL_DATA, true);
}

function ensureDataDirectory() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

// Very small in-memory DB used only for tests to avoid native dependency builds.
class InMemoryDB {
  constructor() {
    this.roles = [];
    this.users = [];
    this.vendors = [];
    this.products = [];
    this.deliveries = [];
    this.delivery_items = [];
    this.inventory_movements = [];
    this.sales = [];
    this.sale_items = [];
    this.vendor_returns = [];
  }

  transaction(fn) {
    return () => {
      const snapshot = JSON.stringify(this);
      try {
        return fn();
      } catch (error) {
        Object.assign(this, JSON.parse(snapshot));
        throw error;
      }
    };
  }

  prepare(sql) {
    const normalized = sql.replace(/\s+/g, " ").trim().toUpperCase();
    // Simple routing based on keywords used in our app's queries.
    if (normalized.includes("FROM ROLES")) {
      return {
        all: () => this.roles,
        get: (value) => {
          if (typeof value === "string") return this.roles.find((r) => r.name === value) || undefined;
          return this.roles.find((r) => r.id === value) || undefined;
        },
        run: (name) => {
          const id = this.roles.length + 1;
          this.roles.push({ id, name });
          return { lastInsertRowid: id };
        },
      };
    }

    if (normalized.includes("FROM VENDORS") && normalized.includes("MAX(ID)")) {
      return {
        get: () => ({ next_id: this.vendors.reduce((highest, vendor) => Math.max(highest, vendor.id), 0) + 1 }),
      };
    }

    if (normalized.includes("FROM VENDORS")) {
      return {
        all: () => this.vendors.map((v) => ({ ...v })),
        get: (idOrName) => {
          if (typeof idOrName === "number") return this.vendors.find((v) => v.id === idOrName);
          return this.vendors.find((v) => v.name === idOrName);
        },
        run: (name, contact) => {
          const id = this.vendors.length + 1;
          this.vendors.push({ id, name, contact, active: 1, created_at: new Date().toISOString() });
          return { lastInsertRowid: id };
        },
      };
    }

    if (normalized.startsWith("INSERT INTO VENDORS")) {
      return {
        run: (name, contact, vendorCode) => {
          const id = this.vendors.length + 1;
          this.vendors.push({ id, name, contact, vendor_code: vendorCode, active: 1, created_at: new Date().toISOString() });
          return { lastInsertRowid: id, changes: 1 };
        },
      };
    }

    // Specific: SELECT ... FROM products WHERE id = ?
    if (normalized.includes("FROM PRODUCTS") && normalized.includes("WHERE ID = ?")) {
      return {
        get: (id) => this.products.find((p) => p.id === id)
      };
    }

    if (normalized.startsWith("INSERT INTO USERS")) {
      return {
        run: (...args) => {
          const [username, email, password, name, role_id, vendor_id, contact_person, contact_number, profile_picture] = args.length === 9
            ? args
            : args.length === 8 ? [...args, null] : [null, ...args];
          const id = this.users.length + 1;
          this.users.push({
            id,
            username: username || String(email).split("@")[0],
            email,
            password,
            name,
            role_id,
            vendor_id: vendor_id ?? null,
            contact_person: contact_person ?? null,
            contact_number: contact_number ?? null,
            profile_picture: profile_picture ?? null,
            active: 1,
            created_at: new Date().toISOString()
          });
          return { lastInsertRowid: id, changes: 1 };
        }
      };
    }

    if (normalized.startsWith("UPDATE USERS")) {
      return {
        run: (...args) => {
          const id = Number(args.at(-1));
          const user = this.users.find((entry) => entry.id === id);
          if (!user) return { changes: 0 };

          if (normalized.includes("USERNAME = ?")) {
            [user.username, user.email, user.password, user.name, user.role_id, user.vendor_id, user.contact_person, user.contact_number] = args.slice(0, 8);
          } else {
            [user.name, user.role_id, user.vendor_id, user.contact_person, user.contact_number] = args;
          }
          return { changes: 1 };
        },
      };
    }

    if (normalized.startsWith("DELETE FROM USERS")) {
      return {
        run: (id) => {
          const idx = this.users.findIndex((u) => u.id === id);
          if (idx >= 0) this.users.splice(idx, 1);
          return { changes: idx >= 0 ? 1 : 0 };
        }
      };
    }

    if (normalized.includes("FROM USERS")) {
      return {
        all: () => this.users.map((u) => {
          const role = this.roles.find((r) => r.id === u.role_id);
          return { ...u, role: role ? role.name : undefined };
        }),
        get: (...args) => {
          const [arg, username, excludedId] = args;
          if (typeof arg === "string") {
            const u = normalized.includes("USERNAME = ?")
              ? this.users.find((entry) =>
                (entry.email === arg || entry.username === username) && entry.id !== Number(excludedId)
              )
              : this.users.find((entry) => entry.email === arg || entry.username === arg);
            if (!u) return undefined;
            const role = this.roles.find((r) => r.id === u.role_id);
            return { ...u, role: role ? role.name : undefined };
          }
          const u = this.users.find((u) => u.id === arg);
          if (!u) return undefined;
          const role = this.roles.find((r) => r.id === u.role_id);
          return { ...u, role: role ? role.name : undefined };
        },
        run: (email, password, name, role_id, vendor_id, contact_person, contact_number) => {
          const id = this.users.length + 1;
          this.users.push({ id, email, password, name, role_id, vendor_id, contact_person: contact_person ?? null, contact_number: contact_number ?? null, active: 1, created_at: new Date().toISOString() });
          const role = this.roles.find((r) => r.id === role_id);
          return { lastInsertRowid: id, lastRow: { id, email, role: role ? role.name : undefined } };
        },
      };
    }

    if (normalized.startsWith("UPDATE USERS")) {
      return {
        run: (name, role_id, vendor_id, contact_person, contact_number, id) => {
          const user = this.users.find((u) => u.id === id);
          if (!user) return { changes: 0 };
          user.name = name;
          user.role_id = role_id;
          user.vendor_id = vendor_id ?? null;
          user.contact_person = contact_person ?? null;
          user.contact_number = contact_number ?? null;
          return { changes: 1 };
        }
      };
    }

    if (normalized.startsWith("INSERT INTO PRODUCTS")) {
      return {
        run: (name, category, price, current_stock, minimum_stock, unit, image_url) => {
          const id = this.products.length + 1;
          this.products.push({ id, name, category, selling_price: price, current_stock, minimum_stock, unit, image_url: image_url || null, active: 1, created_at: new Date().toISOString() });
          return { lastInsertRowid: id };
        },
      };
    }

    if (normalized.includes("FROM PRODUCTS")) {
      return {
        all: () => this.products.map((p) => ({ ...p })),
        get: (name) => this.products.find((p) => p.name === name) || undefined,
        run: (name, category, price, current_stock, minimum_stock, unit) => {
          const id = this.products.length + 1;
          this.products.push({ id, name, category, selling_price: price, current_stock, minimum_stock, unit, active: 1, created_at: new Date().toISOString() });
          return { lastInsertRowid: id };
        },
      };
    }

    if (normalized.startsWith("UPDATE PRODUCTS")) {
      return {
        run: (...args) => {
          const id = Number(normalized.includes("CURRENT_STOCK = CURRENT_STOCK - ? WHERE ID = ? AND CURRENT_STOCK >= ?") ? args[1] : args[args.length - 1]);
          const prod = this.products.find((p) => p.id === id);
          if (!prod) return { changes: 0 };

          if (normalized.includes("CURRENT_STOCK = CURRENT_STOCK + ?")) {
            const delta = Number(args[0]);
            prod.current_stock += Number.isFinite(delta) ? delta : 0;
            return { changes: 1 };
          }

          if (normalized.includes("CURRENT_STOCK = CURRENT_STOCK - ?")) {
            const delta = Number(args[0]);
            if (prod.current_stock < delta) return { changes: 0 };
            prod.current_stock -= Number.isFinite(delta) ? delta : 0;
            return { changes: 1 };
          }

          if (normalized.includes("CURRENT_STOCK = ?")) {
            const value = Number(args[0]);
            if (Number.isFinite(value)) prod.current_stock = value;
            return { changes: 1 };
          }

          if (normalized.includes("IMAGE_URL = ?")) {
            prod.image_url = args[5] || null;
            return { changes: 1 };
          }

          return { changes: 0 };
        }
      };
    }

    if (normalized.startsWith("INSERT INTO DELIVERIES")) {
      return {
        run: (vendor_id, delivery_date, delivery_time, total_amount, created_by) => {
          const id = this.deliveries.length + 1;
          const row = { id, vendor_id, delivery_date, delivery_time, total_amount, created_by, created_at: new Date().toISOString() };
          this.deliveries.push(row);
          return { lastInsertRowid: id };
        }
      };
    }

    if (normalized.startsWith("DELETE FROM DELIVERIES")) {
      return {
        run: (id) => {
          const idx = this.deliveries.findIndex((row) => row.id === id);
          if (idx >= 0) this.deliveries.splice(idx, 1);
          return { changes: idx >= 0 ? 1 : 0 };
        }
      };
    }

    if (normalized.includes("WHERE ID = ?") && normalized.includes("FROM PRODUCTS")) {
      return {
        get: (id) => this.products.find((p) => p.id === id)
      };
    }

    if (normalized.includes("FROM DELIVERIES")) {
      return {
        all: (...params) => {
          let rows = this.deliveries.map((d) => ({
            ...d,
            vendor_code: this.vendors.find((vendor) => vendor.id === d.vendor_id)?.vendor_code || null,
            vendor_name: this.vendors.find((vendor) => vendor.id === d.vendor_id)?.name || "Unknown",
          }));
          if (normalized.includes("AS ITEMS")) {
            rows = rows.map((delivery) => ({
              ...delivery,
              items: this.delivery_items
                .filter((item) => item.delivery_id === delivery.id)
                .map((item) => `${this.products.find((product) => product.id === item.product_id)?.name || "Unknown"} (${item.quantity})`)
                .join(", "),
            }));
          }
          const vendorId = params[0];
          let paramIndex = 0;
          if (normalized.includes("D.VENDOR_ID = ?")) {
            rows = rows.filter((d) => d.vendor_id === vendorId);
            paramIndex = 1;
          }
          const startDate = normalized.includes("D.DELIVERY_DATE >= ?") ? params[paramIndex++] : undefined;
          const endDate = normalized.includes("D.DELIVERY_DATE <= ?") ? params[paramIndex++] : undefined;
          if (startDate) rows = rows.filter((d) => d.delivery_date >= startDate);
          if (endDate) rows = rows.filter((d) => d.delivery_date <= endDate);
          return rows;
        },
        get: (...params) => {
          const id = params[0];
          const delivery = this.deliveries.find((d) => d.id === id);
          if (!delivery) return undefined;
          if (params.length > 1 && typeof params[1] === 'number') {
            const vendorId = params[1];
            if (delivery.vendor_id !== vendorId) return undefined;
          }
          return {
            ...delivery,
            vendor_code: this.vendors.find((vendor) => vendor.id === delivery.vendor_id)?.vendor_code || null,
            vendor_name: this.vendors.find((vendor) => vendor.id === delivery.vendor_id)?.name || "Unknown",
          };
        },
        run: (vendor_id, delivery_date, total_amount, created_by) => {
          const id = this.deliveries.length + 1;
          const row = { id, vendor_id, delivery_date, total_amount, created_by, created_at: new Date().toISOString() };
          this.deliveries.push(row);
          return { lastInsertRowid: id };
        },
      };
    }

    if (normalized.startsWith("INSERT INTO DELIVERY_ITEMS")) {
      return {
        run: (delivery_id, product_id, quantity, unit_cost) => {
          const id = this.delivery_items.length + 1;
          const row = { id, delivery_id, product_id, quantity, unit_cost };
          this.delivery_items.push(row);
          return { lastInsertRowid: id };
        }
      };
    }

    if (normalized.startsWith("UPDATE DELIVERIES")) {
      return {
        run: (vendor_id, delivery_date, total_amount, id) => {
          const delivery = this.deliveries.find((row) => row.id === id);
          if (!delivery) return { changes: 0 };
          delivery.vendor_id = vendor_id;
          delivery.delivery_date = delivery_date;
          delivery.total_amount = total_amount;
          return { changes: 1 };
        }
      };
    }

    if (normalized.startsWith("DELETE FROM DELIVERY_ITEMS")) {
      return {
        run: (deliveryId) => {
          const before = this.delivery_items.length;
          this.delivery_items = this.delivery_items.filter((item) => item.delivery_id !== deliveryId);
          return { changes: before - this.delivery_items.length };
        }
      };
    }

    if (normalized.includes("FROM SALE_ITEMS") || normalized.startsWith("INSERT INTO SALE_ITEMS")) {
      return {
        all: (...params) => {
          const saleId = params[0];
          if (typeof saleId === 'number') {
            return this.sale_items.filter((it) => it.sale_id === saleId).map((it) => ({ ...it }));
          }
          return this.sale_items.map((it) => ({ ...it }));
        },
        run: (sale_id, product_id, quantity, unit_price) => {
          const id = this.sale_items.length + 1;
          const row = { id, sale_id, product_id, quantity, unit_price };
          this.sale_items.push(row);
          return { lastInsertRowid: id };
        },
      };
    }

    if (normalized.includes("FROM SALES") || normalized.startsWith("INSERT INTO SALES")) {
      if (normalized.startsWith("INSERT")) {
        return {
          run: (sale_date, total_amount, user_id, created_at) => {
            const id = this.sales.length + 1;
            const row = { id, sale_date, total_amount, user_id, created_at: created_at || new Date().toISOString() };
            this.sales.push(row);
            return { lastInsertRowid: id };
          },
        };
      }
      if (normalized.includes("COUNT(*)")) {
        return {
          get: (saleDate) => ({ count: this.sales.filter((sale) => sale.sale_date === saleDate).length }),
        };
      }
      if (normalized.includes("COALESCE(SUM(TOTAL_AMOUNT)")) {
        return {
          get: (saleDate) => ({ total: this.sales.filter((sale) => sale.sale_date === saleDate).reduce((sum, sale) => sum + sale.total_amount, 0) }),
        };
      }
      if (normalized.includes("SUM(SI.QUANTITY)")) {
        return {
          get: (saleDate) => ({
            count: this.sale_items
              .filter((item) => this.sales.some((sale) => sale.id === item.sale_id && sale.sale_date === saleDate))
              .reduce((sum, item) => sum + item.quantity, 0),
          }),
        };
      }
      if (normalized.includes("JOIN USERS") && normalized.includes("GROUP BY S.ID")) {
        const rows = this.sales
          .slice()
          .map((sale) => {
            const items = this.sale_items.filter((item) => item.sale_id === sale.id);
            const user = this.users.find((u) => u.id === sale.user_id);
            return {
              id: sale.id,
              sale_date: sale.sale_date,
              total_amount: sale.total_amount,
              sold_by: user?.name || "Unknown",
              item_count: items.reduce((sum, item) => sum + item.quantity, 0),
              created_at: sale.created_at,
            };
          })
          .sort((a, b) => b.created_at.localeCompare(a.created_at));
        if (normalized.includes("LIMIT 5")) {
          return { all: () => rows.slice(0, 5) };
        }
        return { all: () => rows };
      }
      if (normalized.includes("WHERE ID = ?")) {
        return {
          get: (id) => this.sales.find((s) => s.id === id),
        };
      }
      return {
        all: () => this.sales.map((sale) => ({ ...sale })),
      };
    }

    if (normalized.includes("FROM DELIVERY_ITEMS")) {
      return {
        all: (deliveryId) => this.delivery_items.filter((it) => it.delivery_id === deliveryId).map((it) => ({ ...it })),
        run: (delivery_id, product_id, quantity, unit_cost) => {
          const id = this.delivery_items.length + 1;
          const row = { id, delivery_id, product_id, quantity, unit_cost };
          this.delivery_items.push(row);
          return { lastInsertRowid: id };
        },
      };
    }

    if (normalized.startsWith("INSERT INTO DELIVERY_ITEMS")) {
      return {
        run: (delivery_id, product_id, quantity, unit_cost) => {
          const id = this.delivery_items.length + 1;
          const row = { id, delivery_id, product_id, quantity, unit_cost };
          this.delivery_items.push(row);
          return { lastInsertRowid: id };
        }
      };
    }

    if (normalized.includes("INVENTORY_MOVEMENTS")) {
      // INSERT INTO inventory_movements ...
      if (normalized.startsWith("INSERT")) {
        return {
          run: (...args) => {
            const usesLiteralMovement = normalized.includes("VALUES (?, 'STOCK_") || normalized.includes("VALUES (?, 'ADJUSTMENT'");
            const product_id = args[0];
            const movement_type = usesLiteralMovement
              ? (normalized.match(/VALUES \(\?, '(STOCK_IN|STOCK_OUT|ADJUSTMENT)'/) || [])[1]
              : args[1];
            const quantity = usesLiteralMovement ? args[1] : args[2];
            const reference_type = usesLiteralMovement
              ? (normalized.match(/, '([^']+)', \?, \?, DATETIME/) || [])[1]
              : args[3];
            const reference_id = usesLiteralMovement ? args[2] : args[4];
            const user_id = usesLiteralMovement ? args[3] : args[5];
            const created_at = usesLiteralMovement ? undefined : args[6];
            const id = this.inventory_movements.length + 1;
            const created = created_at || new Date().toISOString();
            const row = { id, product_id, movement_type, quantity, reference_type, reference_id, user_id, created_at: created };
            this.inventory_movements.push(row);
            return { lastInsertRowid: id };
          }
        };
      }
      // SELECT ... FROM inventory_movements WHERE product_id = ?
      return {
        all: (productId) => {
          if (productId) return this.inventory_movements.filter((m) => m.product_id === productId).map((m) => ({ ...m }));
          return this.inventory_movements.map((m) => ({ ...m }));
        },
        get: (id) => this.inventory_movements.find((m) => m.id === id)
      };
    }

    if (normalized.startsWith("INSERT INTO VENDOR_RETURNS")) {
      return {
        run: (vendor_id, product_id, quantity, total_product_price_returned, return_date, return_time, created_by) => {
          const id = this.vendor_returns.length + 1;
          const row = {
            id,
            vendor_id,
            product_id,
            quantity,
            total_product_price_returned,
            return_date,
            return_time,
            created_by,
            created_at: new Date().toISOString(),
          };
          this.vendor_returns.push(row);
          return { lastInsertRowid: id, changes: 1 };
        }
      };
    }

    if (normalized.startsWith("DELETE FROM VENDOR_RETURNS")) {
      return {
        run: (id) => {
          const before = this.vendor_returns.length;
          this.vendor_returns = this.vendor_returns.filter((row) => row.id !== id);
          return { changes: before - this.vendor_returns.length };
        }
      };
    }

    if (normalized.includes("FROM VENDOR_RETURNS")) {
      return {
        all: (...params) => {
          let rows = this.vendor_returns.map((row) => ({ ...row }));
          if (params.length && normalized.includes("VR.VENDOR_ID = ?")) {
            rows = rows.filter((row) => row.vendor_id === Number(params[0]));
          }
          rows.sort((a, b) => {
            const dateCompare = String(b.return_date).localeCompare(String(a.return_date));
            if (dateCompare !== 0) return dateCompare;
            return String(b.return_time).localeCompare(String(a.return_time));
          });
          return rows.map((row) => ({
            ...row,
            vendor_name: this.vendors.find((v) => v.id === row.vendor_id)?.name || "Unknown",
            product_name: this.products.find((p) => p.id === row.product_id)?.name || "Unknown",
          }));
        },
        get: (id) => {
          const row = this.vendor_returns.find((item) => item.id === id);
          if (!row) return undefined;
          return {
            ...row,
            vendor_name: this.vendors.find((v) => v.id === row.vendor_id)?.name || "Unknown",
            product_name: this.products.find((p) => p.id === row.product_id)?.name || "Unknown",
          };
        },
      };
    }

    // Fallback no-op
    return {
      all: () => [],
      get: () => undefined,
      run: () => ({}),
    };
  }
}

class PostgresDB {
  constructor(databaseUrl) {
    this.pool = new pg.Pool({
      connectionString: databaseUrl,
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
    });
    this.transactionContext = new AsyncLocalStorage();
    this.ready = this.initialize();
  }

  async initialize() {
    const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
    await this.pool.query(schema);
    await this.pool.query("ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS delivery_time TEXT");
    await this.pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_picture TEXT");
    if (shouldSeedInitialData()) {
      await this.seed();
    }
  }

  client() {
    return this.transactionContext.getStore() || this.pool;
  }

  prepare(sql) {
    const query = sql
      .replace(/datetime\('now'\)/gi, "CURRENT_TIMESTAMP")
      .replace(/\?\s*$/g, "?");
    let index = 0;
    let text = query.replace(/\?/g, () => `$${++index}`);
    if (/^INSERT\s+INTO/i.test(text) && !/\bRETURNING\b/i.test(text)) text += " RETURNING id";
    const db = this;
    return {
      async all(...params) {
        const result = await db.client().query(text, params);
        return result.rows;
      },
      async get(...params) {
        const result = await db.client().query(text, params);
        return result.rows[0];
      },
      async run(...params) {
        const result = await db.client().query(text, params);
        const firstRow = result.rows[0];
        return {
          changes: result.rowCount,
          lastInsertRowid: firstRow?.id,
          ...firstRow,
        };
      },
      client: () => db.client(),
    };
  }

  async transaction(fn) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await this.transactionContext.run(client, fn);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async ensureSeedVendor(name, contact, vendorCode) {
    const inserted = await this.pool.query(
      "INSERT INTO vendors (name, contact, vendor_code, active) VALUES ($1, $2, $3, 1) ON CONFLICT (vendor_code) DO NOTHING RETURNING id",
      [name, contact, vendorCode]
    );
    if (inserted.rows[0]) return inserted.rows[0].id;

    const existing = await this.pool.query("SELECT id FROM vendors WHERE vendor_code = $1", [vendorCode]);
    if (!existing.rows[0]) throw new Error(`Unable to find seeded vendor ${vendorCode}`);
    return existing.rows[0].id;
  }

  async seed() {
    const require = createRequire(import.meta.url);
    const bcrypt = require("bcrypt");
    const roleNames = ["SUPERADMIN", "ADMIN", "STAFF", "VENDOR"];
    for (const role of roleNames) {
      await this.pool.query("INSERT INTO roles (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [role]);
    }
    const vendorId1 = await this.ensureSeedVendor("Clarin Beverages", "0917-555-0101", "VND-0001");
    const vendorId2 = await this.ensureSeedVendor("Arena Drinks Supplier", "0917-555-0202", "VND-0002");
    const products = [["Cola", "Soft Drink", 35, 50, 10, "bottle"], ["Mineral Water", "Water", 25, 70, 20, "bottle"]];
    for (const product of products) {
      await this.pool.query(
        `INSERT INTO products (name, category, selling_price, current_stock, minimum_stock, unit, active)
         SELECT $1, $2, $3, $4, $5, $6, 1
         WHERE NOT EXISTS (SELECT 1 FROM products WHERE name = $1)`,
        product
      );
    }
    const users = [["superadmin", "superadmin@clarin.local", bcrypt.hashSync("Superadmin123!", 10), "System Owner", "SUPERADMIN", null], ["admin", "admin@clarin.local", bcrypt.hashSync("Admin123!", 10), "Arena Owner", "ADMIN", null], ["staff", "staff@clarin.local", bcrypt.hashSync("Staff123!", 10), "POS Staff", "STAFF", null], ["vendor", "vendor@clarin.local", bcrypt.hashSync("Vendor123!", 10), "Vendor User", "VENDOR", vendorId1], ["vendor2", "vendor2@clarin.local", bcrypt.hashSync("Vendor123!", 10), "Vendor Two", "VENDOR", vendorId2]];
    for (const [username, email, password, name, role, vendorId] of users) {
      await this.pool.query("INSERT INTO users (username, email, password, name, role_id, vendor_id, active) SELECT $1, $2, $3, $4, id, $6, 1 FROM roles WHERE name = $5 ON CONFLICT (email) DO NOTHING", [username, email, password, name, role, vendorId]);
    }
  }
}

function migrateSchema(db) {
  if (process.env.NODE_ENV === "test") return;

  const require = createRequire(import.meta.url);
  let bcrypt = null;
  try {
    bcrypt = require("bcrypt");
  } catch (error) {
    throw new Error("bcrypt is required to initialize the production database");
  }

  const plaintextUsers = db.prepare("SELECT id, password FROM users WHERE password NOT LIKE '$2%'").all();
  const updatePassword = db.prepare("UPDATE users SET password = ? WHERE id = ?");
  plaintextUsers.forEach((user) => updatePassword.run(bcrypt.hashSync(user.password, 10), user.id));

  const userColumns = db.prepare("PRAGMA table_info(users)").all();
  const userColumnNames = new Set(userColumns.map((column) => column.name));

  if (!userColumnNames.has("contact_person")) {
    db.exec("ALTER TABLE users ADD COLUMN contact_person TEXT");
  }

  if (!userColumnNames.has("contact_number")) {
    db.exec("ALTER TABLE users ADD COLUMN contact_number TEXT");
  }

  if (!userColumnNames.has("profile_picture")) {
    db.exec("ALTER TABLE users ADD COLUMN profile_picture TEXT");
  }

  if (!userColumnNames.has("username")) {
    db.exec("ALTER TABLE users ADD COLUMN username TEXT");
    db.exec("UPDATE users SET username = lower(substr(email, 1, instr(email, '@') - 1)) WHERE username IS NULL OR username = ''");
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)");

  const vendorColumns = db.prepare("PRAGMA table_info(vendors)").all();
  const vendorColumnNames = new Set(vendorColumns.map((column) => column.name));
  if (!vendorColumnNames.has("vendor_code")) {
    db.exec("ALTER TABLE vendors ADD COLUMN vendor_code TEXT");
  }
  db.exec("UPDATE vendors SET vendor_code = 'VND-' || printf('%04d', id) WHERE vendor_code IS NULL OR vendor_code = ''");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_vendors_vendor_code ON vendors(vendor_code)");

  const productColumns = db.prepare("PRAGMA table_info(products)").all();
  const productColumnNames = new Set(productColumns.map((column) => column.name));
  if (!productColumnNames.has("image_url")) {
    db.exec("ALTER TABLE products ADD COLUMN image_url TEXT");
  }

  const deliveryColumns = db.prepare("PRAGMA table_info(deliveries)").all();
  if (!deliveryColumns.some((column) => column.name === "delivery_time")) {
    db.exec("ALTER TABLE deliveries ADD COLUMN delivery_time TEXT");
  }
}

function createSchema(db) {
  // No-op for in-memory DB; for file DB, ensure tables exist via SQL
  if (process.env.NODE_ENV === "test") return;
  db.exec(`PRAGMA foreign_keys = ON;`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS vendors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      contact TEXT,
      vendor_code TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      name TEXT NOT NULL,
      role_id INTEGER NOT NULL,
      vendor_id INTEGER,
      contact_person TEXT,
      contact_number TEXT,
      profile_picture TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (role_id) REFERENCES roles(id),
      FOREIGN KEY (vendor_id) REFERENCES vendors(id)
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT,
      selling_price REAL NOT NULL,
      current_stock INTEGER NOT NULL DEFAULT 0,
      minimum_stock INTEGER NOT NULL DEFAULT 0,
      unit TEXT NOT NULL DEFAULT 'unit',
      image_url TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_id INTEGER NOT NULL,
      delivery_date TEXT NOT NULL,
      delivery_time TEXT,
      total_amount REAL NOT NULL,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (vendor_id) REFERENCES vendors(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS delivery_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      delivery_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      unit_cost REAL NOT NULL,
      FOREIGN KEY (delivery_id) REFERENCES deliveries(id),
      FOREIGN KEY (product_id) REFERENCES products(id)
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS inventory_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      movement_type TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      reference_id INTEGER,
      reference_type TEXT,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_date TEXT NOT NULL,
      total_amount REAL NOT NULL,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sale_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price REAL NOT NULL,
      FOREIGN KEY (sale_id) REFERENCES sales(id),
      FOREIGN KEY (product_id) REFERENCES products(id)
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS vendor_returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      total_product_price_returned REAL NOT NULL DEFAULT 0,
      return_date TEXT NOT NULL,
      return_time TEXT NOT NULL,
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (vendor_id) REFERENCES vendors(id),
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    );
  `);
}

function seedInitialData(db) {
  if (process.env.NODE_ENV === "test") {
    // Seed in-memory structures
    if (db.roles.length === 0) {
      db.roles.push({ id: 1, name: "SUPERADMIN" });
      db.roles.push({ id: 2, name: "ADMIN" });
      db.roles.push({ id: 3, name: "STAFF" });
      db.roles.push({ id: 4, name: "VENDOR" });
    }

    if (db.vendors.length === 0) {
      db.vendors.push({ id: 1, name: "Clarin Beverages", contact: "0917-555-0101", vendor_code: "VND-0001", active: 1, created_at: new Date().toISOString() });
      db.vendors.push({ id: 2, name: "Arena Drinks Supplier", contact: "0917-555-0202", vendor_code: "VND-0002", active: 1, created_at: new Date().toISOString() });
    }

    if (db.products.length === 0) {
      db.products.push({ id: 1, name: "Cola", category: "Soft Drink", selling_price: 35.0, current_stock: 50, minimum_stock: 10, unit: "bottle", active: 1, created_at: new Date().toISOString() });
      db.products.push({ id: 2, name: "Mineral Water", category: "Water", selling_price: 25.0, current_stock: 70, minimum_stock: 20, unit: "bottle", active: 1, created_at: new Date().toISOString() });
    }

    if (db.users.length === 0) {
      // Store plain passwords only in test mode to avoid bcrypt native dependency
      db.users.push({ id: 1, username: "superadmin", email: "superadmin@clarin.local", password: "Superadmin123!", name: "System Owner", role_id: 1, vendor_id: null, active: 1, created_at: new Date().toISOString() });
      db.users.push({ id: 2, username: "admin", email: "admin@clarin.local", password: "Admin123!", name: "Arena Owner", role_id: 2, vendor_id: null, active: 1, created_at: new Date().toISOString() });
      db.users.push({ id: 3, username: "staff", email: "staff@clarin.local", password: "Staff123!", name: "POS Staff", role_id: 3, vendor_id: null, active: 1, created_at: new Date().toISOString() });
      db.users.push({ id: 4, username: "vendor", email: "vendor@clarin.local", password: "Vendor123!", name: "Vendor User", role_id: 4, vendor_id: 1, active: 1, created_at: new Date().toISOString() });
      db.users.push({ id: 5, username: "vendor2", email: "vendor2@clarin.local", password: "Vendor123!", name: "Vendor Two", role_id: 4, vendor_id: 2, active: 1, created_at: new Date().toISOString() });
    }

    if (db.deliveries.length === 0) {
      db.deliveries.push({ id: 1, vendor_id: 1, delivery_date: new Date().toISOString().split("T")[0], total_amount: 150.0, created_by: 1, created_at: new Date().toISOString() });
      db.deliveries.push({ id: 2, vendor_id: 2, delivery_date: new Date().toISOString().split("T")[0], total_amount: 100.0, created_by: 1, created_at: new Date().toISOString() });
      db.delivery_items.push({ id: 1, delivery_id: 1, product_id: 1, quantity: 20, unit_cost: 25.0 });
      db.delivery_items.push({ id: 2, delivery_id: 1, product_id: 2, quantity: 10, unit_cost: 20.0 });
      db.delivery_items.push({ id: 3, delivery_id: 2, product_id: 2, quantity: 15, unit_cost: 22.0 });
    }

    if (db.sales.length === 0) {
      const today = new Date().toISOString().split("T")[0];
      db.sales.push({ id: 1, sale_date: today, total_amount: 210.0, user_id: 2, created_at: new Date().toISOString() });
      db.sales.push({ id: 2, sale_date: today, total_amount: 120.0, user_id: 2, created_at: new Date().toISOString() });
      db.sale_items.push({ id: 1, sale_id: 1, product_id: 1, quantity: 3, unit_price: 35.0 });
      db.sale_items.push({ id: 2, sale_id: 1, product_id: 2, quantity: 2, unit_price: 25.0 });
      db.sale_items.push({ id: 3, sale_id: 2, product_id: 2, quantity: 4, unit_price: 25.0 });
    }

    return;
  }

  const ensureRole = (name) => {
    const existing = db.prepare("SELECT id FROM roles WHERE name = ?").get(name);
    if (existing) return existing.id;
    return db.prepare("INSERT INTO roles (name) VALUES (?)").run(name).lastInsertRowid;
  };

  const requiredRoles = ["SUPERADMIN", "ADMIN", "STAFF", "VENDOR"];
  requiredRoles.forEach((roleName) => ensureRole(roleName));

  const existingVendors = db.prepare("SELECT COUNT(*) AS count FROM vendors").get().count;
  let vendorId1 = null;
  let vendorId2 = null;
  if (existingVendors === 0) {
    const insertVendor = db.prepare("INSERT INTO vendors (name, contact, vendor_code, active) VALUES (?, ?, ?, 1)");
    vendorId1 = insertVendor.run("Clarin Beverages", "0917-555-0101", "VND-0001").lastInsertRowid;
    vendorId2 = insertVendor.run("Arena Drinks Supplier", "0917-555-0202", "VND-0002").lastInsertRowid;
  } else {
    const firstVendor = db.prepare("SELECT id FROM vendors ORDER BY id LIMIT 1").get();
    const secondVendor = db.prepare("SELECT id FROM vendors ORDER BY id DESC LIMIT 1").get();
    vendorId1 = firstVendor?.id;
    vendorId2 = secondVendor?.id;
  }

  const existingProducts = db.prepare("SELECT COUNT(*) AS count FROM products").get().count;
  if (existingProducts === 0) {
    const insertProduct = db.prepare(
      "INSERT INTO products (name, category, selling_price, current_stock, minimum_stock, unit, active) VALUES (?, ?, ?, ?, ?, ?, 1)"
    );
    insertProduct.run("Cola", "Soft Drink", 35.0, 50, 10, "bottle");
    insertProduct.run("Mineral Water", "Water", 25.0, 70, 20, "bottle");
  }

  const roleIds = Object.fromEntries(
    db.prepare("SELECT id, name FROM roles").all().map((row) => [row.name, row.id])
  );

  const ensureUser = ({ email, password, name, roleName, vendorId }) => {
    const roleId = roleIds[roleName];
    const existingUser = db.prepare("SELECT id, role_id, vendor_id, password, name, active FROM users WHERE email = ?").get(email);

    if (existingUser) {
      // Do not override existing accounts at startup.
      // This preserves rotated passwords and role adjustments in deployed environments.
      return;
    }

    const insertUser = db.prepare(
      "INSERT INTO users (username, email, password, name, role_id, vendor_id, active) VALUES (?, ?, ?, ?, ?, ?, 1)"
    );
    insertUser.run(email.split("@")[0].toLowerCase(), email, password, name, roleId, vendorId ?? null);
  };

  let bcrypt = null;
  try {
    const require = createRequire(import.meta.url);
    bcrypt = require("bcrypt");
  } catch (err) {
    bcrypt = null;
  }

  const requiredUsers = [
    {
      email: "superadmin@clarin.local",
      password: bcrypt ? bcrypt.hashSync("Superadmin123!", 10) : "Superadmin123!",
      name: "System Owner",
      roleName: "SUPERADMIN",
      vendorId: null,
    },
    {
      email: "admin@clarin.local",
      password: bcrypt ? bcrypt.hashSync("Admin123!", 10) : "Admin123!",
      name: "Arena Owner",
      roleName: "ADMIN",
      vendorId: null,
    },
    {
      email: "staff@clarin.local",
      password: bcrypt ? bcrypt.hashSync("Staff123!", 10) : "Staff123!",
      name: "POS Staff",
      roleName: "STAFF",
      vendorId: null,
    },
    {
      email: "vendor@clarin.local",
      password: bcrypt ? bcrypt.hashSync("Vendor123!", 10) : "Vendor123!",
      name: "Vendor User",
      roleName: "VENDOR",
      vendorId: vendorId1,
    },
    {
      email: "vendor2@clarin.local",
      password: bcrypt ? bcrypt.hashSync("Vendor123!", 10) : "Vendor123!",
      name: "Vendor Two",
      roleName: "VENDOR",
      vendorId: vendorId2,
    },
  ];

  requiredUsers.forEach(ensureUser);

  const existingDeliveries = db.prepare("SELECT COUNT(*) AS count FROM deliveries").get().count;
  if (existingDeliveries === 0) {
    const adminUser = db.prepare("SELECT id FROM users WHERE email = ?").get("admin@clarin.local");
    const insertDelivery = db.prepare(
      "INSERT INTO deliveries (vendor_id, delivery_date, total_amount, created_by) VALUES (?, ?, ?, ?)"
    );
    const insertDeliveryItem = db.prepare(
      "INSERT INTO delivery_items (delivery_id, product_id, quantity, unit_cost) VALUES (?, ?, ?, ?)"
    );
    const cola = db.prepare("SELECT id FROM products WHERE name = ?").get("Cola");
    const water = db.prepare("SELECT id FROM products WHERE name = ?").get("Mineral Water");

    if (vendorId1 !== null && adminUser) {
      const delivery1 = insertDelivery.run(vendorId1, new Date().toISOString().split("T")[0], 150.0, adminUser.id);
      insertDeliveryItem.run(delivery1.lastInsertRowid, cola.id, 20, 25.0);
      insertDeliveryItem.run(delivery1.lastInsertRowid, water.id, 10, 20.0);
    }

    if (vendorId2 !== null && adminUser) {
      const delivery2 = insertDelivery.run(vendorId2, new Date().toISOString().split("T")[0], 100.0, adminUser.id);
      insertDeliveryItem.run(delivery2.lastInsertRowid, water.id, 15, 22.0);
    }
  }

  const existingSales = db.prepare("SELECT COUNT(*) AS count FROM sales").get().count;
  if (existingSales === 0) {
    const insertSale = db.prepare("INSERT INTO sales (sale_date, total_amount, user_id) VALUES (?, ?, ?)");
    const insertSaleItem = db.prepare("INSERT INTO sale_items (sale_id, product_id, quantity, unit_price) VALUES (?, ?, ?, ?)");
    const staffUser = db.prepare("SELECT id FROM users WHERE email = ?").get("staff@clarin.local");
    const today = new Date().toISOString().split("T")[0];
    if (staffUser) {
      const sale1 = insertSale.run(today, 210.0, staffUser.id);
      insertSaleItem.run(sale1.lastInsertRowid, 1, 3, 35.0);
      insertSaleItem.run(sale1.lastInsertRowid, 2, 2, 25.0);
      const sale2 = insertSale.run(today, 120.0, staffUser.id);
      insertSaleItem.run(sale2.lastInsertRowid, 2, 4, 25.0);
    }
  }
}

export function initDb() {
  if (process.env.NODE_ENV === "test") {
    const mem = new InMemoryDB();
    if (shouldSeedInitialData()) {
      seedInitialData(mem);
    }
    return mem;
  }
  if (process.env.POSTGRES_ENABLED === "true" && !process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required when POSTGRES_ENABLED=true");
  }
  if (process.env.DATABASE_URL && process.env.POSTGRES_ENABLED === "true") {
    return new PostgresDB(process.env.DATABASE_URL);
  }
  ensureDataDirectory();
  let Database = null;
  try {
    const require = createRequire(import.meta.url);
    Database = require('better-sqlite3');
  } catch (err) {
    throw new Error('better-sqlite3 is required in non-test environments');
  }
  const db = new Database(dbFile);
  createSchema(db);
  migrateSchema(db);
  if (shouldSeedInitialData()) {
    // seedInitialData may perform async bcrypt import; call and ignore promise
    seedInitialData(db);
  }
  return db;
}
