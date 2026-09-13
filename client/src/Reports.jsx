import { useEffect, useState } from "react";
import { apiUrl } from "./api";

const TODAY = new Date().toISOString().split("T")[0];

function formatCurrency(value) {
  return value == null ? "0.00" : Number(value).toLocaleString("en-PH", { style: "currency", currency: "PHP", minimumFractionDigits: 2 });
}

function Reports({ token, role, vendorId, initialMode }) {
  const REFRESH_INTERVAL_MS = 6000;
  const resolvedDefaultMode = initialMode || (role === "VENDOR" ? "vendor-deliveries" : "sales");
  const [mode, setMode] = useState(resolvedDefaultMode);
  const [data, setData] = useState([]);
  const [range, setRange] = useState({ start_date: TODAY, end_date: TODAY });
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    setMode(resolvedDefaultMode);
  }, [resolvedDefaultMode]);

  useEffect(() => {
    if (!token) return;
    loadReport();
  }, [mode, range, token]);

  useEffect(() => {
    if (!token) return;

    const refreshData = () => {
      loadReport();
    };

    const intervalId = window.setInterval(refreshData, REFRESH_INTERVAL_MS);
    const eventStream = new EventSource(`${apiUrl('/api/events')}?token=${encodeURIComponent(token)}`);
    eventStream.addEventListener('data-change', refreshData);
    return () => {
      window.clearInterval(intervalId);
      eventStream.close();
    };
  }, [token, mode, range, role]);

  // Allowed report modes depending on role
  const allowedModes = role === "VENDOR" ? ["vendor-deliveries"] : ["sales", "inventory", "vendor-deliveries"];

  const loadReport = async () => {
    setError(null);
    const query = new URLSearchParams(range).toString();
    // Prevent vendors from calling admin-only endpoints
    if (!allowedModes.includes(mode)) {
      setError("You do not have permission to view this report.");
      setData([]);
      return;
    }

    const endpoint = apiUrl(`/api/reports/${mode}?${query}`);
    try {
      const res = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` } });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error || "Unable to load report");
        return;
      }
      setData(body.data || []);
    } catch (err) {
      setError("Unable to load report");
    }
  };

  const onExport = async () => {
    const query = new URLSearchParams(range).toString();
    if (!allowedModes.includes(mode)) {
      setError("You do not have permission to export this report.");
      return;
    }

    try {
      setError(null);
      setExporting(true);
      const response = await fetch(apiUrl(`/api/reports/${mode}/csv?${query}`), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "Unable to export report");
      }

      const blob = await response.blob();
      const downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = `${mode}-report-${range.start_date}-to-${range.end_date}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(downloadUrl);
    } catch (err) {
      setError(err.message || "Unable to export report");
    } finally {
      setExporting(false);
    }
  };

  const reportLabels = {
    sales: { title: "Sales report", description: "Recorded transactions and revenue" },
    inventory: { title: "Inventory report", description: "Stock movement and current levels" },
    "vendor-deliveries": { title: "Vendor deliveries", description: "Pickup records and delivery value" },
  };
  const selectedReport = reportLabels[mode] || reportLabels.sales;

  const renderTable = () => {
    if (!Array.isArray(data)) return null;
    if (mode === "sales") {
      return (
        <table>
          <thead>
            <tr>
              <th>Transaction ID</th>
              <th>Date</th>
              <th>Staff</th>
              <th>Items</th>
              <th>Quantity</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row) => (
              <tr key={row.transaction_id}>
                <td>{row.transaction_id}</td>
                <td>{row.sale_date}</td>
                <td>{row.staff}</td>
                <td>{row.items}</td>
                <td>{row.quantity}</td>
                <td>{formatCurrency(row.total_amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    }

    if (mode === "inventory") {
      return (
        <table>
          <thead>
            <tr>
              <th>Product</th>
              <th>Stock-in</th>
              <th>Stock-out</th>
              <th>Current stock</th>
              <th>Minimum stock</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row, idx) => (
              <tr key={`${row.product}-${idx}`}>
                <td>{row.product}</td>
                <td>{row.stock_in}</td>
                <td>{row.stock_out}</td>
                <td>{row.current_stock}</td>
                <td>{row.minimum_stock}</td>
                <td>{row.stock_status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    }

    return (
      <table>
        <thead>
          <tr>
            <th>Vendor</th>
            <th>Delivery date</th>
            <th>Products</th>
            <th>Quantity</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row, idx) => (
            <tr key={`${row.vendor}-${idx}`}>
              <td>{row.vendor}</td>
              <td>{row.delivery_date}</td>
              <td>{row.products}</td>
              <td>{row.quantity}</td>
              <td>{formatCurrency(row.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  };

  return (
    <div className="reports-page">
      <section className="reports-hero">
        <div>
          <span className="reports-kicker">Data center</span>
          <h2>Reports & exports</h2>
          <p>Choose a report and date range to review or download your records.</p>
        </div>
        <div className="reports-summary">
          <strong>{data.length}</strong>
          <span>Rows in preview</span>
        </div>
      </section>

      <section className="reports-control-card">
        <div className="reports-section-heading">
          <div>
            <span className="reports-section-label">1. Report type</span>
            <h3>{selectedReport.title}</h3>
            <p>{selectedReport.description}</p>
          </div>
          <span className="reports-range-badge">{range.start_date} to {range.end_date}</span>
        </div>
        <div className="reports-type-grid">
          {allowedModes.includes("sales") && (
            <button type="button" className={`report-type-button ${mode === "sales" ? "selected" : ""}`} onClick={() => setMode("sales")}>
              <strong>Sales</strong><span>Transactions and totals</span>
            </button>
          )}
          {allowedModes.includes("inventory") && (
            <button type="button" className={`report-type-button ${mode === "inventory" ? "selected" : ""}`} onClick={() => setMode("inventory")}>
              <strong>Inventory</strong><span>Stock movement and levels</span>
            </button>
          )}
          {allowedModes.includes("vendor-deliveries") && (
            <button type="button" className={`report-type-button ${mode === "vendor-deliveries" ? "selected" : ""}`} onClick={() => setMode("vendor-deliveries")}>
              <strong>Vendor deliveries</strong><span>Pickups and delivery value</span>
            </button>
          )}
        </div>

        <div className="reports-divider" />

        <div className="reports-export-row">
          <div className="reports-date-fields">
            <span className="reports-section-label">2. Date range</span>
            <label>From<input type="date" value={range.start_date} onChange={(e) => setRange({ ...range, start_date: e.target.value })} /></label>
            <label>To<input type="date" value={range.end_date} onChange={(e) => setRange({ ...range, end_date: e.target.value })} /></label>
          </div>
          <button type="button" className="reports-export-button" onClick={onExport} disabled={exporting || Boolean(error)}>
            <span aria-hidden="true">↓</span>
            {exporting ? "Preparing CSV..." : "Export CSV"}
          </button>
        </div>
      </section>

      <section className="reports-preview-card">
        <div className="reports-preview-heading">
          <div><span className="reports-section-label">Preview</span><h3>{selectedReport.title}</h3></div>
          <span className="reports-row-count">{data.length} {data.length === 1 ? "record" : "records"}</span>
        </div>
        {error ? <p className="error-message">{error}</p> : data.length === 0 ? <div className="reports-empty"><strong>No records found</strong><span>Try a different date range.</span></div> : <div className="reports-table-scroll">{renderTable()}</div>}
      </section>

      <style>{`
        .reports-page { color:#25345b; display:grid; gap:1rem; padding:1.75rem; }
        .reports-hero { align-items:flex-end; background:linear-gradient(120deg,#f2f8ff,#ffffff 62%); border:1px solid #dce7f5; border-radius:10px; display:flex; justify-content:space-between; gap:1rem; padding:1.35rem 1.5rem; }
        .reports-kicker,.reports-section-label { color:#3272bf; font-size:.72rem; font-weight:800; letter-spacing:.08em; text-transform:uppercase; }
        .reports-hero h2,.reports-section-heading h3,.reports-preview-heading h3 { color:#1e3564; letter-spacing:0; margin:.25rem 0; }
        .reports-hero p,.reports-section-heading p { color:#697a98; margin:.25rem 0 0; }
        .reports-summary { border-left:1px solid #d6e2f1; min-width:110px; padding-left:1.25rem; text-align:right; }
        .reports-summary strong { color:#2268bd; display:block; font-size:1.8rem; line-height:1; }
        .reports-summary span,.reports-row-count { color:#71819d; font-size:.78rem; }
        .reports-control-card,.reports-preview-card { background:#fff; border:1px solid #dde6f1; border-radius:10px; box-shadow:0 10px 24px rgba(38,75,122,.06); padding:1.35rem 1.5rem; }
        .reports-section-heading,.reports-preview-heading { align-items:flex-start; display:flex; justify-content:space-between; gap:1rem; }
        .reports-range-badge { background:#f1f6fc; border-radius:999px; color:#557092; font-size:.78rem; padding:.5rem .75rem; white-space:nowrap; }
        .reports-type-grid { display:grid; gap:.7rem; grid-template-columns:repeat(3,minmax(0,1fr)); margin-top:1rem; }
        .report-type-button { background:#f8fafc; border:1px solid #dbe5f0; border-radius:8px; color:#536883; cursor:pointer; min-height:68px; padding:.8rem 1rem; text-align:left; transition:border-color .2s,background .2s,transform .2s; }
        .report-type-button:hover { border-color:#8eb6df; transform:translateY(-1px); }
        .report-type-button.selected { background:#edf6ff; border-color:#327bd0; box-shadow:0 0 0 2px rgba(50,123,208,.12); color:#1e5eaa; }
        .report-type-button strong,.report-type-button span { display:block; }
        .report-type-button span { color:#71819d; font-size:.78rem; margin-top:.25rem; }
        .reports-divider { border-top:1px solid #edf1f6; margin:1.25rem 0; }
        .reports-export-row { align-items:flex-end; display:flex; justify-content:space-between; gap:1rem; }
        .reports-date-fields { align-items:flex-end; display:flex; flex-wrap:wrap; gap:.7rem; }
        .reports-date-fields > .reports-section-label { align-self:center; margin-right:.25rem; }
        .reports-date-fields label { color:#61728f; display:grid; font-size:.78rem; font-weight:700; gap:.3rem; }
        .reports-date-fields input { border:1px solid #cfdae8; border-radius:6px; color:#263b61; font:inherit; padding:.62rem .7rem; }
        .reports-export-button { align-items:center; background:#2474c9; border:0; border-radius:7px; box-shadow:0 7px 14px rgba(36,116,201,.18); color:#fff; cursor:pointer; display:flex; font-weight:800; gap:.45rem; min-height:42px; padding:.7rem 1.05rem; white-space:nowrap; }
        .reports-export-button:hover { background:#1d62ad; }
        .reports-export-button:disabled { cursor:not-allowed; opacity:.6; }
        .reports-table-scroll { overflow-x:auto; }
        .reports-preview-card table { border-collapse:collapse; min-width:680px; width:100%; }
        .reports-preview-card th { background:#f7f9fc; color:#647692; font-size:.72rem; letter-spacing:.06em; text-align:left; text-transform:uppercase; }
        .reports-preview-card th,.reports-preview-card td { border-bottom:1px solid #edf1f6; padding:.8rem .75rem; }
        .reports-preview-card td { color:#3e5170; font-size:.88rem; }
        .reports-empty { align-items:center; color:#71819d; display:flex; flex-direction:column; gap:.25rem; padding:3rem 1rem; text-align:center; }
        .reports-empty strong { color:#344b70; }
        @media (max-width:700px) { .reports-page { padding:1rem; } .reports-hero,.reports-export-row { align-items:stretch; flex-direction:column; } .reports-summary { border-left:0; border-top:1px solid #d6e2f1; padding-left:0; padding-top:.8rem; text-align:left; } .reports-type-grid { grid-template-columns:1fr; } .reports-export-button { justify-content:center; width:100%; } }
      `}</style>
    </div>
  );
}

export default Reports;
