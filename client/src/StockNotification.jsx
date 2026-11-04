import { createPortal } from "react-dom";
import { productStockStatus } from "./stockAlerts";
import "./stockAlerts.css";

export function StockIcon({ outOfStock = false }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m4 7 8-4 8 4-8 4-8-4Zm0 0v10l8 4 8-4V7M12 11v10" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      {outOfStock ? <path d="m9 6 6 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /> : <path d="M16 15v2m0-5v.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />}
    </svg>
  );
}

export default function StockNotification({ products, onOpen, onDismiss }) {
  const groups = [
    { filter: "out-of-stock", label: "Out-of-stock products", hint: "Unavailable for delivery or sale", count: products.filter((product) => productStockStatus(product) === "out-of-stock").length },
    { filter: "low-stock", label: "Low-stock products", hint: "10 Items or fewer remaining", count: products.filter((product) => productStockStatus(product) === "low-stock").length },
  ].filter((group) => group.count > 0);
  const total = groups.reduce((sum, group) => sum + group.count, 0);

  if (groups.length === 0) return null;

  // Portal keeps this popup anchored to the viewport, outside page transitions.
  return createPortal(
    <aside className="stock-notification" aria-label="Stock notifications">
      <div className="stock-notification-heading">
        <div role="status" aria-live="polite" aria-atomic="true">
          <span className="stock-notification-kicker">Stock update</span>
          <h3>Inventory needs attention</h3>
          <p>{total} {total === 1 ? "product needs" : "products need"} stock attention.</p>
        </div>
        <button type="button" className="stock-notification-dismiss" aria-label="Dismiss stock notification" onClick={onDismiss}>
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
        </button>
      </div>
      <div className="stock-notification-links">
        {groups.map((group) => (
          <button type="button" className={`stock-notification-link is-${group.filter}`} key={group.filter} onClick={() => onOpen(group.filter)}>
            <span className="stock-notification-icon"><StockIcon outOfStock={group.filter === "out-of-stock"} /></span>
            <span className="stock-notification-copy"><strong>{group.label}</strong><small>{group.hint}</small></span>
            <span className="stock-notification-count">{group.count}</span>
            <span className="stock-link-arrow" aria-hidden="true">&rarr;</span>
          </button>
        ))}
      </div>
      <span className="stock-notification-footer">Choose a stock alert to view its products.</span>
    </aside>,
    document.body
  );
}
