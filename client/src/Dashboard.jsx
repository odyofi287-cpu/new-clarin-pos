import { Fragment, useEffect, useState } from "react";
import { apiUrl } from "./api";
import StockNotification, { StockIcon } from "./StockNotification";
import { activeInventoryProducts, normalizeStockFilter, productStockStatus, stockAlertKey } from "./stockAlerts";
import SalesCalendar from "./SalesCalendar";
import { formatItemQuantity } from "./productQuantity";
import "./productManagement.css";

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

function InventoryStatusChart({ products, onOpenStockFilter }) {
  const activeProducts = activeInventoryProducts(products);
  const total = activeProducts.length;
  const outOfStock = activeProducts.filter((product) => productStockStatus(product) === "out-of-stock").length;
  const lowStock = activeProducts.filter((product) => productStockStatus(product) === "low-stock").length;
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
          <button type="button" className="stock-legend-button" onClick={() => onOpenStockFilter("low-stock")}><span className="legend-dot legend-orange" /><span>Low Stock</span><strong>{lowStock}</strong></button>
          <button type="button" className="stock-legend-button" onClick={() => onOpenStockFilter("out-of-stock")}><span className="legend-dot legend-red" /><span>Out of Stock</span><strong>{outOfStock}</strong></button>
        </div>
      </div>
    </div>
  );
}

function Dashboard({ token, role, viewMode = "dashboard", onNavigate, stockFilter = "all", onStockFilterChange }) {
  const REFRESH_INTERVAL_MS = 6000;
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [productsList, setProductsList] = useState([]);
  const [productSearch, setProductSearch] = useState("");
  const [dismissedStockAlertKey, setDismissedStockAlertKey] = useState("");
  const [manageForm, setManageForm] = useState({ id: null, name: "", category: "", selling_price: "", current_stock: "", image_url: "" });
  const [usersList, setUsersList] = useState([]);
  const [manageError, setManageError] = useState(null);
  const [manageSuccess, setManageSuccess] = useState(null);
  const [deletingProductId, setDeletingProductId] = useState(null);
  const [showCreateProductWindow, setShowCreateProductWindow] = useState(false);
  const [showEditProductWindow, setShowEditProductWindow] = useState(false);
  const [showCreateAccountWindow, setShowCreateAccountWindow] = useState(false);
  const [expandedVendorDeliveryIds, setExpandedVendorDeliveryIds] = useState(() => new Set());
  const [createProductForm, setCreateProductForm] = useState({ name: "", category: "", selling_price: "", current_stock: "", image_url: "" });
  const [createAccountForm, setCreateAccountForm] = useState({ name: "", role: "STAFF", vendor_id: "", contact_person: "", contact_number: "" });
  const stockAlerts = data?.stock_alert_products || data?.low_stock_products || [];
  const currentStockAlertKey = stockAlertKey(stockAlerts);

  useEffect(() => {
    if (!currentStockAlertKey) setDismissedStockAlertKey("");
  }, [currentStockAlertKey]);

  useEffect(() => {
    if (!token) {
      setError("Authentication required");
      return;
    }

    let productsRequestSequence = 0;
    let active = true;
    const loadProducts = () => {
      const requestSequence = ++productsRequestSequence;
      const productQuery = role === "VENDOR" ? "active=1" : "active=all";
      fetch(apiUrl(`/api/products?${productQuery}`), { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => r.json())
        .then((p) => {
          if (active && requestSequence === productsRequestSequence && !p.error) {
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
          }
        })
        .catch(() => setError("Unable to load dashboard"));
    };

    loadDashboard();
    loadProducts();

    const loadUsers = () => {
      if (role !== "ADMIN") {
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
      if (role === "ADMIN") {
        loadUsers();
      }
    };

    const intervalId = window.setInterval(refreshData, REFRESH_INTERVAL_MS);

    const handleProductsUpdated = () => {
      loadDashboard();
      loadProducts();
      if (role === "ADMIN") {
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
      active = false;
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

  if (viewMode === "products" && !(role === "ADMIN" || role === "STAFF")) {
    return <div className="dashboard-shell"><p className="error-message">You do not have access to inventory management.</p></div>;
  }

  if (viewMode === "users" && role !== "ADMIN") {
    return <div className="dashboard-shell"><p className="error-message">You do not have access to Account Management.</p></div>;
  }

  const openStockList = (filter) => onNavigate?.("inventory", { stockFilter: filter });

  if (data.vendor_summary && viewMode === "dashboard") {
    const paymentSummary = data.vendor_summary.payment_summary || {};
    const paidDeliveryCount = Number(paymentSummary.paid_delivery_count || 0);
    const unpaidDeliveryCount = Number(paymentSummary.unpaid_delivery_count || 0);
    const returnCount = Number(paymentSummary.return_count || 0);
    const dailyHistory = data.vendor_summary.daily_history || [];
    const todayDeliveryAccounts = data.vendor_summary.today_delivery_accounts || [];
    const netPayableAmount = Number(paymentSummary.net_payable_amount || 0);
    const toggleVendorDeliveryProducts = (deliveryId) => {
      setExpandedVendorDeliveryIds((current) => {
        const next = new Set(current);
        if (next.has(deliveryId)) next.delete(deliveryId);
        else next.add(deliveryId);
        return next;
      });
    };

    return (
      <div className="dashboard-shell vendor-dashboard">
        <section className="dashboard-card">
          <h2>Vendor Dashboard</h2>
          <div className="dashboard-grid vendor-today-grid">
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

        <section className="dashboard-card vendor-payment-overview">
          <div className="vendor-payment-heading">
            <div>
              <span className="vendor-payment-kicker">Today's payment overview</span>
              <h3>Daily delivery account summary</h3>
              <p>Resets each Manila business day. Previous daily totals remain available in the history below.</p>
            </div>
            <span className="vendor-payment-live">{formatRecordDate(data.vendor_summary.account_date)}</span>
          </div>

          <div className="vendor-payment-grid">
            <article className="vendor-payment-card is-paid">
              <div className="vendor-payment-card-head">
                <span>Paid deliveries</span>
                <span className="vendor-payment-status">Paid</span>
              </div>
              <div className="vendor-payment-count"><strong>{paidDeliveryCount}</strong><span>{paidDeliveryCount === 1 ? "delivery" : "deliveries"}</span></div>
              <div className="vendor-payment-amount"><span>Paid amount</span><strong>{formatCurrency(paymentSummary.paid_delivery_amount)}</strong></div>
            </article>

            <article className="vendor-payment-card is-unpaid">
              <div className="vendor-payment-card-head">
                <span>Unpaid deliveries</span>
                <span className="vendor-payment-status">Unpaid</span>
              </div>
              <div className="vendor-payment-count"><strong>{unpaidDeliveryCount}</strong><span>{unpaidDeliveryCount === 1 ? "delivery" : "deliveries"}</span></div>
              <div className="vendor-payment-amount"><span>Unpaid amount</span><strong>{formatCurrency(paymentSummary.unpaid_delivery_amount)}</strong></div>
            </article>

            <article className="vendor-payment-card is-return">
              <div className="vendor-payment-card-head">
                <span>Return adjustments</span>
                <span className="vendor-payment-status">Deducted</span>
              </div>
              <div className="vendor-payment-count"><strong>{returnCount}</strong><span>{returnCount === 1 ? "return" : "returns"}</span></div>
              <div className="vendor-payment-amount"><span>Amount deducted</span><strong>-{formatCurrency(paymentSummary.return_adjustment_amount)}</strong></div>
            </article>

            <article className="vendor-payment-card is-net">
              <div className="vendor-payment-card-head">
                <span>Net payable total</span>
                <span className="vendor-payment-status">Outstanding</span>
              </div>
              <div className="vendor-payment-count"><strong>{unpaidDeliveryCount}</strong><span>{unpaidDeliveryCount === 1 ? "unpaid delivery" : "unpaid deliveries"}</span></div>
              <div className="vendor-payment-amount"><span>After returns</span><strong>{formatCurrency(netPayableAmount)}</strong></div>
            </article>
          </div>
          <div className="vendor-today-account-table management-table-wrap">
            {todayDeliveryAccounts.length === 0 ? <p>No deliveries have been recorded for today.</p> : (
              <table>
                <thead><tr><th>Delivery #</th><th>Original Amount</th><th>Return Deduction</th><th>Amount Due</th><th>Payment Status</th><th>Time</th><th>Products</th></tr></thead>
                <tbody>{todayDeliveryAccounts.map((delivery) => {
                  const expanded = expandedVendorDeliveryIds.has(delivery.id);
                  return <Fragment key={`vendor-account-${delivery.id}`}>
                    <tr>
                      <td data-label="Delivery #"><strong>#{delivery.id}</strong></td>
                      <td data-label="Original Amount">{formatCurrency(delivery.original_amount)}</td>
                      <td data-label="Return Deduction"><strong className="vendor-account-deduction">-{formatCurrency(delivery.return_deduction)}</strong></td>
                      <td data-label="Amount Due"><strong>{formatCurrency(delivery.amount_due)}</strong></td>
                      <td data-label="Payment Status"><span className={`vendor-delivery-payment ${String(delivery.payment_status).toUpperCase() === "PAID" ? "is-paid" : "is-unpaid"}`}>{String(delivery.payment_status).toUpperCase() === "PAID" ? "Paid" : "Unpaid"}</span></td>
                      <td data-label="Time">{formatRecordTime(delivery.delivery_time)}</td>
                      <td data-label="Products"><button type="button" className="vendor-products-toggle" aria-expanded={expanded} onClick={() => toggleVendorDeliveryProducts(delivery.id)}>{expanded ? "Hide Products" : "Show Products"}</button></td>
                    </tr>
                    {expanded && <tr className="vendor-products-detail"><td colSpan="7">{delivery.items || "No product details available."}</td></tr>}
                  </Fragment>;
                })}</tbody>
              </table>
            )}
          </div>
          <p className="vendor-payment-formula">Each delivery amount due is its original amount minus returns assigned to that delivery. Net payable includes unpaid deliveries only.</p>
        </section>

        <section className="dashboard-card vendor-daily-history">
          <div className="vendor-payment-heading">
            <div>
              <span className="vendor-payment-kicker">Account monitoring</span>
              <h3>Daily delivery account history</h3>
              <p>Review each day's paid, unpaid, returned, and outstanding totals.</p>
            </div>
            <span className="vendor-payment-live">{dailyHistory.length} days</span>
          </div>
          {dailyHistory.length === 0 ? (
            <p>No delivery account history is available.</p>
          ) : (
            <div className="management-table-wrap">
              <table>
                <thead><tr><th>Date</th><th>Deliveries</th><th>Paid</th><th>Unpaid</th><th>Returns</th><th>Net Payable</th></tr></thead>
                <tbody>{dailyHistory.map((day) => <tr key={day.account_date}>
                  <td data-label="Date"><strong>{formatRecordDate(day.account_date)}</strong></td>
                  <td data-label="Deliveries">{day.total_delivery_count}<small>{formatCurrency(day.gross_delivery_amount)}</small></td>
                  <td data-label="Paid">{day.paid_delivery_count}<small>{formatCurrency(day.paid_delivery_amount)}</small></td>
                  <td data-label="Unpaid">{day.unpaid_delivery_count}<small>{formatCurrency(day.unpaid_delivery_amount)}</small></td>
                  <td data-label="Returns">{day.return_count}<small>-{formatCurrency(day.return_adjustment_amount)}</small></td>
                  <td data-label="Net Payable"><strong>{formatCurrency(day.net_payable_amount)}</strong></td>
                </tr>)}</tbody>
              </table>
            </div>
          )}
        </section>

      </div>
    );
  }

  const normalizedProductSearch = productSearch.trim().toLowerCase();
  const matchesProductSearch = (product) => !normalizedProductSearch || `${product.name || ""} ${product.category || ""}`.toLowerCase().includes(normalizedProductSearch);
  const inventorySource = productsList.length ? productsList : data?.products || [];
  const selectedStockFilter = normalizeStockFilter(stockFilter);
  const inventoryProducts = activeInventoryProducts(inventorySource, selectedStockFilter, productSearch);
  const stockFilterOptions = [
    { value: "all", label: "All products" },
    { value: "low-stock", label: "Low stock" },
    { value: "out-of-stock", label: "Out of stock" },
  ];
  const inventoryTitle = selectedStockFilter === "low-stock" ? "Low-stock products" : selectedStockFilter === "out-of-stock" ? "Out-of-stock products" : "Inventory";
  const filteredProducts = productsList.filter(matchesProductSearch);

  const inventoryGrid = (
    <section className="management-page inventory-page">
      <div className="management-hero">
        <div>
          <span className="management-kicker">{role === "VENDOR" ? "Read-only stock monitor" : "Live stock"}</span>
          <h2>{inventoryTitle}</h2>
          <p>{selectedStockFilter === "low-stock" ? "Active products with 1 to 10 Items remaining. Plan your next restock." : selectedStockFilter === "out-of-stock" ? "Active products with no available stock. Review these products before the next sale or delivery." : role === "VENDOR" ? "Monitor the current stock of products available from the arena." : "Track products and their available stock at a glance."}</p>
        </div>
        <div className="management-count"><strong>{inventoryProducts.length}</strong><span>items</span></div>
      </div>

      <div className="inventory-stock-filters" role="group" aria-label="Filter inventory by stock status">
        {stockFilterOptions.map((option) => (
          <button type="button" key={option.value} className={selectedStockFilter === option.value ? "is-selected" : ""} aria-pressed={selectedStockFilter === option.value} onClick={() => onStockFilterChange?.(option.value)}>
            {option.label}<span>{activeInventoryProducts(inventorySource, option.value).length}</span>
          </button>
        ))}
      </div>

      <div className="product-search-row">
        <label className="product-search-field">
          Search inventory
          <input type="search" value={productSearch} onChange={(event) => setProductSearch(event.target.value)} placeholder="Search by product or category" />
        </label>
        {productSearch && <button type="button" className="small-button" onClick={() => setProductSearch("")}>Clear</button>}
      </div>

      <div className="inventory-grid">
        {inventoryProducts.length === 0 ? (
            <div className="inventory-empty-state"><StockIcon outOfStock={selectedStockFilter === "out-of-stock"} /><h3>{productSearch ? "No matching products" : selectedStockFilter === "all" ? "No active products" : `No ${selectedStockFilter} products`}</h3><p>{productSearch ? "Try another product name or category, or choose a different stock filter." : selectedStockFilter === "all" ? "Products will appear here when they are added to the active catalog." : "There are no active products in this stock group right now."}</p></div>
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
                  <span className={`inventory-stock-label is-${productStockStatus(product)}`}>{productStockStatus(product) === "out-of-stock" ? "Out of stock" : productStockStatus(product) === "low-stock" ? "Low stock" : "Available stock"}</span>
                  <strong>{formatItemQuantity(product.current_stock)}</strong>
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
            <button type="button" className="metric-card total-sales-launch" onClick={() => onNavigate?.("total-sales")}>
              <span className="metric-label">Sales</span>
              <strong>{formatCurrency(data.calculated_todays_sales)}</strong>
              <span className="total-sales-launch-footer"><b>View analytics →</b></span>
            </button>
            <div className="metric-card">
              <span className="metric-label">Today's delivery value</span>
              <strong>{formatCurrency(data.todays_total_deliveries)}</strong>
            </div>
            <div className="metric-card" title="Today's recorded sales, vendor pickups, and return batches. Each bulk transaction counts once.">
              <span className="metric-label">Transaction count</span>
              <strong>{data.todays_transaction_count}</strong>
            </div>
            <div className="metric-card" title="Today's recorded sale items plus delivered items minus returned items.">
              <span className="metric-label">Items sold today</span>
              <strong>{data.items_sold_today}</strong>
            </div>
            <div className="metric-card">
              <span className="metric-label">Total current inventory</span>
              <strong>{data.total_current_inventory}</strong>
            </div>
            <button type="button" className="metric-card stock-counter-launch is-low-stock" onClick={() => openStockList("low-stock")}>
              <span className="metric-label">Low-stock products</span>
              <strong>{data.low_stock_count}</strong>
              <span className="stock-counter-footer"><StockIcon /><span>View products <span aria-hidden="true">&rarr;</span></span></span>
            </button>
            <button type="button" className="metric-card stock-counter-launch is-out-of-stock" onClick={() => openStockList("out-of-stock")}>
              <span className="metric-label">Out-of-stock products</span>
              <strong>{data.out_of_stock_count}</strong>
              <span className="stock-counter-footer"><StockIcon outOfStock /><span>View products <span aria-hidden="true">&rarr;</span></span></span>
            </button>
        </div>
      )}

      {viewMode === "inventory" && inventoryGrid}

      {viewMode === "dashboard" && (
        <>
          {currentStockAlertKey && dismissedStockAlertKey !== currentStockAlertKey && (
            <StockNotification products={stockAlerts} onOpen={openStockList} onDismiss={() => setDismissedStockAlertKey(currentStockAlertKey)} />
          )}
          <section className="dashboard-chart-grid">
            <SalesTrendChart sales={data.recent_sales} />
            <InventoryStatusChart products={productsList} onOpenStockFilter={openStockList} />
          </section>

          <SalesCalendar calendar={data.sales_calendar} token={token} />

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
            <div className="product-search-row">
              <label className="product-search-field">
                Search products
                <input type="search" value={productSearch} onChange={(event) => setProductSearch(event.target.value)} placeholder="Search by product or category" />
              </label>
              {productSearch && <button type="button" className="small-button" onClick={() => setProductSearch("")}>Clear</button>}
            </div>
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
              {filteredProducts.length === 0 ? <p>{productsList.length === 0 ? "No products available." : "No products match your search."}</p> : (
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
                    {filteredProducts.map((prod) => (
                      <tr key={prod.id}>
                        <td data-label="Image">{prod.image_url ? <img className="product-thumb" src={prod.image_url} alt="" /> : <span className="product-thumb product-thumb-empty">{prod.name.slice(0, 1).toUpperCase()}</span>}</td>
                        <td data-label="Name">{prod.name}</td>
                        <td data-label="Category">{prod.category || 'General'}</td>
                        <td data-label="Price">{formatCurrency(prod.selling_price)}</td>
                        <td data-label="Stock">{formatItemQuantity(prod.current_stock)}</td>
                        <td data-label="Status"><span className={`management-status ${prod.active === 1 ? 'is-active' : 'is-inactive'}`}>{prod.active === 1 ? 'Active' : 'Inactive'}</span></td>
                        <td data-label="Actions"><div className="management-actions">
                          <button className="small-button" onClick={() => {
                            setManageForm({ id: prod.id, name: prod.name, category: prod.category || '', selling_price: prod.selling_price, current_stock: prod.current_stock, image_url: prod.image_url || '' });
                            setShowEditProductWindow(true);
                            setManageError(null);
                            setManageSuccess(null);
                          }}>Edit</button>
                          {prod.active === 1 ? (
                            <button className="small-button" onClick={async () => {
                              if (!confirm(`Archive product \"${prod.name}\"? You can restore it later.`)) return;
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
                            }}>Archive</button>
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
                          <button type="button" className="small-button product-delete-button" disabled={deletingProductId === prod.id} aria-label={`Delete ${prod.name}`} onClick={async () => {
                            if (!window.confirm(`Permanently remove \"${prod.name}\" from the product list? It cannot be restored. Existing sales, deliveries, and returns will keep their records, and future returns will not make this product reappear.`)) return;
                            setDeletingProductId(prod.id);
                            setManageError(null);
                            setManageSuccess(null);
                            try {
                              const response = await fetch(apiUrl(`/api/products/${prod.id}/permanent`), {
                                method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
                              });
                              const body = await response.json();
                              if (!response.ok) throw new Error(body.error || 'Unable to delete product');
                              setProductsList((current) => current.filter((product) => product.id !== prod.id));
                              setManageSuccess(`${prod.name} removed from the product list. Its transaction history is preserved.`);
                              window.dispatchEvent(new Event('productsUpdated'));
                            } catch (error) {
                              setManageError(error.message || 'Unable to delete product');
                            } finally {
                              setDeletingProductId(null);
                            }
                          }}>{deletingProductId === prod.id ? 'Deleting…' : 'Delete'}</button>
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
                setCreateAccountForm({ name: '', role: 'STAFF', vendor_id: '', contact_person: '', contact_number: '' });
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
                        <td data-label="Name">{user.name}</td>
                        <td data-label="Email">{user.email}</td>
                        <td data-label="Role"><span className={`role-badge role-${user.role.toLowerCase()}`}>{user.role}</span></td>
                        <td>{user.role === 'VENDOR' ? (user.vendor_code || 'Assigned automatically') : '—'}</td>
                        <td>{user.contact_person || '—'}</td>
                        <td>{user.contact_number || '—'}</td>
                        <td data-label="Actions"><div className="management-actions">
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

                const adminPassword = window.prompt('Enter the Admin password to confirm this account creation:');
                if (adminPassword === null || !adminPassword.trim()) {
                  throw new Error('Admin verification password is required');
                }

                const verifyRes = await fetch(apiUrl('/api/users/verify-admin'), {
                  method: 'POST',
                  headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
                  body: JSON.stringify({ password: adminPassword })
                });
                const verifyText = await verifyRes.text();
                let verifyBody = {};
                try { verifyBody = verifyText ? JSON.parse(verifyText) : {}; } catch { verifyBody = { error: verifyText.slice(0,200) }; }
                if (!verifyRes.ok) throw new Error(verifyBody.error || 'Admin verification failed');

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
                setCreateAccountForm({ name: '', role: 'STAFF', vendor_id: '', contact_person: '', contact_number: '' });
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
                  unit: 'item',
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
