import { useEffect, useMemo, useState } from "react";
import { apiUrl } from "./api";
import { formatReportValue, manilaToday } from "./reportFormat";
import { salesPeriodRange, switchSalesPeriod } from "./salesPeriods";
import "./accountSales.css";

const cash = (value) => formatReportValue(value, "money");
const date = (value) => formatReportValue(value, "date");

export default function SalesAccountBreakdown({ token }) {
  const [selection, setSelection] = useState({ mode: "daily", value: manilaToday() });
  const [draft, setDraft] = useState(selection.value);
  const [validation, setValidation] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const range = useMemo(() => salesPeriodRange(selection.mode, selection.value), [selection]);

  useEffect(() => {
    let active = true;
    let controller;
    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      const request = controller;
      try {
        const response = await fetch(apiUrl(`/api/dashboard/account-sales?${new URLSearchParams(range)}`), { headers: { Authorization: `Bearer ${token}` }, signal: request.signal, cache: "no-store" });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Unable to load account sales");
        if (active && !request.signal.aborted) { setData(payload.data); setError(""); }
      } catch (failure) { if (active && failure.name !== "AbortError") setError(failure.message); }
      finally { if (active && !request.signal.aborted) setLoading(false); }
    };
    setLoading(true);
    load();
    const interval = window.setInterval(load, 6000);
    window.addEventListener("productsUpdated", load);
    window.addEventListener("vendorsUpdated", load);
    return () => { active = false; controller?.abort(); window.clearInterval(interval); window.removeEventListener("productsUpdated", load); window.removeEventListener("vendorsUpdated", load); };
  }, [range, token]);

  const accounts = (data?.accounts || []).filter((account) => `${account.name} ${account.username || ""} ${account.role}`.toLowerCase().includes(search.toLowerCase().trim()));
  const setMode = (mode) => {
    const next = switchSalesPeriod(selection, mode);
    setSelection(next); setDraft(next.value); setValidation("");
  };
  const applyPeriod = (event) => {
    event.preventDefault();
    try { salesPeriodRange(selection.mode, draft); setSelection({ mode: selection.mode, value: draft }); setValidation(""); }
    catch (failure) { setValidation(failure.message); }
  };

  return <section className="dashboard-card sales-account-breakdown" aria-label="Account sales breakdown">
    <header className="account-sales-heading">
      <div><span className="chart-kicker">Account performance</span><h3>Sales by Account</h3><p>Recorded sales + deliveries − returns, attributed to the account responsible for each transaction.</p></div>
      <div className="account-sales-tabs" role="group" aria-label="Account sales view">{["daily", "monthly", "yearly"].map((mode) => <button type="button" key={mode} aria-pressed={selection.mode === mode} className={selection.mode === mode ? "is-active" : ""} onClick={() => setMode(mode)}>{mode[0].toUpperCase() + mode.slice(1)}</button>)}</div>
    </header>
    <form className="account-sales-period-form" onSubmit={applyPeriod}>
      <label>{selection.mode === "daily" ? "Sales date" : selection.mode === "monthly" ? "Sales month" : "Sales year"}
        <input type={selection.mode === "daily" ? "date" : selection.mode === "monthly" ? "month" : "number"} min={selection.mode === "yearly" ? "1" : undefined} max={selection.mode === "yearly" ? "9999" : undefined} step={selection.mode === "yearly" ? "1" : undefined} value={draft} onChange={(event) => setDraft(event.target.value)} required />
      </label><button type="submit" className="primary-button">Apply period</button>
    </form>
    {validation && <p className="error-message" role="alert">{validation}</p>}
    {error && <p className="error-message" role="alert">{error}{data ? " Previously loaded figures are shown." : ""}</p>}
    {loading && <p className="account-sales-note" role="status">Updating account sales…</p>}
    {data && <>
      <div className="account-sales-applied"><strong>{date(data.start_date)}{data.start_date !== data.end_date ? ` – ${date(data.end_date)}` : ""}</strong><span>Period totals · all accounts</span></div>
      <div className="account-sales-summary" aria-label="Account sales period totals">
        {[["Recorded sales", "recorded_sales"], ["Deliveries", "delivery_total"], ["Returns deducted", "return_total"], ["Net sales", "net_sales"]].map(([label, key]) => <div key={key} className={key === "net_sales" ? "is-net" : ""}><span>{label}</span><strong>{key === "return_total" ? "−" : ""}{cash(data.totals[key])}</strong></div>)}
      </div>
      <div className="account-sales-search-row"><label>Search accounts<input type="search" placeholder="Name or username" value={search} onChange={(event) => setSearch(event.target.value)} /></label><span>{accounts.length} account{accounts.length === 1 ? "" : "s"}{search ? " match your search" : " in this breakdown"}</span></div>
      <div className="account-sales-list">{accounts.map((account) => <article className={`account-sales-row ${account.user_id == null ? "is-unattributed" : ""}`} key={account.user_id ?? "unattributed"}>
        <span className="account-sales-avatar" aria-hidden="true">{account.user_id == null ? "?" : account.name.slice(0, 1).toUpperCase()}</span>
        <div className="account-sales-identity"><h4>{account.name}</h4>{account.username && <span>@{account.username}</span>}<small>{["ADMIN", "STAFF"].includes(account.role) ? (account.role === "ADMIN" ? "Admin" : "Staff") : account.user_id == null ? "Unlinked legacy adjustments" : "Retained account activity"}{account.user_id != null && !account.active ? " · Inactive" : ""}</small></div>
        <div className="account-sales-net"><span>Net sales</span><strong className={account.net_sales < 0 ? "is-negative" : ""}>{cash(account.net_sales)}</strong><small>{account.transaction_count} transaction{account.transaction_count === 1 ? "" : "s"}</small></div>
        <div className="account-sales-details">
          <div><span>Recorded sales <small>{account.sale_count} sale{account.sale_count === 1 ? "" : "s"}</small></span><strong>{cash(account.recorded_sales)}</strong></div>
          <div><span>Deliveries <small>{account.delivery_count} delivery record{account.delivery_count === 1 ? "" : "s"}</small></span><strong>{cash(account.delivery_total)}</strong></div>
          <div><span>Returns <small>{account.return_count} return batch{account.return_count === 1 ? "" : "es"}</small></span><strong>−{cash(account.return_total)}</strong></div>
        </div>
      </article>)}</div>
      {!accounts.length && <p className="total-sales-empty">{search ? "No accounts match your search." : "No account activity is available for this period."}</p>}
    </>}
    <p className="account-sales-note">Returns deduct from the account that recorded the original delivery, even when a different user records the return. Unlinked legacy returns are listed separately. Active Admin and Staff accounts with no activity remain visible; search only narrows the account list.</p>
  </section>;
}
