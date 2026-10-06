import { useEffect, useState } from "react";
import { apiUrl } from "./api";
import { manilaToday, rangeError, formatReportValue, downloadReportBlob } from "./reportFormat";
import ReportPrintPreview, { ReportTable } from "./ReportPrintPreview";
import "./Reports.css";

const REPORTS = {
  "total-sales": { title: "Total Sales", description: "Recorded sales + deliveries − returns" },
  sales: { title: "Recorded Sales", description: "Transactions and units sold" },
  inventory: { title: "Inventory", description: "Stock movement and current levels" },
  "vendor-deliveries": { title: "Vendor deliveries", description: "Grouped pickups and delivery value" },
};

function Reports({ token, role, initialMode }) {
  const defaultMode = initialMode || (role === "VENDOR" ? "vendor-deliveries" : "sales");
  const allowedModes = role === "VENDOR" ? ["vendor-deliveries"] : ["total-sales", "sales", "inventory", "vendor-deliveries"];
  const [mode, setMode] = useState(defaultMode);
  const [dateMode, setDateMode] = useState("day");
  const [range, setRange] = useState(() => { const today = manilaToday(); return { start_date: today, end_date: today }; });
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const [printPreview, setPrintPreview] = useState(null);
  const allTime = dateMode === "all-time" && mode === "total-sales";
  const validationError = allTime ? "" : rangeError(range);
  const query = allTime ? "scope=all-time" : new URLSearchParams(range).toString();
  const key = `${role}:${mode}:${query}:${token}`;
  const report = result?.key === key ? result.report : null;
  const selected = REPORTS[mode] || REPORTS.sales;

  useEffect(() => { setMode(defaultMode); setPrintPreview(null); }, [defaultMode, role]);

  useEffect(() => {
    setError(""); setExportError("");
    if (!token || validationError) { setLoading(false); return undefined; }
    if (role === "VENDOR" && mode !== "vendor-deliveries") { setError("You do not have permission to view this report."); setLoading(false); return undefined; }
    const controller = new AbortController();
    let active = true;
    let inFlight = false;
    setLoading(true);
    const load = async () => {
      if (inFlight || !active) return;
      inFlight = true;
      try {
        const response = await fetch(apiUrl(`/api/reports/${mode}?${query}`), { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
        const body = await response.json();
        if (!response.ok || !body.report) throw new Error(body.error || "Unable to load report");
        if (active) { setResult({ key, report: body.report }); setError(""); }
      } catch (err) {
        if (active && err.name !== "AbortError") setError(err.message || "Unable to load report");
      } finally {
        inFlight = false;
        if (active) setLoading(false);
      }
    };
    load();
    const interval = window.setInterval(load, 6000);
    const stream = new EventSource(`${apiUrl("/api/events")}?token=${encodeURIComponent(token)}`);
    stream.addEventListener("data-change", load);
    return () => { active = false; controller.abort(); window.clearInterval(interval); stream.close(); };
  }, [key, validationError]);

  async function onExport() {
    if (validationError || !allowedModes.includes(mode) || exporting) return;
    try {
      setExportError(""); setExporting(true);
      const response = await fetch(apiUrl(`/api/reports/${mode}/csv?${query}`), { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "Unable to export report");
      }
      downloadReportBlob(await response.blob(), allTime ? `${mode}-report-all-time.csv` : `${mode}-report-${range.start_date}-to-${range.end_date}.csv`);
    } catch (err) { setExportError(err.message || "Unable to export report"); }
    finally { setExporting(false); }
  }

  if (printPreview) return <ReportPrintPreview report={printPreview} onBack={() => setPrintPreview(null)} />;

  return <div className="reports-page">
    <section className="reports-hero">
      <div><span className="reports-kicker">Data center</span><h2>Reports & exports</h2><p>Choose a report and calendar dates. Export a CSV or print a professional report.</p></div>
      <div className="reports-summary"><strong>{report?.sections[0]?.rows.length || 0}</strong><span>Records in preview</span></div>
    </section>

    <section className="reports-control-card">
      <div className="reports-section-heading"><div><span className="reports-section-label">1. Report type</span><h3>{selected.title}</h3><p>{selected.description}</p></div><span className="reports-range-badge">{allTime ? "All time" : dateMode === "day" ? range.start_date : `${range.start_date} to ${range.end_date}`}</span></div>
      <div className="reports-type-grid">{allowedModes.map((id) => <button type="button" key={id} aria-pressed={mode === id} className={`report-type-button ${mode === id ? "selected" : ""}`} onClick={() => { setMode(id); if (dateMode === "all-time" && id !== "total-sales") { setDateMode("day"); setRange({ start_date: range.start_date, end_date: range.start_date }); } }} disabled={exporting}><strong>{REPORTS[id].title}</strong><span>{REPORTS[id].description}</span></button>)}</div>
      <div className="reports-divider" />
      <div className="reports-date-heading"><span className="reports-section-label">2. Calendar dates</span><div className="reports-date-mode" role="group" aria-label="Reporting period"><button type="button" aria-pressed={dateMode === "day"} className={dateMode === "day" ? "selected" : ""} disabled={exporting} onClick={() => { setDateMode("day"); setRange({ start_date: range.start_date, end_date: range.start_date }); }}>Specific day</button><button type="button" aria-pressed={dateMode === "range"} className={dateMode === "range" ? "selected" : ""} disabled={exporting} onClick={() => setDateMode("range")}>Date range</button>{mode === "total-sales" && <button type="button" aria-pressed={allTime} className={allTime ? "selected" : ""} disabled={exporting} onClick={() => setDateMode("all-time")}>All time</button>}</div></div>
      <div className="reports-export-row">
        {allTime ? <p className="reports-export-note">All recorded activity, from the first transaction through the latest reporting date.</p> : <div className="reports-date-fields">
          <label>{dateMode === "day" ? "Report date" : "From"}<input type="date" aria-label={dateMode === "day" ? "Report date" : "From date"} required value={range.start_date} disabled={exporting} onChange={(event) => setRange({ ...range, start_date: event.target.value, ...(dateMode === "day" ? { end_date: event.target.value } : {}) })} /></label>
          {dateMode === "range" && <label>To<input type="date" aria-label="To date" required min={range.start_date} value={range.end_date} disabled={exporting} onChange={(event) => setRange({ ...range, end_date: event.target.value })} /></label>}
        </div>}
        <div className="reports-actions">
          <button type="button" className="reports-print-button" disabled={loading || !report || Boolean(error || validationError) || exporting} onClick={() => setPrintPreview(report)}>Print preview</button>
          <button type="button" className="reports-export-button" disabled={exporting || loading || !report || Boolean(error || validationError)} onClick={onExport}>{exporting ? "Preparing CSV..." : "Export CSV"}</button>
        </div>
      </div>
      <p className="reports-export-note">CSV includes report details, summary totals, and clearly separated tables. For formatted pages, use Print preview → Print / Save PDF.</p>
      {(validationError || exportError) && <p className="error-message" role="alert">{validationError || exportError}</p>}
    </section>

    <section className="reports-preview-card">
      <div className="reports-preview-heading"><div><span className="reports-section-label">Preview</span><h3>{report?.title || selected.title}</h3></div><span className="reports-row-count">{loading ? "Loading..." : "Business dates: Asia/Manila"}</span></div>
      {error ? <p className="error-message" role="alert">{error}</p> : validationError ? <p>Select valid calendar dates to preview this report.</p> : !report ? <p role="status">Loading report...</p> : <>
        <div className="reports-metric-grid">{report.summary.map((item) => <div key={item.label} className={item.label === "Net sales" ? "reports-metric is-net" : "reports-metric"}><span>{item.label}</span><strong>{formatReportValue(item.value, item.type)}</strong></div>)}</div>
        {report.sections.map((section) => <div className="reports-data-section" key={section.title}><h4>{section.title}</h4><div className="reports-table-scroll"><ReportTable section={section} /></div></div>)}
        <p className="reports-scope-note">{report.note}</p>
      </>}
    </section>
  </div>;
}

export default Reports;
