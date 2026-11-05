import { useState } from "react";
import { formatReportValue } from "./reportFormat";
import "./profitAccounts.css";

const cash = (value) => formatReportValue(value, "money");
const date = (value) => formatReportValue(value, "date");

export default function ProfitAccountBreakdown({ data }) {
  const [search, setSearch] = useState("");
  if (!data) return null;
  const accounts = data.accounts.filter((account) => `${account.name} ${account.username || ""} ${account.role}`.toLowerCase().includes(search.toLowerCase().trim()));
  const hasRounding = Object.values(data.rounding_difference).some((amount) => amount !== 0);
  return <section className="dashboard-card profit-account-breakdown" aria-label="Account profit breakdown">
    <header className="profit-accounts-heading"><div><span className="chart-kicker">Account performance</span><h3>Profit by Account</h3><p>The reporting period above applies to every account below. Expand an account to review its sales, delivery profit, and return deductions.</p></div><span className="profit-accounts-count">{data.accounts.length} accounts</span></header>
    <div className="profit-accounts-context"><strong>{date(data.start_date)}{data.start_date !== data.end_date ? ` – ${date(data.end_date)}` : ""}</strong><span>Combined profit <b>{cash(data.totals.gross_profit)}</b></span></div>
    <label className="profit-accounts-search">Search accounts<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, username, or role" /></label>
    <div className="profit-accounts-list">{accounts.map((account) => <details className={`profit-account-row ${account.user_id == null ? "is-unattributed" : ""}`} data-account-id={account.user_id ?? "unattributed"} key={account.user_id ?? "unattributed"}>
      <summary>
        <span className="profit-account-avatar" aria-hidden="true">{account.user_id == null ? "?" : account.name.slice(0, 1).toUpperCase()}</span>
        <span className="profit-account-identity"><strong>{account.name}</strong>{account.username && <span>@{account.username}</span>}<small>{["ADMIN", "STAFF"].includes(account.role) ? (account.role === "ADMIN" ? "Admin" : "Staff") : account.user_id == null ? "Unlinked legacy activity" : "Retained account activity"}{account.user_id != null && !account.active ? " · Inactive" : ""}</small></span>
        <span className="profit-account-capital"><small>Capital</small><strong>{cash(account.capital)}</strong></span>
        <span className="profit-account-total"><small>Gross profit</small><strong className={account.gross_profit < 0 ? "profit-negative" : "profit-positive"}>{cash(account.gross_profit)}</strong></span>
        <span className="profit-account-chevron" aria-hidden="true">⌄</span>
      </summary>
      <div className="profit-account-expanded">
        <p className="profit-account-sales">Sales <strong>{cash(account.known_revenue)}</strong><span>{account.net_quantity} net Items</span></p>
        <div className="profit-account-sources">{[["Recorded sales profit", "recorded_profit"], ["Delivery profit", "delivery_profit"], ["Return margin adjustment", "return_profit"]].map(([label, key]) => <div key={key}><span>{label}</span><strong className={account[key] < 0 ? "profit-negative" : ""}>{cash(account[key])}</strong></div>)}</div>
        {account.missing_cost_items > 0 && <p className="profit-account-warning">{account.missing_cost_items} Items have no usable base cost and are excluded from capital and profit.</p>}
        {account.estimated_cost_items > 0 && <p className="profit-account-warning">{account.estimated_cost_items} Item entries use estimated historical costs.</p>}
      </div>
    </details>)}</div>
    {!accounts.length && <p className="total-sales-empty">{search ? "No accounts match your search." : "No accounts are available for this period."}</p>}
    <p className="profit-accounts-note">Returns reverse the original delivery owner's capital and profit, not the return clerk's. Active Admin and Staff accounts with no activity remain visible. Retained and unattributed activity stays separate. Search only filters this list, not the combined totals.</p>
    {hasRounding && <p className="profit-accounts-note">Account figures are rounded individually to centavos; small rounding differences can occur against the combined total.</p>}
  </section>;
}
