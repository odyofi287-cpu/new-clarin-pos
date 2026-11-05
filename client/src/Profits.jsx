import { useEffect, useMemo, useState } from "react";
import { apiUrl } from "./api";
import { manilaToday, rangeError, formatReportValue } from "./reportFormat";
import "./profits.css";

const cash = (value) => formatReportValue(value, "money");
const date = (value) => formatReportValue(value, "date");
function ProductImage({ product }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [product.image_url]);
  return product.image_url && !failed ? <img src={product.image_url} alt={product.name} onError={() => setFailed(true)} /> : <span className="total-sales-product-fallback" aria-hidden="true">{product.name.slice(0, 1)}</span>;
}

export default function Profits({ token, onBack }) {
  const today = manilaToday();
  const [range, setRange] = useState({ start_date: `${today.slice(0, 4)}-01-01`, end_date: today });
  const [draft, setDraft] = useState(range);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [validation, setValidation] = useState("");
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [period, setPeriod] = useState("daily");

  useEffect(() => {
    let active = true;
    let controller;
    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      const request = controller;
      try {
        const response = await fetch(apiUrl(`/api/dashboard/profits?${new URLSearchParams(range)}`), { headers: { Authorization: `Bearer ${token}` }, signal: request.signal, cache: "no-store" });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Unable to load profits");
        if (active && !request.signal.aborted) { setData(payload.data); setError(""); }
      } catch (failure) { if (active && failure.name !== "AbortError") setError(failure.message); }
      finally { if (active && !request.signal.aborted) setLoading(false); }
    };
    setLoading(true);
    load();
    const interval = window.setInterval(load, 6000);
    window.addEventListener("productsUpdated", load);
    return () => { active = false; controller?.abort(); window.clearInterval(interval); window.removeEventListener("productsUpdated", load); };
  }, [token, range]);

  const products = useMemo(() => (data?.products || []).filter((product) => `${product.name} ${product.category || ""}`.toLowerCase().includes(search.toLowerCase().trim())), [data, search]);
  const applyRange = (next) => {
    const message = rangeError(next);
    setValidation(message);
    if (!message) { setDraft(next); setRange(next); }
  };
  const summary = data?.summary;
  const rangeSummary = summary?.range || {};

  return <div className="dashboard-shell total-sales-page profits-page">
    <section className="total-sales-hero">
      <div><button type="button" className="total-sales-back" onClick={onBack}>Back to dashboard</button><span className="management-kicker">Profit intelligence</span><h2>{data?.sales_scope === "own" ? "My Profits" : "Profits"}</h2><p>{data?.sales_scope === "own" ? "Your account only: gross profit from your recorded sales and deliveries, less returns against your deliveries." : "Gross profit from recorded sales and deliveries, less the margin reversed by returns."}</p></div>
      <div className="total-sales-hero-total"><span>Selected range profit</span><strong>{data ? cash(rangeSummary.gross_profit) : "—"}</strong><small>{data ? `${date(data.start_date)} – ${date(data.end_date)}` : "Loading profit data…"}</small></div>
    </section>
    <section className="dashboard-card profit-range-card">
      <div className="profit-range-heading"><div><span className="chart-kicker">Calendar range</span><h3>Choose a reporting period</h3></div><div className="profit-shortcuts">{[
        ["Today", today, today], ["This month", `${today.slice(0, 7)}-01`, today], ["This year", `${today.slice(0, 4)}-01-01`, today],
      ].map(([label, start, end]) => <button className="small-button" type="button" key={label} onClick={() => applyRange({ start_date: start, end_date: end })}>{label}</button>)}</div></div>
      <form className="profit-range-form" onSubmit={(event) => { event.preventDefault(); applyRange(draft); }}>
        <label>From date<input type="date" required value={draft.start_date} onChange={(event) => setDraft({ ...draft, start_date: event.target.value })} /></label>
        <label>To date<input type="date" required value={draft.end_date} onChange={(event) => setDraft({ ...draft, end_date: event.target.value })} /></label>
        <button type="submit" className="primary-button">Apply range</button>
      </form>
      {validation && <p className="error-message" role="alert">{validation}</p>}
      {error && <p className="error-message" role="alert">{error}{data ? " Previously loaded figures are shown." : ""}</p>}
      {loading && <p className="profit-help" role="status">Updating profit figures…</p>}
      <p className="profit-help">Both dates are included. Missing historical costs use a one-time saved product base price, or the original delivery cost when available. Later price changes apply to new transactions; saved historical costs stay unchanged. Operating expenses are not deducted.</p>
    </section>
    {data && <>
      <section className="total-sales-summary-grid" aria-label="Profit period totals">
        {[["Today's profit", summary.daily, date(data.generated_for), "is-daily"], ["Monthly profit", summary.monthly, data.generated_for.slice(0, 7), "is-monthly"], ["Yearly profit", summary.yearly, data.generated_for.slice(0, 4), "is-weekly"], ["Range profit", rangeSummary, "Applied calendar range", "is-items"]].map(([label, values, caption, tone]) => <article className={`total-sales-summary-card ${tone}`} key={label}><span>{label}</span><strong className={values.gross_profit < 0 ? "profit-negative" : ""}>{cash(values.gross_profit)}</strong><small>{caption}{values.missing_cost_items > 0 ? ` · ${values.missing_cost_items} Items missing cost` : ""}</small></article>)}
      </section>
      {rangeSummary.reconstructed_cost_items > 0 && <aside className="profit-cost-completed" role="note"><strong>Historical costs completed</strong><p>Costs for {rangeSummary.reconstructed_cost_items} Item entries were filled from saved delivery costs or a one-time product base-price reference. {rangeSummary.estimated_cost_items > 0 ? `${rangeSummary.estimated_cost_items} of these Item entries use estimated costs, not verified historical purchase costs. ` : ""}Original sale prices and transaction amounts are unchanged.</p></aside>}
      {rangeSummary.missing_cost_lines > 0 && <aside className="profit-coverage" role="note"><strong>Base price still needed</strong><p>{rangeSummary.missing_cost_items} Items across {rangeSummary.missing_cost_lines} transaction lines still have no usable base cost and are excluded from profit. Enter the product's base price in Products to complete its missing historical costs. Selling price alone is not a purchase cost.</p></aside>}
      <section className="profit-breakdown" aria-label="Range profit calculation">
        <div><span>Recorded sales profit</span><strong>{cash(rangeSummary.recorded_profit)}</strong></div><div><span>Delivery profit</span><strong>{cash(rangeSummary.delivery_profit)}</strong></div><div><span>Return margin adjustment</span><strong>{cash(rangeSummary.return_profit)}</strong></div>
      </section>
      <section className="dashboard-card profit-period-card">
        <div className="profit-range-heading"><div><span className="chart-kicker">Period performance</span><h3>Profit over time</h3><p className="profit-help">Grouped within the applied date range. Only dates with transaction activity are listed.</p></div><div className="profit-tabs" role="group" aria-label="Profit grouping">{["daily", "monthly", "yearly"].map((value) => <button type="button" aria-pressed={period === value} className={period === value ? "is-active" : ""} key={value} onClick={() => setPeriod(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}</div></div>
        <div className="profit-table-wrap"><table className="profit-table"><thead><tr><th>Period</th><th>Sales with cost</th><th>Base cost</th><th>Gross profit</th></tr></thead><tbody>{(data[period] || []).map((row) => <tr key={row.period}><th scope="row">{period === "daily" ? date(row.period) : row.period}{row.missing_cost_items > 0 && <small>{row.missing_cost_items} Items missing cost</small>}</th><td data-label="Sales with cost">{cash(row.known_revenue)}</td><td data-label="Base cost">{cash(row.base_cost)}</td><td data-label="Gross profit" className={row.gross_profit < 0 ? "profit-negative" : "profit-positive"}>{cash(row.gross_profit)}</td></tr>)}</tbody></table></div>
        {!data[period]?.length && <p className="total-sales-empty">No transactions in this date range.</p>}
      </section>
      <section className="dashboard-card total-sales-products">
        <div className="total-sales-products-heading"><div><span className="chart-kicker">Product performance</span><h3>Product Profits</h3><p className="profit-help">Saved transaction prices and costs, including products removed from the catalog.</p></div><label className="total-sales-search"><span>Search products</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name or category" /></label></div>
        <div className="profit-product-list">{products.map((product) => <article className="profit-product-row" key={product.product_id}>
          <div className="total-sales-product-image"><ProductImage product={product} /></div><div className="profit-product-name"><strong>{product.name}</strong><span>{product.category || "General"}{product.volume_ml ? ` · ${Number(product.volume_ml)} mL` : ""}</span>{product.missing_cost_items > 0 && <small>{product.missing_cost_items} Items missing cost</small>}{product.estimated_cost_items > 0 && <small className="profit-estimate-note">{product.estimated_cost_items} Item entries use estimated cost</small>}</div>
          <div><span>Sales with cost</span><strong>{cash(product.known_revenue)}</strong></div><div><span>Base cost</span><strong>{cash(product.base_cost)}</strong></div><div><span>Gross profit</span><strong className={product.gross_profit < 0 ? "profit-negative" : "profit-positive"}>{cash(product.gross_profit)}</strong></div>
        </article>)}</div>{!products.length && <p className="total-sales-empty">{search ? "No products match your search." : "No product activity in this range."}</p>}
      </section>
    </>}
  </div>;
}
