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
    }
  };

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
    <div className="dashboard-shell">
      <section className="dashboard-card">
        <h2>Reports</h2>
        <div className="filters-row">
          <label>
            Start
            <input type="date" value={range.start_date} onChange={(e) => setRange({ ...range, start_date: e.target.value })} />
          </label>
          <label>
            End
            <input type="date" value={range.end_date} onChange={(e) => setRange({ ...range, end_date: e.target.value })} />
          </label>
          {allowedModes.includes("sales") && (
            <button type="button" onClick={() => setMode("sales")} className={mode === "sales" ? "active" : ""}>Sales</button>
          )}
          {allowedModes.includes("inventory") && (
            <button type="button" onClick={() => setMode("inventory")} className={mode === "inventory" ? "active" : ""}>Inventory</button>
          )}
          {allowedModes.includes("vendor-deliveries") && (
            <button type="button" onClick={() => setMode("vendor-deliveries")} className={mode === "vendor-deliveries" ? "active" : ""}>Vendor Deliveries</button>
          )}
          <button type="button" onClick={onExport}>Export CSV</button>
        </div>
      </section>
      <section className="dashboard-card">
        {error ? <p className="error-message">{error}</p> : renderTable()}
      </section>
    </div>
  );
}

export default Reports;
