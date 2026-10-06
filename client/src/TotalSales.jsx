import { useEffect, useMemo, useState } from "react";
import { apiUrl } from "./api";

const REFRESH_INTERVAL_MS = 6000;

function formatCurrency(value) {
  return Number(value || 0).toLocaleString("en-PH", {
    style: "currency",
    currency: "PHP",
    minimumFractionDigits: 2,
  });
}

function formatCompactCurrency(value) {
  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(Number(value || 0));
}

function formatDate(value, options = {}) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...options })
    .format(new Date(`${value}T00:00:00Z`));
}

function ProductImage({ product }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [product.image_url]);

  if (!product.image_url || failed) {
    return <span className="total-sales-product-fallback" aria-hidden="true">{String(product.name || "P").slice(0, 1).toUpperCase()}</span>;
  }

  return <img src={product.image_url} alt={`${product.name} product`} onError={() => setFailed(true)} />;
}

function SalesBarChart({ title, description, rows, labelFor }) {
  const max = Math.max(...rows.map((row) => Math.abs(Number(row.total || 0))), 1);
  const total = rows.reduce((sum, row) => sum + Number(row.total || 0), 0);

  return (
    <article className="total-sales-chart-card">
      <div className="total-sales-chart-heading">
        <div>
          <span className="chart-kicker">Net sales</span>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        <strong>{formatCurrency(total)}</strong>
      </div>
      <div className="total-sales-bars" role="img" aria-label={`${title} chart`}>
        {rows.map((row) => {
          const amount = Number(row.total || 0);
          const height = amount !== 0 ? Math.max((Math.abs(amount) / max) * 100, 5) : 2;
          return (
            <div className="total-sales-bar-column" key={row.period} title={`${labelFor(row)}: ${formatCurrency(row.total)}`}>
              <span className={`total-sales-bar-value ${amount < 0 ? "is-negative" : ""}`}>{amount !== 0 ? formatCompactCurrency(amount) : ""}</span>
              <div className="total-sales-bar-track"><i className={amount < 0 ? "is-negative" : ""} style={{ height: `${height}%` }} /></div>
              <span className="total-sales-bar-label">{labelFor(row)}</span>
            </div>
          );
        })}
      </div>
    </article>
  );
}

function TotalSales({ token, onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!token) return undefined;
    let active = true;
    let hasLoaded = false;

    const loadSales = async () => {
      try {
        const response = await fetch(apiUrl("/api/dashboard/total-sales"), {
          headers: { Authorization: `Bearer ${token}` },
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Unable to load total sales");
        if (active) {
          setData(payload.data);
          setError(null);
          hasLoaded = true;
        }
      } catch (loadError) {
        if (active && !hasLoaded) setError(loadError.message || "Unable to load total sales");
      }
    };

    loadSales();
    const intervalId = window.setInterval(loadSales, REFRESH_INTERVAL_MS);
    const eventStream = new EventSource(`${apiUrl("/api/events")}?token=${encodeURIComponent(token)}`);
    eventStream.addEventListener("data-change", loadSales);

    return () => {
      active = false;
      window.clearInterval(intervalId);
      eventStream.close();
    };
  }, [token]);

  const filteredProducts = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return data?.products || [];
    return (data?.products || []).filter((product) =>
      `${product.name || ""} ${product.category || ""}`.toLowerCase().includes(query)
    );
  }, [data?.products, search]);

  if (error && !data) {
    return (
      <div className="dashboard-shell total-sales-page">
        <button type="button" className="total-sales-back" onClick={onBack}>Back to dashboard</button>
        <section className="dashboard-card"><p className="error-message">{error}</p></section>
      </div>
    );
  }

  if (!data) {
    return <div className="dashboard-shell total-sales-page"><p>Loading total sales...</p></div>;
  }

  const summary = data.summary || {};

  return (
    <div className="dashboard-shell total-sales-page">
      <section className="total-sales-hero">
        <div>
          <button type="button" className="total-sales-back" onClick={onBack}>Back to dashboard</button>
          <span className="management-kicker">Sales intelligence</span>
          <h2>Total Sales</h2>
          <p>Sales are calculated as recorded sales plus deliveries, less recorded returns.</p>
        </div>
        <div className="total-sales-hero-total">
          <span>All-time sales</span>
          <strong>{formatCurrency(summary.all_time?.total)}</strong>
          <small>{formatCurrency(summary.all_time?.recorded_sales)} + {formatCurrency(summary.all_time?.delivery_total)} − {formatCurrency(summary.all_time?.return_total)}</small>
        </div>
      </section>

      <section className="total-sales-summary-grid" aria-label="Sales period totals">
        <article className="total-sales-summary-card is-daily">
          <span>Daily sales</span>
          <strong>{formatCurrency(summary.daily?.total)}</strong>
          <small>{formatDate(data.generated_for, { month: "long", day: "numeric", year: "numeric" })} · {summary.daily?.transactions || 0} transactions</small>
        </article>
        <article className="total-sales-summary-card is-weekly">
          <span>Weekly sales</span>
          <strong>{formatCurrency(summary.weekly?.total)}</strong>
          <small>{formatDate(summary.week_start, { month: "short", day: "numeric" })}–{formatDate(summary.week_end, { month: "short", day: "numeric" })} · {summary.weekly?.transactions || 0} transactions</small>
        </article>
        <article className="total-sales-summary-card is-monthly">
          <span>Total monthly sales</span>
          <strong>{formatCurrency(summary.monthly?.total)}</strong>
          <small>{formatDate(`${summary.month}-01`, { month: "long", year: "numeric" })} · {summary.monthly?.transactions || 0} transactions</small>
        </article>
        <article className="total-sales-summary-card is-items">
          <span>Returns deducted</span>
          <strong>-{formatCurrency(summary.all_time?.return_total)}</strong>
          <small>All-time recorded vendor returns</small>
        </article>
      </section>

      <section className="total-sales-chart-grid">
        <SalesBarChart
          title="Daily Sales"
          description="Last 14 operating days"
          rows={data.daily || []}
          labelFor={(row) => formatDate(row.period, { month: "short", day: "numeric" })}
        />
        <SalesBarChart
          title="Weekly Sales"
          description="Last 8 weeks, Monday to Sunday"
          rows={data.weekly || []}
          labelFor={(row) => formatDate(row.period, { month: "short", day: "numeric" })}
        />
        <SalesBarChart
          title="Monthly Sales"
          description="Last 12 months"
          rows={data.monthly || []}
          labelFor={(row) => formatDate(`${row.period}-01`, { month: "short" })}
        />
      </section>

      <section className="dashboard-card total-sales-products">
        <div className="total-sales-products-heading">
          <div>
            <span className="chart-kicker">Product performance</span>
            <h3>Product Sales</h3>
            <p>Product totals use recorded sales + deliveries − recorded returns.</p>
          </div>
          <label className="total-sales-search">
            <span>Search products</span>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name or category" />
          </label>
        </div>

        {filteredProducts.length === 0 ? (
          <div className="total-sales-empty">{search ? "No products match your search." : "No product sales activity is available yet."}</div>
        ) : (
          <div className="total-sales-product-list">
            {filteredProducts.map((product, index) => (
              <article className="total-sales-product-row" key={product.product_id}>
                <span className="total-sales-rank">#{index + 1}</span>
                <div className="total-sales-product-image"><ProductImage product={product} /></div>
                <div className="total-sales-product-name">
                  <strong>{product.name}</strong>
                  <span>{product.category || "General"}</span>
                </div>
                <div className="total-sales-product-stat is-net"><span>Net sales</span><strong>{formatCurrency(product.net_sales)}</strong></div>
                <div className="total-sales-product-stat"><span>Recorded sales</span><strong>{formatCurrency(product.recorded_sales)}</strong><small>{Number(product.recorded_quantity || 0).toLocaleString()} {product.unit || "units"}</small></div>
                <div className="total-sales-product-stat"><span>Deliveries</span><strong>{formatCurrency(product.delivery_total)}</strong><small>{Number(product.delivered_quantity || 0).toLocaleString()} {product.unit || "units"}</small></div>
                <div className="total-sales-product-stat is-return"><span>Returns</span><strong>-{formatCurrency(product.return_total)}</strong><small>{Number(product.returned_quantity || 0).toLocaleString()} {product.unit || "units"}</small></div>
                <div className="total-sales-share"><span>{Number(product.share_percent || 0).toFixed(1)}%</span><i><b style={{ width: `${Math.min(Number(product.share_percent || 0), 100)}%` }} /></i></div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export default TotalSales;
