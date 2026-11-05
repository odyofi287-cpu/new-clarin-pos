import { useEffect, useMemo, useState } from "react";
import { apiUrl } from "./api";
import { manilaToday, rangeError, formatReportValue } from "./reportFormat";
import { formatItemQuantity } from "./productQuantity";
import AnalyticsNavigation from "./AnalyticsNavigation";
import ProfitAccountBreakdown from "./ProfitAccountBreakdown";
import "./profits.css";

const cash = (value) => formatReportValue(value, "money");
const date = (value) => formatReportValue(value, "date");
function ProductImage({ product }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [product.image_url]);
  return product.image_url && !failed ? <img src={product.image_url} alt={product.name} onError={() => setFailed(true)} /> : <span className="total-sales-product-fallback" aria-hidden="true">{product.name.slice(0, 1)}</span>;
}

export default function Profits({ token, role, onBack }) {
  const today = manilaToday();
  const [range, setRange] = useState({ start_date: `${today.slice(0, 4)}-01-01`, end_date: today });
  const [draft, setDraft] = useState(range);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [validation, setValidation] = useState("");
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [period, setPeriod] = useState("daily");
  const [section, setSection] = useState(role === "ADMIN" ? "accounts" : "products");
  const allTime = range.scope === "all-time";

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
    if (next.scope === "all-time") {
      setValidation(""); setRange({ scope: "all-time" }); setPeriod("all_time"); return;
    }
    const message = rangeError(next);
    setValidation(message);
    if (!message) { setDraft(next); setRange(next); setPeriod((current) => current === "all_time" ? "daily" : current); }
  };
  const summary = data?.summary;
  const rangeSummary = summary?.range || {};

  return <div className="dashboard-shell total-sales-page profits-page">
    <section className="total-sales-hero">
      <div><button type="button" className="total-sales-back" onClick={onBack}>Back to dashboard</button><span className="management-kicker">Capital & profit</span><h2>{data?.sales_scope === "own" ? "My Profits" : "Profits"}</h2><p>{data?.sales_scope === "own" ? "Your account only: capital and profit from your recorded sales and deliveries, less returns against your deliveries." : "Capital and profit across all accounts' recorded sales, deliveries, and returns."}</p></div>
      <div className="total-sales-hero-total"><span>{data?.period_scope === "all-time" ? "All-time profit" : "Selected range profit"}</span><strong>{data ? cash(rangeSummary.gross_profit) : "—"}</strong><small>{data ? `${date(data.start_date)} – ${date(data.end_date)}` : "Loading profit data…"}</small></div>
    </section>
    <section className="dashboard-card profit-range-card">
      <div className="profit-range-heading"><div><span className="chart-kicker">Calendar range</span><h3>Choose a reporting period</h3></div><div className="profit-shortcuts">{[
        ["Today", today, today], ["This month", `${today.slice(0, 7)}-01`, today], ["This year", `${today.slice(0, 4)}-01-01`, today],
      ].map(([label, start, end]) => <button className="small-button" type="button" key={label} onClick={() => applyRange({ start_date: start, end_date: end })}>{label}</button>)}<button className="small-button" type="button" aria-pressed={allTime} onClick={() => applyRange({ scope: "all-time" })}>All time</button></div></div>
      {allTime ? <div className="profit-all-time"><p>All account-authorized activity from the first transaction through the latest reporting date.</p><button type="button" className="small-button" onClick={() => applyRange(draft)}>Choose date range</button></div> : <form className="profit-range-form" onSubmit={(event) => { event.preventDefault(); applyRange(draft); }}>
        <label>From date<input type="date" required value={draft.start_date} onChange={(event) => setDraft({ ...draft, start_date: event.target.value })} /></label>
        <label>To date<input type="date" required value={draft.end_date} onChange={(event) => setDraft({ ...draft, end_date: event.target.value })} /></label>
        <button type="submit" className="primary-button">Apply range</button>
      </form>}
      {validation && <p className="error-message" role="alert">{validation}</p>}
      {error && <p className="error-message" role="alert">{error}{data ? " Previously loaded figures are shown." : ""}</p>}
      {loading && <p className="profit-help" role="status">Updating profit figures…</p>}
      <p className="profit-help">Capital is each product's saved base price × its quantity sold or delivered, less returned-item costs. Both dates are included. Historical costs stay unchanged after later price edits. Unsold stock is not counted here. This shows transaction value, not collected cash; unpaid deliveries are included and operating expenses are not deducted.</p>
    </section>
    {data && <>
      <section className="profit-cashflow" aria-label="Sales minus capital equals profit">
        <article><span>{rangeSummary.missing_cost_items > 0 ? "Sales" : "Net sales value"}</span><strong>{cash(rangeSummary.known_revenue)}</strong><small>Recorded sales + deliveries − returns</small></article>
        <span className="profit-equation-symbol" aria-hidden="true">−</span>
        <article className="is-capital"><span>Capital</span><strong>{cash(rangeSummary.capital)}</strong><small>Base cost of net sold / delivered items</small></article>
        <span className="profit-equation-symbol" aria-hidden="true">=</span>
        <article className="is-profit"><span>Gross profit</span><strong className={rangeSummary.gross_profit < 0 ? "profit-negative" : "profit-positive"}>{cash(rangeSummary.gross_profit)}</strong><small>{data.period_scope === "all-time" ? "All-time activity" : "Applied calendar range"}</small></article>
      </section>
      <section className="total-sales-summary-grid profit-capital-periods" aria-label="Capital and profit period totals">
        {[["Today's capital", summary.daily, date(data.generated_for), "is-daily"], ["Monthly capital", summary.monthly, data.generated_for.slice(0, 7), "is-monthly"], ["Yearly capital", summary.yearly, data.generated_for.slice(0, 4), "is-weekly"], ["All-time capital", summary.all_time, "All recorded activity", "is-items"]].map(([label, values, caption, tone]) => <article className={`total-sales-summary-card ${tone}`} key={label}><span>{label}</span><strong>{cash(values.capital)}</strong><div className="profit-period-pair"><span>Profit</span><b className={values.gross_profit < 0 ? "profit-negative" : "profit-positive"}>{cash(values.gross_profit)}</b></div><small>{caption}{values.missing_cost_items > 0 ? ` · ${values.missing_cost_items} Items missing cost` : ""}</small></article>)}
      </section>
      {rangeSummary.reconstructed_cost_items > 0 && <aside className="profit-cost-completed" role="note"><strong>Historical costs completed</strong><p>Costs for {rangeSummary.reconstructed_cost_items} Item entries were filled from saved delivery costs or a one-time product base-price reference. {rangeSummary.estimated_cost_items > 0 ? `${rangeSummary.estimated_cost_items} of these Item entries use estimated costs, not verified historical purchase costs. ` : ""}Original sale prices and transaction amounts are unchanged.</p></aside>}
      {rangeSummary.missing_cost_lines > 0 && <aside className="profit-coverage" role="note"><strong>Base price still needed</strong><p>{rangeSummary.missing_cost_items} Items across {rangeSummary.missing_cost_lines} transaction lines still have no usable base cost and are excluded from profit. Enter the product's base price in Products to complete its missing historical costs. Selling price alone is not a purchase cost.</p></aside>}
      <details className="profit-source-details"><summary>Sales, deliveries & returns<span>Expand calculation details</span></summary>
      <section className="profit-breakdown" aria-label="Capital and profit by source">
        <div><span>Recorded sales profit</span><strong>{cash(rangeSummary.recorded_profit)}</strong><small>Capital {cash(rangeSummary.recorded_capital)} · {formatItemQuantity(rangeSummary.recorded_quantity)}</small></div><div><span>Delivery profit</span><strong>{cash(rangeSummary.delivery_profit)}</strong><small>Capital {cash(rangeSummary.delivery_capital)} · {formatItemQuantity(rangeSummary.delivered_quantity)}</small></div><div><span>Return margin adjustment</span><strong>{cash(rangeSummary.return_profit)}</strong><small>Capital reversal {cash(rangeSummary.return_capital)} · {formatItemQuantity(rangeSummary.returned_quantity)}</small></div>
      </section>
      </details>
      <AnalyticsNavigation prefix="profit-analysis" value={section} onChange={setSection} sections={[
        ...(role === "ADMIN" && data.sales_scope === "all" ? [{ id: "accounts", label: "Accounts" }] : []),
        { id: "history", label: "History" }, { id: "products", label: "Products" },
      ]} />
      {role === "ADMIN" && data.sales_scope === "all" && <div id="profit-analysis-accounts" className="analytics-panel" hidden={section !== "accounts"}><ProfitAccountBreakdown data={data.account_breakdown} /></div>}
      <div id="profit-analysis-history" className="analytics-panel" hidden={section !== "history"}>
      <section className="dashboard-card profit-period-card">
        <div className="profit-range-heading"><div><span className="chart-kicker">Period performance</span><h3>Capital & profit history</h3><p className="profit-help">Daily, monthly, and yearly views group the applied range. All time includes your entire authorized history. Only dates with activity are listed.</p></div><div className="profit-tabs" role="group" aria-label="Profit grouping">{["daily", "monthly", "yearly", "all_time"].map((value) => <button type="button" aria-pressed={period === value} className={period === value ? "is-active" : ""} key={value} onClick={() => value === "all_time" ? applyRange({ scope: "all-time" }) : setPeriod(value)}>{value === "all_time" ? "All time" : value[0].toUpperCase() + value.slice(1)}</button>)}</div></div>
        <div className="profit-table-wrap"><table className="profit-table"><thead><tr><th>Period</th><th>Net items</th><th>Sales</th><th>Capital</th><th>Gross profit</th></tr></thead><tbody>{(data[period] || []).map((row) => <tr key={row.period}><th scope="row">{period === "daily" ? date(row.period) : row.period}{row.missing_cost_items > 0 && <small>{row.missing_cost_items} Items missing cost</small>}</th><td data-label="Net items">{formatItemQuantity(row.net_quantity)}</td><td data-label="Sales">{cash(row.known_revenue)}</td><td data-label="Capital">{cash(row.capital)}</td><td data-label="Gross profit" className={row.gross_profit < 0 ? "profit-negative" : "profit-positive"}>{cash(row.gross_profit)}</td></tr>)}</tbody></table></div>
        {!data[period]?.length && <p className="total-sales-empty">No transactions in this date range.</p>}
      </section>
      </div>
      <div id="profit-analysis-products" className="analytics-panel" hidden={section !== "products"}>
      <section className="dashboard-card total-sales-products">
        <div className="total-sales-products-heading"><div><span className="chart-kicker">Product performance</span><h3>Product Capital & Profit</h3><p className="profit-help">Capital is summed per product using historical base prices and net item quantities, including products removed from the catalog.</p></div><label className="total-sales-search"><span>Search products</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name or category" /></label></div>
        <div className="profit-product-list">{products.map((product) => <article className="profit-product-row" key={product.product_id}>
          <div className="total-sales-product-image"><ProductImage product={product} /></div><div className="profit-product-name"><strong>{product.name}</strong><span>{product.category || "General"}{product.volume_ml ? ` · ${Number(product.volume_ml)} mL` : ""}</span><small>{product.recorded_quantity} sold · {product.delivered_quantity} delivered · {product.returned_quantity} returned</small>{product.missing_cost_items > 0 && <small>{product.missing_cost_items} Items missing cost</small>}{product.estimated_cost_items > 0 && <small className="profit-estimate-note">{product.estimated_cost_items} Item entries use estimated cost</small>}</div>
          <div><span>Sales</span><strong>{cash(product.known_revenue)}</strong></div><div className="profit-product-capital"><span>Product capital</span><strong>{cash(product.capital)}</strong><small>{formatItemQuantity(product.net_quantity)} net</small></div><div><span>Gross profit</span><strong className={product.gross_profit < 0 ? "profit-negative" : "profit-positive"}>{cash(product.gross_profit)}</strong></div>
        </article>)}</div>{!products.length && <p className="total-sales-empty">{search ? "No products match your search." : "No product activity in this range."}</p>}
      </section>
      </div>
    </>}
  </div>;
}
