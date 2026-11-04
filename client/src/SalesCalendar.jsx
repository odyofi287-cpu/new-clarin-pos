import { useEffect, useState } from "react";
import { apiUrl } from "./api";
import { formatReportValue, rangeError } from "./reportFormat";
import "./SalesCalendar.css";

const dateLabel = (value) => formatReportValue(value, "date");
const money = (value) => formatReportValue(value, "money");

export default function SalesCalendar({ calendar, token }) {
  const [mode, setMode] = useState("daily");
  const dailyRows = calendar?.daily || [];
  const monthlyRows = calendar?.monthly || [];
  const [selectedDate, setSelectedDate] = useState("");
  const [selectedMonth, setSelectedMonth] = useState("");
  const [draftRange, setDraftRange] = useState({ start_date: "", end_date: "" });
  const [appliedRange, setAppliedRange] = useState(null);
  const [rangeData, setRangeData] = useState(null);
  const [loadingRange, setLoadingRange] = useState(false);
  const [formError, setFormError] = useState("");
  const [loadError, setLoadError] = useState("");
  const rows = mode === "daily" ? dailyRows : monthlyRows;
  const selectedPeriod = mode === "daily" ? selectedDate : selectedMonth;
  const selectedRow = rows.find((row) => row.period === selectedPeriod) || null;
  const firstPeriod = rows[0]?.period || "";
  const lastPeriod = rows[rows.length - 1]?.period || "";

  useEffect(() => {
    setSelectedDate((current) => dailyRows.some((row) => row.period === current) ? current : dailyRows.at(-1)?.period || "");
    setSelectedMonth((current) => monthlyRows.some((row) => row.period === current) ? current : monthlyRows.at(-1)?.period || "");
    setDraftRange((current) => ({
      start_date: current.start_date || dailyRows[0]?.period || "",
      end_date: current.end_date || dailyRows.at(-1)?.period || "",
    }));
  }, [dailyRows, monthlyRows]);

  useEffect(() => {
    if (mode !== "range" || !appliedRange || !token) return undefined;
    let active = true;
    let inFlight = false;
    const controller = new AbortController();
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const query = new URLSearchParams(appliedRange);
        const response = await fetch(apiUrl(`/api/dashboard/sales-calendar?${query}`), {
          headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
        });
        const body = await response.json();
        if (!response.ok || !body.data) throw new Error(body.error || "Unable to load sales for this date range.");
        if (active) { setRangeData(body.data); setLoadError(""); }
      } catch (error) {
        if (active && error.name !== "AbortError") setLoadError(error.message || "Unable to load the date range. Try again.");
      } finally {
        inFlight = false;
        if (active) setLoadingRange(false);
      }
    };
    setLoadingRange(true);
    setLoadError("");
    load();
    const interval = window.setInterval(load, 6000);
    window.addEventListener("productsUpdated", load);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener("productsUpdated", load);
    };
  }, [mode, appliedRange, token]);

  const applyRange = (event) => {
    event.preventDefault();
    const error = rangeError(draftRange);
    setFormError(error);
    if (error) return;
    setRangeData(null);
    setAppliedRange({ ...draftRange });
  };
  const periodLabel = (period) => mode === "daily" ? dateLabel(period)
    : new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${period}-01T00:00:00Z`));
  const matchingRange = rangeData && rangeData.start_date === appliedRange?.start_date && rangeData.end_date === appliedRange?.end_date ? rangeData : null;
  const detail = mode === "range" ? matchingRange : selectedRow;
  const detailLabel = mode === "range" && detail ? `${dateLabel(detail.start_date)} – ${dateLabel(detail.end_date)}` : detail ? periodLabel(detail.period) : "";
  const draftChanged = appliedRange && (draftRange.start_date !== appliedRange.start_date || draftRange.end_date !== appliedRange.end_date);

  return (
    <section className="sales-calendar-card">
      <div className="sales-calendar-heading">
        <div><span className="chart-kicker">Sales recorder</span><h3>Sales Calendar</h3><p>Compare recorded and net sales by period.</p></div>
        <div className="sales-calendar-tabs" role="group" aria-label="Sales calendar period">
          {[{ id: "daily", label: "Daily" }, { id: "monthly", label: "Monthly" }, { id: "range", label: "Date range" }].map((tab) => (
            <button type="button" key={tab.id} className={mode === tab.id ? "active" : ""} aria-pressed={mode === tab.id} onClick={() => setMode(tab.id)}>{tab.label}</button>
          ))}
        </div>
      </div>
      {mode === "range" ? (
        <form className="sales-calendar-range-form" onSubmit={applyRange} noValidate>
          <div className="sales-calendar-picker sales-calendar-range-picker">
            <label>Start date<input type="date" value={draftRange.start_date} onChange={(event) => { setDraftRange({ ...draftRange, start_date: event.target.value }); setFormError(""); }} required /></label>
            <span className="sales-calendar-range-separator" aria-hidden="true">to</span>
            <label>End date<input type="date" value={draftRange.end_date} onChange={(event) => { setDraftRange({ ...draftRange, end_date: event.target.value }); setFormError(""); }} required /></label>
            <button type="submit" className="primary-button sales-calendar-apply">Apply range</button>
          </div>
          <p className="sales-calendar-range-note">Both selected dates are included. Recorded sales + deliveries − returns.</p>
          {formError && <p className="sales-calendar-range-error" role="alert">{formError}</p>}
          {loadError && <p className="sales-calendar-range-error" role="alert">{loadError} Click Apply range to retry.</p>}
          {draftChanged && detail && <p className="sales-calendar-range-note">Dates changed. Click Apply range to update the totals shown below.</p>}
        </form>
      ) : (
        <div className="sales-calendar-picker">
          <label>{mode === "daily" ? "Choose a date" : "Choose a month"}
            <input type={mode === "daily" ? "date" : "month"} value={selectedPeriod} min={firstPeriod} max={lastPeriod} onChange={(event) => mode === "daily" ? setSelectedDate(event.target.value) : setSelectedMonth(event.target.value)} />
          </label>
          <span>{selectedRow ? periodLabel(selectedRow.period) : "Choose an available period"}</span>
        </div>
      )}
      {mode === "range" && loadingRange && !detail ? <p className="sales-calendar-empty" role="status">Loading sales for your selected dates…</p> : detail ? (
        <div className="sales-period-detail" aria-busy={mode === "range" && loadingRange}>
          <div className="sales-period-title"><span>{mode === "range" ? "Date range sales" : mode === "daily" ? "Daily sales" : "Monthly sales"}</span><strong>{detailLabel}</strong></div>
          <div className="sales-period-metrics">
            <div><span>Recorded sales</span><strong>{money(detail.recorded_sales)}</strong></div>
            <div><span>Deliveries</span><strong>{money(detail.vendor_deliveries)}</strong></div>
            <div><span>Vendor returns</span><strong className="returns-value">-{money(detail.vendor_returns)}</strong></div>
            <div className="net"><span>Net sales</span><strong>{money(detail.net_sales)}</strong></div>
          </div>
        </div>
      ) : <p className="sales-calendar-empty">{mode === "range" ? "Choose your start and end dates, then click Apply range to view sales for that period." : "Choose a date from the last 31 days or a month from the last 12 months to view its sales."}</p>}
    </section>
  );
}
