import { useEffect, useState } from "react";
import { apiUrl } from "./api";

function formatCurrency(value) {
  return value == null ? "0.00" : Number(value).toLocaleString("en-PH", { style: "currency", currency: "PHP", minimumFractionDigits: 2 });
}

function formatRecordDate(value) {
  const text = String(value || "").slice(0, 10);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return value || "-";
  const [, year, month, day] = match;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))));
}

function formatRecordTime(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})/);
  if (!match) return "-";
  const date = new Date(2000, 0, 1, Number(match[1]), Number(match[2]));
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(date);
}

function readProductImage(file, onReady, onError) {
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    onError("Please choose an image file.");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const image = new Image();
    image.onload = () => {
      const maxSize = 640;
      const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
      onReady(canvas.toDataURL("image/jpeg", 0.82));
    };
    image.onerror = () => onError("Unable to read that image.");
    image.src = reader.result;
  };
  reader.onerror = () => onError("Unable to read that image.");
  reader.readAsDataURL(file);
}

function SalesTrendChart({ sales }) {
  const points = [...(sales || [])].reverse().slice(-8);
  const values = points.map((sale) => Number(sale.total_amount) || 0);
  const maxValue = Math.max(...values, 1);
  const chartPoints = values.map((value, index) => {
    const x = values.length === 1 ? 50 : (index / (values.length - 1)) * 100;
    const y = 92 - (value / maxValue) * 70;
    return `${x},${y}`;
  }).join(" ");
  const areaPoints = values.length > 0 ? `0,92 ${chartPoints} 100,92` : "0,92 100,92";

  return (
    <div className="chart-card sales-chart-card">
      <div className="chart-card-header">
        <div>
          <span className="chart-kicker">Performance</span>
          <h3>Sales Overview</h3>
        </div>
        <span className="chart-period">Recent</span>
      </div>
      {values.length === 0 ? <p className="chart-empty">No sales data available.</p> : (
        <>
          <div className="chart-highlight">{formatCurrency(dataValue(values[values.length - 1]))}<span>latest sale</span></div>
          <svg className="sales-chart" viewBox="0 0 100 100" role="img" aria-label="Recent sales trend">
            <defs>
              <linearGradient id="sales-fill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="#2f7aed" stopOpacity="0.24" />
                <stop offset="1" stopColor="#2f7aed" stopOpacity="0.02" />
              </linearGradient>
            </defs>
            <path className="chart-grid-line" d="M0 22H100M0 57H100M0 92H100" />
            <polygon points={areaPoints} fill="url(#sales-fill)" />
            <polyline points={chartPoints} fill="none" stroke="#236de0" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            {values.map((value, index) => {
              const x = values.length === 1 ? 50 : (index / (values.length - 1)) * 100;
              const y = 92 - (value / maxValue) * 70;
              return <circle key={`${value}-${index}`} cx={x} cy={y} r="2.3" fill="#ffffff" stroke="#236de0" strokeWidth="1.7" />;
            })}
          </svg>
          <div className="chart-axis-labels">
            {points.map((sale) => <span key={sale.id}>{String(sale.sale_date || "").slice(5)}</span>)}
          </div>
        </>
      )}
    </div>
  );
}

function dataValue(value) {
  return Number(value) || 0;
}

function InventoryStatusChart({ products }) {
  const activeProducts = (products || []).filter((product) => product.active === 1 || product.active === true);
  const total = activeProducts.length;
  const outOfStock = activeProducts.filter((product) => Number(product.current_stock) <= 0).length;
  const lowStock = activeProducts.filter((product) => Number(product.current_stock) > 0 && Number(product.current_stock) <= 10).length;
  const inStock = Math.max(total - lowStock - outOfStock, 0);
  const statusTotal = Math.max(inStock + lowStock + outOfStock, 1);
  const inStockPercent = (inStock / statusTotal) * 100;
  const lowStockPercent = (lowStock / statusTotal) * 100;

  return (
    <div className="chart-card inventory-chart-card">
      <div className="chart-card-header">
        <div>
          <span className="chart-kicker">Stock health</span>
          <h3>Inventory Status</h3>
        </div>
        <span className="chart-period">Live</span>
      </div>
      <div className="inventory-chart-body">
        <div className="inventory-donut" style={{ "--in-stock": `${inStockPercent}%`, "--low-stock": `${inStockPercent + lowStockPercent}%` }}>
          <div><strong>{total}</strong><span>Products</span></div>
        </div>
        <div className="inventory-legend">
          <div><span className="legend-dot legend-green" /><span>In Stock</span><strong>{inStock}</strong></div>
          <div><span className="legend-dot legend-orange" /><span>Low Stock</span><strong>{lowStock}</strong></div>
          <div><span className="legend-dot legend-red" /><span>Out of Stock</span><strong>{outOfStock}</strong></div>
        </div>
      </div>
    </div>
  );
}

function SalesCalendar({ calendar }) {
  const [mode, setMode] = useState("daily");
  const rows = calendar?.[mode] || [];
  const totalNet = rows.reduce((sum, row) => sum + Number(row.net_sales || 0), 0);
  const peak = Math.max(...rows.map((row) => Number(row.net_sales || 0)), 1);
  const label = (period) => mode === "daily" ? formatRecordDate(period) : new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${period}-01T00:00:00Z`));

  return (
    <section className="sales-calendar-card">
      <div className="sales-calendar-heading">
        <div><span className="chart-kicker">Sales recorder</span><h3>Sales Calendar</h3><p>Compare recorded and net sales by period.</p></div>
        <div className="sales-calendar-tabs">
          <button type="button" className={mode === "daily" ? "active" : ""} onClick={() => setMode("daily")}>Daily</button>
          <button type="button" className={mode === "monthly" ? "active" : ""} onClick={() => setMode("monthly")}>Monthly</button>
        </div>
      </div>
      <div className="sales-calendar-total"><span>{mode === "daily" ? "Last 31 days" : "Last 12 months"}</span><strong>{formatCurrency(totalNet)}</strong><small>Net sales</small></div>
      <div className={`sales-calendar-grid ${mode}`}>
        {rows.map((row) => <article key={row.period} className="sales-calendar-cell" title={`${label(row.period)}: ${formatCurrency(row.net_sales)} net sales`}>
          <span>{label(row.period)}</span>
          <strong>{formatCurrency(row.net_sales)}</strong>
          <i style={{ height: `${Math.max(4, (Number(row.net_sales || 0) / peak) * 100)}%` }} />
        </article>)}
      </div>
      <div className="sales-calendar-legend"><span><i className="recorded" />Recorded sales</span><span><i className="net" />Net sales</span><span><i className="returns" />Returns deducted</span></div>
    </section>
  );
}

function Dashboard({ token, role, viewMode = "dashboard" }) {
  const REFRESH_INTERVAL_MS = 6000;
  const [data, setData] = useState(null);
  const [calculatedSales, setCalculatedSales] = useState(null);
  const [error, setError] = useState(null);
  const [productsList, setProductsList] = useState([]);
  const [manageForm, setManageForm] = useState({ id: null, name: "", category: "", selling_price: "", current_stock: "", image_url: "" });
  const [usersList, setUsersList] = useState([]);
  const [manageError, setManageError] = useState(null);
  const [manageSuccess, setManageSuccess] = useState(null);
  const [showCreateProductWindow, setShowCreateProductWindow] = useState(false);
  const [showEditProductWindow, setShowEditProductWindow] = useState(false);
  const [showCreateAccountWindow, setShowCreateAccountWindow] = useState(false);
  const [createProductForm, setCreateProductForm] = useState({ name: "", category: "", selling_price: "", current_stock: "", image_url: "" });
  const [createAccountForm, setCreateAccountForm] = useState({ name: "", role: "ADMIN", vendor_id: "", contact_person: "", contact_number: "" });

  useEffect(() => {
    if (!token) {
      setError("Authentication required");
      return;
    }

    const loadProducts = () => {
      fetch(apiUrl('/api/products?active=all'), { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => r.json())
        .then((p) => {
          if (!p.error) {
            setProductsList(p.data || []);
          }
        })
        .catch(() => {});
    };

    const loadDashboard = () => {
      fetch(apiUrl("/api/dashboard"), {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then((res) => res.json())
        .then((payload) => {
          if (payload.error) {
            setError(payload.error);
          } else {
            setData(payload.data);
            setCalculatedSales(payload.data.calculated_todays_sales);
          }
        })
        .catch(() => setError("Unable to load dashboard"));
    };

    loadDashboard();
    loadProducts();

    const loadUsers = () => {
      if (role !== "SUPERADMIN") {
        setUsersList([]);
        return;
      }
      fetch(apiUrl('/api/users'), { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => r.json())
        .then((u) => {
          if (!u.error) setUsersList(u.data || []);
        })
        .catch(() => {});
    };

    loadUsers();

    const refreshData = () => {
      loadDashboard();
      loadProducts();
      if (role === "SUPERADMIN") {
        loadUsers();
      }
    };

    const intervalId = window.setInterval(refreshData, REFRESH_INTERVAL_MS);

    const handleProductsUpdated = () => {
      loadDashboard();
      loadProducts();
      if (role === "SUPERADMIN") {
        loadUsers();
      }
    };

    window.addEventListener('productsUpdated', handleProductsUpdated);
    const eventStream = new EventSource(`${apiUrl('/api/events')}?token=${encodeURIComponent(token)}`);
    eventStream.addEventListener('data-change', handleProductsUpdated);

    // expose loader for later usage
    window.__loadProductsDashboard = loadProducts;
    window.__loadUsersDashboard = loadUsers;

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('productsUpdated', handleProductsUpdated);
      eventStream.close();
    };
  }, [token, role]);

  if (error) {
    return <div className="dashboard-shell"><p className="error-message">{error}</p></div>;
  }

  if (!data) {
    return <div className="dashboard-shell"><p>Loading dashboard...</p></div>;
  }

  if ((viewMode === "products" || viewMode === "inventory") && !(role === "SUPERADMIN" || role === "ADMIN" || role === "STAFF")) {
    return <div className="dashboard-shell"><p className="error-message">You do not have access to inventory management.</p></div>;
  }

  if (viewMode === "users" && role !== "SUPERADMIN") {
    return <div className="dashboard-shell"><p className="error-message">You do not have access to Account Management.</p></div>;
  }

  if (data.vendor_summary) {
    return (
      <div className="dashboard-shell">
        <section className="dashboard-card">
          <h2>Vendor Dashboard</h2>
          <div className="dashboard-grid">
            <div className="metric-card">
              <span className="metric-label">Today's deliveries</span>
              <strong>{data.vendor_summary.today_delivery_count}</strong>
            </div>
            <div className="metric-card">
              <span className="metric-label">Today's total deliveries</span>
              <strong>{formatCurrency(data.vendor_summary.today_delivery_total)}</strong>
            </div>
          </div>
        </section>

        <section className="dashboard-card">
          <h3>Recent deliveries</h3>
          {data.vendor_summary.recent_deliveries.length === 0 ? (
            <p>No recent deliveries found.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Date</th>
                  <th>Time</th>
                  <th>Items</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {data.vendor_summary.recent_deliveries.map((delivery) => (
                  <tr key={delivery.id}>
                    <td>{delivery.id}</td>
                    <td data-label="Date">{formatRecordDate(delivery.delivery_date)}</td>
                    <td data-label="Time">{formatRecordTime(delivery.delivery_time)}</td>
                    <td data-label="Items">{delivery.items || "-"}</td>
                    <td data-label="Total">{formatCurrency(delivery.total_amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    );
  }

  const inventoryProducts = (productsList.length ? productsList : data?.products || []).filter((product) => product.active === 1 || product.active === true);

  const inventoryGrid = (
    <section className="management-page inventory-page">
      <div className="management-hero">
        <div>
          <span className="management-kicker">Live stock</span>
          <h2>Inventory</h2>
          <p>Track products and their available stock at a glance.</p>
        </div>
        <div className="management-count"><strong>{inventoryProducts.length}</strong><span>items</span></div>
      </div>

      <div className="inventory-grid">
        {inventoryProducts.length === 0 ? (
          <p className="muted-text">No inventory items available.</p>
        ) : (
          inventoryProducts.map((product) => (
            <article key={product.id} className="inventory-card">
              <div className="inventory-card-image-wrap">
                {product.image_url ? (
                  <img src={product.image_url} alt={product.name} className="inventory-card-image" />
                ) : (
                  <div className="inventory-card-placeholder">{(product.name || "P").slice(0, 1).toUpperCase()}</div>
                )}
              </div>
              <div className="inventory-card-body">
                <h3>{product.name}</h3>
                <p>{product.category || "General"}</p>
                <div className="inventory-stock-row">
                  <span>Stock</span>
                  <strong>{Number(product.current_stock || 0)}</strong>
                </div>
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );

  return (
    <div className="dashboard-shell">
      {viewMode === "dashboard" && (
        <div className="dashboard-grid dashboard-metric-grid">
            <div className="metric-card">
              <span className="metric-label">Today's total sales</span>
              <strong>{formatCurrency(calculatedSales ?? data.todays_total_sales)}</strong>
              <button type="button" className="small-button" onClick={() => setCalculatedSales(data.calculated_todays_sales)}>
                Recalculate Sales
              </button>
            </div>
            <div className="metric-card">
              <span className="metric-label">Today's delivery value</span>
              <strong>{formatCurrency(data.todays_total_deliveries)}</strong>
            </div>
            <div className="metric-card">
              <span className="metric-label">Transaction count</span>
              <strong>{data.todays_transaction_count}</strong>
            </div>
            <div className="metric-card">
              <span className="metric-label">Items sold today</span>
              <strong>{data.items_sold_today}</strong>
            </div>
            <div className="metric-card">
              <span className="metric-label">Total current inventory</span>
              <strong>{data.total_current_inventory}</strong>
            </div>
            <div className="metric-card">
              <span className="metric-label">Low-stock products</span>
              <strong>{data.low_stock_count}</strong>
            </div>
            <div className="metric-card">
              <span className="metric-label">Out-of-stock products</span>
              <strong>{data.out_of_stock_count}</strong>
            </div>
        </div>
      )}

      {viewMode === "inventory" && inventoryGrid}

      {viewMode === "dashboard" && (
        <>
          <section className="dashboard-chart-grid">
            <SalesTrendChart sales={data.recent_sales} />
            <InventoryStatusChart products={productsList} />
          </section>

          <SalesCalendar calendar={data.sales_calendar} />

          <section className="dashboard-card dashboard-charts">
            <h3>Recent activity</h3>
            <div className="table-pair">
              <div>
                <h4>Recent sales</h4>
                {data.recent_sales.length === 0 ? (
                  <p>No recent sales available.</p>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>ID</th>
                        <th>Date</th>
                        <th>Items</th>
                        <th>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recent_sales.map((sale) => (
                        <tr key={sale.id}>
                          <td>{sale.id}</td>
                          <td>{formatRecordDate(sale.sale_date)}</td>
                          <td>{sale.item_count}</td>
                          <td>{formatCurrency(sale.total_amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div>
                <h4>Recent deliveries</h4>
                {data.recent_deliveries.length === 0 ? (
                  <p>No recent deliveries available.</p>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>ID</th>
                        <th>Date</th>
                        <th>Vendor</th>
                        <th>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recent_deliveries.map((delivery) => (
                        <tr key={delivery.id}>
                          <td>{delivery.id}</td>
                          <td>{formatRecordDate(delivery.delivery_date)}</td>
                          <td>{delivery.vendor_name}</td>
                          <td>{formatCurrency(delivery.total_amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </section>

          <section className="low-stock-alert">
            <div className="low-stock-alert-header">
              <div>
                <span className="chart-kicker">Inventory attention</span>
                <h3>Low Stock Alert</h3>
                <p>Products that need replenishment soon.</p>
              </div>
              <span className="low-stock-alert-count">{data.low_stock_products.length} alerts</span>
            </div>
            {data.low_stock_products.length === 0 ? (
              <div className="low-stock-empty"><span className="low-stock-empty-icon">✓</span><span>All products are above their reorder levels.</span></div>
            ) : (
              <table className="low-stock-table">
                <thead>
                  <tr>
                    <th></th>
                    <th>Name</th>
                    <th>Category</th>
                    <th>Current Stock</th>
                    <th>Reorder Level</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.low_stock_products.map((product) => (
                    <tr key={product.id}>
                      <td data-label="">{product.image_url ? <img className="low-stock-product-image" src={product.image_url} alt="" /> : <span className="low-stock-product-icon">{product.name.slice(0, 1).toUpperCase()}</span>}</td>
                      <td data-label="Product"><strong className="low-stock-product-name">{product.name}</strong></td>
                      <td data-label="Category">{product.category || "General"}</td>
                      <td data-label="Current Stock"><strong className="stock-number">{product.current_stock} {product.unit || "units"}</strong></td>
                      <td data-label="Reorder Level">{product.minimum_stock} {product.unit || "units"}</td>
                      <td data-label="Status"><span className="low-stock-status">Low Stock</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}

      {viewMode === "products" && (
        <section className="management-page products-page">
          <div className="management-hero">
            <div>
              <span className="management-kicker">Catalog workspace</span>
              <h2>Product Management</h2>
              <p>Keep your beverage catalog, pricing, and stock availability up to date.</p>
            </div>
            <div className="management-count"><strong>{productsList.length}</strong><span>products</span></div>
          </div>
          {manageError && <p className="error-message">{manageError}</p>}
          {manageSuccess && <p className="success-message">{manageSuccess}</p>}

          <div className="management-panel">
            <div className="management-toolbar">
              <div>
                <h3>Catalog</h3>
                <span>Active and archived products</span>
              </div>
              <button className="primary-button" onClick={() => {
                setManageError(null);
                setManageSuccess(null);
                setShowCreateProductWindow(true);
              }}>Add New Product</button>
            </div>

            <div className="management-table-wrap">
              {productsList.length === 0 ? <p>No products available.</p> : (
                <table>
                  <thead>
                    <tr>
                      <th>Image</th>
                      <th>Name</th>
                      <th>Category</th>
                      <th>Price</th>
                      <th>Stock</th>
                      <th>Status</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {productsList.map((prod) => (
                      <tr key={prod.id}>
                        <td>{prod.image_url ? <img className="product-thumb" src={prod.image_url} alt="" /> : <span className="product-thumb product-thumb-empty">{prod.name.slice(0, 1).toUpperCase()}</span>}</td>
                        <td>{prod.name}</td>
                        <td>{prod.category || 'General'}</td>
                        <td>{formatCurrency(prod.selling_price)}</td>
                        <td>{prod.current_stock}</td>
                        <td><span className={`management-status ${prod.active === 1 ? 'is-active' : 'is-inactive'}`}>{prod.active === 1 ? 'Active' : 'Inactive'}</span></td>
                        <td><div className="management-actions">
                          <button className="small-button" onClick={() => {
                            setManageForm({ id: prod.id, name: prod.name, category: prod.category || '', selling_price: prod.selling_price, current_stock: prod.current_stock, image_url: prod.image_url || '' });
                            setShowEditProductWindow(true);
                            setManageError(null);
                            setManageSuccess(null);
                          }}>Edit</button>
                          {prod.active === 1 ? (
                            <button className="small-button" onClick={async () => {
                              if (!confirm(`Remove product \"${prod.name}\"? This will mark it inactive.`)) return;
                              try {
                                const res = await fetch(apiUrl(`/api/products/${prod.id}`), { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
                                const text = await res.text();
                                let body = {};
                                try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text.slice(0,200) }; }
                                if (!res.ok) throw new Error(body.error || `Failed to remove (status ${res.status})`);
                                if (window.__loadProductsDashboard) window.__loadProductsDashboard();
                                window.dispatchEvent(new Event('productsUpdated'));
                                fetch(apiUrl('/api/dashboard'), { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json()).then((payload) => { if (!payload.error) setData(payload.data); }).catch(() => {});
                              } catch (err) { alert(err.message || 'Unable to remove product'); }
                            }}>Remove</button>
                          ) : (
                            <button className="small-button" onClick={async () => {
                              try {
                                if (!confirm(`Restore product \"${prod.name}\" and mark it active again?`)) return;
                                const res = await fetch(apiUrl(`/api/products/${prod.id}/activate`), {
                                  method: 'PATCH',
                                  headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
                                  body: JSON.stringify({ active: true }),
                                });
                                const text = await res.text();
                                let body = {};
                                try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text.slice(0,200) }; }
                                if (!res.ok) throw new Error(body.error || `Failed to restore (status ${res.status})`);
                                if (window.__loadProductsDashboard) window.__loadProductsDashboard();
                                window.dispatchEvent(new Event('productsUpdated'));
                                fetch(apiUrl('/api/dashboard'), { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json()).then((payload) => { if (!payload.error) setData(payload.data); }).catch(() => {});
                              } catch (err) { alert(err.message || 'Unable to restore product'); }
                            }}>Restore</button>
                          )}
                        </div></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </section>
      )}

      {viewMode === "users" && (
        <section className="management-page users-page">
          <div className="management-hero">
            <div>
              <span className="management-kicker">People & permissions</span>
              <h2>Manage Accounts</h2>
              <p>Control staff access and keep vendor contact details organized.</p>
            </div>
            <div className="management-count"><strong>{usersList.length}</strong><span>accounts</span></div>
          </div>
          <div className="management-panel">
            {manageError && <p className="error-message">{manageError}</p>}
            {manageSuccess && <p className="success-message">{manageSuccess}</p>}

            <div className="management-toolbar">
              <div>
                <h3>Accounts</h3>
                <span>Admins, staff, and vendors</span>
              </div>
              <button className="primary-button" onClick={() => {
                setManageError(null);
                setManageSuccess(null);
                setCreateAccountForm({ name: '', role: 'ADMIN', vendor_id: '', contact_person: '', contact_number: '' });
                setShowCreateAccountWindow(true);
              }}>Add New Account</button>
            </div>

            <div className="management-table-wrap">
              {usersList.length === 0 ? <p>No users found.</p> : (
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Email</th>
                      <th>Role</th>
                      <th>Vendor ID</th>
                      <th>Contact Person</th>
                      <th>Contact Number</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usersList.map((user) => (
                      <tr key={user.id}>
                        <td>{user.name}</td>
                        <td>{user.email}</td>
                        <td><span className={`role-badge role-${user.role.toLowerCase()}`}>{user.role}</span></td>
                        <td>{user.role === 'VENDOR' ? (user.vendor_code || 'Assigned automatically') : '—'}</td>
                        <td>{user.contact_person || '—'}</td>
                        <td>{user.contact_number || '—'}</td>
                        <td><div className="management-actions">
                          <button className="small-button" onClick={() => {
                            setManageError('Account editing is not available in this build yet.');
                            setManageSuccess(null);
                          }}>Edit</button>
                          <button className="small-button" onClick={async () => {
                            if (!confirm(`Delete user ${user.name}?`)) return;
                            try {
                              const res = await fetch(apiUrl(`/api/users/${user.id}`), {
                                method: 'DELETE',
                                headers: { Authorization: `Bearer ${token}` }
                              });
                              const text = await res.text();
                              let body = {};
                              try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text.slice(0,200) }; }
                              if (!res.ok) throw new Error(body.error || `Delete failed (${res.status})`);
                              if (window.__loadUsersDashboard) window.__loadUsersDashboard();
                            } catch (err) {
                              alert(err.message || 'Unable to delete user');
                            }
                          }}>Delete</button>
                        </div></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </section>
      )}

      {showCreateAccountWindow && (
        <div className="management-modal-overlay" role="dialog" aria-modal="true">
          <div className="management-modal-card">
            <div className="management-modal-header">
              <h3>Add New Account</h3>
              <button className="small-button" onClick={() => setShowCreateAccountWindow(false)}>Close</button>
            </div>

            <form onSubmit={async (e) => {
              e.preventDefault();
              setManageError(null);
              setManageSuccess(null);
              try {
                if (!createAccountForm.name || !createAccountForm.contact_person || !createAccountForm.contact_number) {
                  throw new Error('Name, contact person, and contact number are required');
                }

                const superadminPassword = window.prompt('Enter the Superadmin password to confirm this account creation:');
                if (superadminPassword === null || !superadminPassword.trim()) {
                  throw new Error('Superadmin verification password is required');
                }

                const verifyRes = await fetch(apiUrl('/api/users/verify-superadmin'), {
                  method: 'POST',
                  headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
                  body: JSON.stringify({ password: superadminPassword })
                });
                const verifyText = await verifyRes.text();
                let verifyBody = {};
                try { verifyBody = verifyText ? JSON.parse(verifyText) : {}; } catch { verifyBody = { error: verifyText.slice(0,200) }; }
                if (!verifyRes.ok) throw new Error(verifyBody.error || 'Superadmin verification failed');

                const username = window.prompt('Enter the new account username:');
                if (username === null || !username.trim()) {
                  throw new Error('Username is required');
                }

                const password = window.prompt('Enter the new account password:');
                if (password === null || !password.trim()) {
                  throw new Error('Password is required');
                }

                const res = await fetch(apiUrl('/api/users'), {
                  method: 'POST',
                  headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
                  body: JSON.stringify({
                    username,
                    password,
                    name: createAccountForm.name,
                    role: createAccountForm.role,
                    contact_person: createAccountForm.contact_person,
                    contact_number: createAccountForm.contact_number,
                  })
                });
                const text = await res.text();
                let body = {};
                try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text.slice(0,200) }; }
                if (!res.ok) throw new Error(body.error || `Create account failed (${res.status})`);
                if (window.__loadUsersDashboard) window.__loadUsersDashboard();
                setManageSuccess(`Account created successfully for ${createAccountForm.name.trim()}.`);
                setCreateAccountForm({ name: '', role: 'ADMIN', vendor_id: '', contact_person: '', contact_number: '' });
                setShowCreateAccountWindow(false);
              } catch (err) {
                setManageError(err.message || 'Unable to create account');
              }
            }} className="management-modal-form">
              <label>
                Name
                <input value={createAccountForm.name} onChange={(e) => setCreateAccountForm({ ...createAccountForm, name: e.target.value })} required />
              </label>
              <label>
                Account type
                <select value={createAccountForm.role} onChange={(e) => setCreateAccountForm({ ...createAccountForm, role: e.target.value })}>
                  <option value="ADMIN">Admin</option>
                  <option value="STAFF">Staff</option>
                  <option value="VENDOR">Vendor</option>
                </select>
              </label>
              {createAccountForm.role === 'VENDOR' && <p className="management-form-hint">A unique vendor code will be assigned automatically for POS pickups.</p>}
              <label>
                Contact Person
                <input value={createAccountForm.contact_person} onChange={(e) => setCreateAccountForm({ ...createAccountForm, contact_person: e.target.value })} required />
              </label>
              <label>
                Contact Number
                <input value={createAccountForm.contact_number} onChange={(e) => setCreateAccountForm({ ...createAccountForm, contact_number: e.target.value })} required />
              </label>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button type="button" className="small-button" onClick={() => setShowCreateAccountWindow(false)}>Cancel</button>
                <button type="submit" className="primary-button">Save Account</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showEditProductWindow && (
        <div className="management-modal-overlay" role="dialog" aria-modal="true">
          <div className="management-modal-card">
            <div className="management-modal-header">
              <h3>Edit Product</h3>
              <button className="small-button" onClick={() => setShowEditProductWindow(false)}>Close</button>
            </div>

            <form onSubmit={async (e) => {
              e.preventDefault();
              setManageError(null);
              try {
                if (!manageForm.id) throw new Error('Product not selected');
                if (!manageForm.name.trim()) throw new Error('Product name is required');
                const payload = {
                  name: manageForm.name,
                  category: manageForm.category,
                  selling_price: Number(manageForm.selling_price) || 0,
                  minimum_stock: 0,
                  unit: 'unit',
                  current_stock: Number(manageForm.current_stock) || 0,
                  image_url: manageForm.image_url || null,
                };
                const res = await fetch(apiUrl(`/api/products/${manageForm.id}`), {
                  method: 'PUT',
                  headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
                  body: JSON.stringify(payload),
                });
                const text = await res.text();
                let body = {};
                try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text.slice(0, 200) }; }
                if (!res.ok) throw new Error(body.error || `Update failed (status ${res.status})`);
                if (window.__loadProductsDashboard) window.__loadProductsDashboard();
                window.dispatchEvent(new Event('productsUpdated'));
                fetch(apiUrl('/api/dashboard'), { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json()).then((payload) => { if (!payload.error) setData(payload.data); }).catch(() => {});
                setManageForm({ id: null, name: '', category: '', selling_price: '', current_stock: '', image_url: '' });
                setShowEditProductWindow(false);
              } catch (err) {
                setManageError(err.message || 'Update failed');
              }
            }} className="management-modal-form">
              <label>
                Name
                <input value={manageForm.name} onChange={(e) => setManageForm({ ...manageForm, name: e.target.value })} required />
              </label>
              <label>
                Category
                <input value={manageForm.category} onChange={(e) => setManageForm({ ...manageForm, category: e.target.value })} />
              </label>
              <label>
                Price
                <input type="number" step="0.01" value={manageForm.selling_price} onChange={(e) => setManageForm({ ...manageForm, selling_price: e.target.value })} />
              </label>
              <label className="product-image-field">
                Product image
                <input type="file" accept="image/*" onChange={(e) => readProductImage(e.target.files?.[0], (image_url) => setManageForm({ ...manageForm, image_url }), setManageError)} />
                {manageForm.image_url ? <img className="product-image-preview" src={manageForm.image_url} alt="Product preview" /> : <span className="product-image-placeholder">No image selected</span>}
              </label>
              <label>
                Current Stock
                <input type="number" min="0" step="1" value={manageForm.current_stock ?? 0} onChange={(e) => setManageForm({ ...manageForm, current_stock: e.target.value })} required />
              </label>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button type="button" className="small-button" onClick={() => setShowEditProductWindow(false)}>Cancel</button>
                <button type="submit" className="primary-button">Save Changes</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showCreateProductWindow && (
        <div className="management-modal-overlay" role="dialog" aria-modal="true">
          <div className="management-modal-card">
            <div className="management-modal-header">
              <h3>Create Product</h3>
              <button className="small-button" onClick={() => setShowCreateProductWindow(false)}>Close</button>
            </div>

            <form onSubmit={async (e) => {
              e.preventDefault();
              setManageError(null);
              try {
                if (!createProductForm.name.trim()) throw new Error('Product name is required');
                const createPayload = {
                  name: createProductForm.name,
                  category: createProductForm.category,
                  selling_price: Number(createProductForm.selling_price) || 0,
                  initial_stock: Number(createProductForm.current_stock) || 0,
                  minimum_stock: 0,
                  image_url: createProductForm.image_url || null,
                };
                const res = await fetch(apiUrl('/api/products'), {
                  method: 'POST',
                  headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
                  body: JSON.stringify(createPayload),
                });
                const text = await res.text();
                let body = {};
                try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text.slice(0, 200) }; }
                if (!res.ok) throw new Error(body.error || `Create failed (status ${res.status})`);
                if (window.__loadProductsDashboard) window.__loadProductsDashboard();
                window.dispatchEvent(new Event('productsUpdated'));
                fetch(apiUrl('/api/dashboard'), { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json()).then((payload) => { if (!payload.error) setData(payload.data); }).catch(() => {});
                setCreateProductForm({ name: '', category: '', selling_price: '', current_stock: '', image_url: '' });
                setShowCreateProductWindow(false);
              } catch (err) {
                setManageError(err.message || 'Create failed');
              }
            }} className="management-modal-form">
              <label>
                Name
                <input value={createProductForm.name} onChange={(e) => setCreateProductForm({ ...createProductForm, name: e.target.value })} required />
              </label>
              <label>
                Category
                <input value={createProductForm.category} onChange={(e) => setCreateProductForm({ ...createProductForm, category: e.target.value })} />
              </label>
              <label>
                Price
                <input type="number" step="0.01" value={createProductForm.selling_price} onChange={(e) => setCreateProductForm({ ...createProductForm, selling_price: e.target.value })} />
              </label>
              <label className="product-image-field">
                Product image
                <input type="file" accept="image/*" onChange={(e) => readProductImage(e.target.files?.[0], (image_url) => setCreateProductForm({ ...createProductForm, image_url }), setManageError)} />
                {createProductForm.image_url ? <img className="product-image-preview" src={createProductForm.image_url} alt="Product preview" /> : <span className="product-image-placeholder">No image selected</span>}
              </label>
              <label>
                Initial Stock
                <input type="number" value={createProductForm.current_stock} onChange={(e) => setCreateProductForm({ ...createProductForm, current_stock: e.target.value })} />
              </label>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button type="button" className="small-button" onClick={() => setShowCreateProductWindow(false)}>Cancel</button>
                <button type="submit" className="primary-button">Save Product</button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
}

export default Dashboard;
