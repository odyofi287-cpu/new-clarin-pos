import { useEffect, useMemo, useState } from "react";
import { apiUrl } from "./api";
import "./history.css";

function formatCurrency(value) {
  return value == null ? "0.00" : Number(value).toLocaleString("en-PH", { style: "currency", currency: "PHP", minimumFractionDigits: 2 });
}

function formatDeliveryDate(value) {
  const text = String(value || "").slice(0, 10);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return value || "-";
  const [, year, month, day] = match;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))));
}

function POS({ token, role, vendorId, viewMode = "pos" }) {
  const REFRESH_INTERVAL_MS = 6000;
  const isPosEntryView = viewMode === "pos";
  const isDeliveriesView = viewMode === "deliveries";
  const isSalesHistoryView = viewMode === "sales-history";
  const canManagePickupEntries = role === "SUPERADMIN" && isDeliveriesView;
  const [products, setProducts] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [pickupOpen, setPickupOpen] = useState(false);
  const [saleOpen, setSaleOpen] = useState(false);
  const [saleForm, setSaleForm] = useState({ product_id: "", quantity: "1" });
  const [pickupEntries, setPickupEntries] = useState([]);
  const [salesHistory, setSalesHistory] = useState([]);
  const [pickupMode, setPickupMode] = useState("create");
  const [editingPickupId, setEditingPickupId] = useState(null);
  const [listWindowOpen, setListWindowOpen] = useState(false);
  const [historyWindowOpen, setHistoryWindowOpen] = useState(false);
  const [returnsOpen, setReturnsOpen] = useState(false);
  const [returnsHistoryOpen, setReturnsHistoryOpen] = useState(false);
  const [returnEntries, setReturnEntries] = useState([]);
  const [returnForm, setReturnForm] = useState({
    return_date: "",
    return_time: "",
    vendor_id: "",
    product_id: "",
    quantity: "1",
    product_price: "",
    total_product_price_returned: "0.00",
  });
  const [pickupForm, setPickupForm] = useState({
    pickup_date: "",
    pickup_time: "",
    vendor_id: "",
    product_id: "",
    quantity: "1",
    category: "",
    unit_price: "",
    total_price: "0.00"
  });
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (role === "VENDOR" && vendorId) {
      setPickupForm((current) => ({ ...current, vendor_id: String(vendorId) }));
      setReturnForm((current) => ({ ...current, vendor_id: String(vendorId) }));
    }
  }, [role, vendorId]);

  useEffect(() => {
    let active = true;

    const loadProducts = async () => {
      try {
        const res = await fetch(apiUrl('/api/products?active=1'), {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
        });
        const body = await res.json();
        if (!active) return;
        if (!res.ok) {
          setError(body.error || "Unable to load products");
          return;
        }
        setProducts(body.data || []);
      } catch (err) {
        if (active) setError("Unable to load products");
      }
    };

    const loadVendors = async () => {
      try {
        const res = await fetch(apiUrl('/api/users/vendors'), {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
        });
        const body = await res.json();
        if (!active) return;
        if (!res.ok) {
          setError(body.error || "Unable to load vendors");
          return;
        }
        const vendorRows = body.data || [];
        const filtered = role === 'VENDOR' && vendorId ? vendorRows.filter((vendor) => String(vendor.id) === String(vendorId)) : vendorRows;
        setVendors(filtered.map((vendor) => ({ ...vendor, vendor_id: vendor.id })));
      } catch (err) {
        if (active) setError("Unable to load vendors");
      }
    };

    const loadPickupRecords = async () => {
      try {
        const res = await fetch(apiUrl('/api/deliveries'), {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
        });
        const body = await res.json();
        if (!active) return;
        if (!res.ok) {
          setError(body.error || "Unable to load pickup records");
          return;
        }

        const records = (body.data || []).slice().sort((a, b) => String(b.delivery_date).localeCompare(String(a.delivery_date)));
        setPickupEntries(records);
      } catch (err) {
        if (active) setError("Unable to load pickup records");
      }
    };

    const loadSalesHistory = async () => {
      if (role === "VENDOR") {
        setSalesHistory([]);
        return;
      }
      try {
        const res = await fetch(apiUrl('/api/sales'), {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
        });
        const body = await res.json();
        if (!active) return;
        if (!res.ok) {
          setError(body.error || "Unable to load sales history");
          return;
        }
        setSalesHistory(body.data || []);
      } catch (err) {
        if (active) setError("Unable to load sales history");
      }
    };

    const loadVendorReturns = async () => {
      try {
        const res = await fetch(apiUrl('/api/vendor-returns'), {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
        });
        const body = await res.json();
        if (!active) return;
        if (!res.ok) {
          setError(body.error || "Unable to load vendor returns");
          return;
        }
        setReturnEntries(body.data || []);
      } catch (err) {
        if (active) setError("Unable to load vendor returns");
      }
    };

    loadProducts();
    loadVendors();
    loadPickupRecords();
    loadVendorReturns();
    loadSalesHistory();

    const refreshData = () => {
      loadProducts();
      loadVendors();
      loadPickupRecords();
      loadVendorReturns();
      loadSalesHistory();
    };

    const intervalId = window.setInterval(refreshData, REFRESH_INTERVAL_MS);

    const handleProductsUpdated = () => {
      loadProducts();
      loadVendors();
      loadPickupRecords();
      loadVendorReturns();
      loadSalesHistory();
    };
    const handleVendorsUpdated = () => {
      loadVendors();
    };
    window.addEventListener('productsUpdated', handleProductsUpdated);
    window.addEventListener('vendorsUpdated', handleVendorsUpdated);
    const eventStream = new EventSource(`${apiUrl('/api/events')}?token=${encodeURIComponent(token)}`);
    eventStream.addEventListener('data-change', handleProductsUpdated);
    return () => {
      active = false;
      window.clearInterval(intervalId);
      window.removeEventListener('productsUpdated', handleProductsUpdated);
      window.removeEventListener('vendorsUpdated', handleVendorsUpdated);
      eventStream.close();
    };
  }, [token, role, vendorId]);

  const getDisplayVendorId = (entry) => {
    if (entry?.vendor_code) return entry.vendor_code;
    const assignedVendor = vendors.find((vendor) => String(vendor.id) === String(entry?.vendor_id ?? vendorId));
    return assignedVendor?.vendor_code || entry?.vendor_id || vendorId || null;
  };

  const selectedProduct = useMemo(
    () => products.find((product) => String(product.id) === String(pickupForm.product_id)) || null,
    [products, pickupForm.product_id]
  );

  const selectedReturnProduct = useMemo(
    () => products.find((product) => String(product.id) === String(returnForm.product_id)) || null,
    [products, returnForm.product_id]
  );

  useEffect(() => {
    const productPrice = Number(selectedReturnProduct?.selling_price || 0);
    const quantity = Number(returnForm.quantity || 0);
    setReturnForm((current) => ({
      ...current,
      product_price: selectedReturnProduct && Number.isFinite(productPrice) ? String(productPrice) : "",
      total_product_price_returned: selectedReturnProduct && Number.isFinite(quantity) && quantity > 0
        ? String((quantity * productPrice).toFixed(2))
        : "0.00",
    }));
  }, [selectedReturnProduct, returnForm.quantity]);

  useEffect(() => {
    if (!selectedProduct) {
      setPickupForm((current) => ({
        ...current,
        category: "",
        unit_price: "",
        total_price: "0.00",
      }));
      return;
    }

    const quantity = Number(pickupForm.quantity || 0);
    const unitPrice = Number(selectedProduct.selling_price || 0);
    setPickupForm((current) => ({
      ...current,
      category: selectedProduct.category || "",
      unit_price: Number.isFinite(unitPrice) ? String(unitPrice) : "0",
      total_price: Number.isFinite(quantity) && quantity > 0 ? String((quantity * unitPrice).toFixed(2)) : "0.00",
    }));
  }, [selectedProduct, pickupForm.quantity]);

  const resetPickupForm = () => {
    setPickupForm({
      pickup_date: "",
      pickup_time: "",
      vendor_id: "",
      product_id: "",
      quantity: "1",
      category: "",
      unit_price: "",
      total_price: "0.00"
    });
    setEditingPickupId(null);
    setPickupMode("create");
  };

  const resetReturnForm = () => {
    setReturnForm({
      return_date: "",
      return_time: "",
      vendor_id: "",
      product_id: "",
      quantity: "1",
      product_price: "",
      total_product_price_returned: "0.00",
    });
  };

  const submitSale = async (event) => {
    event.preventDefault();
    setError(null);
    setStatus(null);
    const productId = Number(saleForm.product_id);
    const quantity = Number(saleForm.quantity);
    const product = products.find((item) => Number(item.id) === productId);
    if (!product || !Number.isInteger(quantity) || quantity <= 0) {
      setError("Please select a product and enter a valid whole-number quantity.");
      return;
    }
    try {
      const res = await fetch(apiUrl('/api/sales'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ items: [{ product_id: productId, quantity }] }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Unable to record sale');
      setSaleOpen(false);
      setSaleForm({ product_id: "", quantity: "1" });
      setStatus(`Sale recorded for ${product.name} — ${quantity} unit${quantity === 1 ? '' : 's'}.`);
      window.dispatchEvent(new Event('productsUpdated'));
    } catch (err) {
      setError(err.message || 'Unable to record sale');
    }
  };

  const openCreatePickup = () => {
    resetPickupForm();
    setPickupOpen(true);
    setError(null);
    setStatus(null);
  };

  const openEditPickup = async (record) => {
    try {
      const detailRes = await fetch(apiUrl(`/api/deliveries/${record.id}`), {
        headers: { Authorization: `Bearer ${token}` },
      });
      const detailBody = await detailRes.json();
      if (!detailRes.ok) {
        throw new Error(detailBody.error || "Unable to load pickup details");
      }
      const firstItem = (detailBody.data?.items || [])[0] || {};
      setEditingPickupId(record.id);
      setPickupMode("edit");
      setPickupForm({
        pickup_date: detailBody.data?.delivery_date || record.delivery_date || "",
        pickup_time: detailBody.data?.pickup_time || "09:00",
        vendor_id: String(detailBody.data?.vendor_id ?? record.vendor_id ?? ""),
        product_id: String(firstItem.product_id || ""),
        quantity: String(firstItem.quantity || 1),
        category: firstItem.product_name ? "" : "",
        unit_price: String(firstItem.unit_cost || 0),
        total_price: String((Number(firstItem.quantity || 0) * Number(firstItem.unit_cost || 0)).toFixed(2)),
      });
      setPickupOpen(true);
      setError(null);
      setStatus(null);
    } catch (err) {
      setError(err.message || "Unable to edit pickup");
    }
  };

  const handleDeletePickup = async (pickupId) => {
    if (!window.confirm("Delete this vendor pickup? This action cannot be undone.")) {
      return;
    }

    const numericId = Number(pickupId);

    try {
      const res = await fetch(apiUrl(`/api/deliveries/${pickupId}`), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error || 'Unable to delete vendor pickup');
      }

      setPickupEntries((current) => current.filter((record) => Number(record.id) !== numericId));
      setPickupHistory((current) => current.filter((record) => Number(record.id) !== numericId));
      window.dispatchEvent(new Event('productsUpdated'));
      setStatus('Vendor pickup deleted successfully.');
      setError(null);

      const resync = await fetch(apiUrl('/api/deliveries'), {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
      const newBody = await resync.json();
      if (resync.ok) {
        const records = (newBody.data || []).slice().sort((a, b) => String(b.delivery_date).localeCompare(String(a.delivery_date)));
        setPickupEntries(records);
        setPickupHistory(records);
      }
    } catch (err) {
      setError(err.message || 'Unable to delete vendor pickup');
    }
  };

  const submitReturn = async (event) => {
    event.preventDefault();
    setError(null);
    setStatus(null);

    const vendorId = Number(returnForm.vendor_id);
    const productId = Number(returnForm.product_id);
    const quantity = Number(returnForm.quantity);
    const total = Number(returnForm.total_product_price_returned || 0);

    if (!returnForm.return_date || !returnForm.return_time) {
      setError("Return date and return time are required.");
      return;
    }
    if (!vendorId || !productId || !Number.isFinite(quantity) || quantity <= 0) {
      setError("Please select a valid vendor and product and specify a positive quantity.");
      return;
    }
    if (!Number.isFinite(total) || total < 0) {
      setError("Returned total must be zero or greater.");
      return;
    }

    try {
      const res = await fetch(apiUrl('/api/vendor-returns'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          vendor_id: vendorId,
          return_date: returnForm.return_date,
          return_time: returnForm.return_time,
          product_id: productId,
          quantity,
          total_product_price_returned: total,
        })
      });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error || 'Unable to record vendor return');
      }
      setStatus(`Vendor return recorded for ${body.data.product_name} — ${body.data.quantity} units.`);
      setReturnsOpen(false);
      resetReturnForm();
      setReturnEntries((current) => [body.data, ...current]);
      window.dispatchEvent(new Event('productsUpdated'));
    } catch (err) {
      setError(err.message || 'Unable to record vendor return');
    }
  };

  const submitPickup = async (event) => {
    event.preventDefault();
    setError(null);
    setStatus(null);

    if (!pickupForm.pickup_date || !pickupForm.pickup_time) {
      setError("Pick-up date and time are required.");
      return;
    }
    if (!pickupForm.vendor_id) {
      setError("Please select a vendor.");
      return;
    }
    if (!pickupForm.product_id) {
      setError("Please select a product.");
      return;
    }

    const quantity = Number(pickupForm.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setError("Quantity must be greater than zero.");
      return;
    }

    const product = selectedProduct;
    if (!product) {
      setError("Selected product could not be found.");
      return;
    }

    const unitPrice = Number(product.selling_price || 0);
    const totalPrice = quantity * unitPrice;

    setSubmitting(true);
    try {
      if (pickupMode === "edit" && editingPickupId) {
        const superadminPassword = window.prompt('Enter the Superadmin password to confirm this pickup update:');
        if (!superadminPassword || !superadminPassword.trim()) {
          throw new Error('Superadmin verification password is required');
        }

        const verifyRes = await fetch(apiUrl('/api/users/verify-superadmin'), {
          method: 'POST',
          headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ password: superadminPassword }),
        });
        const verifyBody = await verifyRes.json().catch(() => ({}));
        if (!verifyRes.ok) {
          throw new Error(verifyBody.error || 'Superadmin verification failed');
        }

        const res = await fetch(apiUrl(`/api/deliveries/${editingPickupId}`), {
          method: 'PUT',
          headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            vendor_id: Number(pickupForm.vendor_id),
            pickup_datetime: `${pickupForm.pickup_date}T${pickupForm.pickup_time}`,
            delivery_date: pickupForm.pickup_date,
            items: [{ product_id: Number(product.id), quantity, unit_cost: unitPrice }],
          }),
        });
        const body = await res.json();
        if (!res.ok) {
          throw new Error(body.error || 'Unable to update vendor pickup');
        }
        setStatus(`Vendor pickup updated for ${product.name} — total ${formatCurrency(totalPrice)}`);
      } else {
        const res = await fetch(apiUrl('/api/deliveries'), {
          method: 'POST',
          headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            vendor_id: Number(pickupForm.vendor_id),
            pickup_datetime: `${pickupForm.pickup_date}T${pickupForm.pickup_time}`,
            items: [{ product_id: Number(product.id), quantity, unit_cost: unitPrice }],
          }),
        });
        const body = await res.json();
        if (!res.ok) {
          throw new Error(body.error || 'Unable to record vendor pickup');
        }
        setStatus(`Vendor pickup recorded for ${product.name} — total ${formatCurrency(totalPrice)}`);
      }
      setPickupOpen(false);
      resetPickupForm();
      window.dispatchEvent(new Event('productsUpdated'));
    } catch (err) {
      setError(err.message || 'Unable to record vendor pickup');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="dashboard-shell">
      <section className="dashboard-card">
        <div className="pos-header">
          <div>
            <h2>{isSalesHistoryView ? "Sales & Pickup History" : isDeliveriesView ? "Vendor Deliveries" : "Direct-to-Vendor POS"}</h2>
            <p className="muted-text">
              {isSalesHistoryView
                ? "Review recorded POS sales and vendor pickup records."
                : isDeliveriesView
                  ? "Access vendor pickup list and vendor returns."
                  : "Record vendor pickups with product, category, quantity, and total price."}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {isPosEntryView && (
              <button className="primary-button" onClick={() => { setSaleOpen(true); setError(null); setStatus(null); }}>
                Record Sale
              </button>
            )}
            {isPosEntryView && (
              <button className="primary-button" onClick={openCreatePickup}>
                Add Vendor Pickup
              </button>
            )}
            {isDeliveriesView && (
              <button className="small-button" onClick={() => setListWindowOpen(true)}>
                Vendor Pickup List
              </button>
            )}
            {isDeliveriesView && role !== "VENDOR" && (
              <button className="small-button" onClick={() => setReturnsOpen(true)}>
                Record Return
              </button>
            )}
            {isDeliveriesView && (
              <button className="small-button" onClick={() => setReturnsHistoryOpen(true)}>
                Return History
              </button>
            )}
          </div>
        </div>

        {status && <p className="success-message">{status}</p>}
        {error && <p className="error-message">{error}</p>}

        {isSalesHistoryView && (
          <div className="history-sections">
            <section className="history-section history-section-sales">
              <header className="history-section-header">
                <div><span className="history-section-kicker">Classification</span><h3>Recorded Sales</h3><p>Completed POS transactions.</p></div>
                <span className="history-section-count">{salesHistory.length} records</span>
              </header>
              <div className="history-table-wrap">
                {salesHistory.length === 0 ? (
                  <p className="history-empty">No recorded sales available.</p>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>Sale ID</th>
                        <th>Date</th>
                        <th>Sold By</th>
                        <th>Items</th>
                        <th>Quantity</th>
                        <th>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {salesHistory.map((entry) => (
                        <tr key={`sales-history-${entry.id}`}>
                          <td data-label="Sale ID">{entry.id}</td>
                          <td data-label="Date">{formatDeliveryDate(entry.sale_date)}</td>
                          <td data-label="Sold By">{entry.sold_by || "Unknown"}</td>
                          <td data-label="Items">{entry.items || "-"}</td>
                          <td data-label="Quantity">{entry.item_count}</td>
                          <td data-label="Total">{formatCurrency(entry.total_amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </section>

            <section className="history-section history-section-pickups">
              <header className="history-section-header">
                <div><span className="history-section-kicker">Classification</span><h3>Vendor Pickups</h3><p>Products picked up by vendors.</p></div>
                <span className="history-section-count">{pickupEntries.length} records</span>
              </header>
              <div className="history-table-wrap">
                {pickupEntries.length === 0 ? (
                  <p className="history-empty">No vendor pickups available.</p>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>Pickup ID</th>
                        <th>Vendor ID</th>
                        <th>Vendor</th>
                        <th>Date</th>
                        <th>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pickupEntries.map((entry) => (
                        <tr key={`pickup-history-${entry.id}`}>
                          <td data-label="Pickup ID">{entry.id}</td>
                          <td data-label="Vendor ID">{getDisplayVendorId(entry)}</td>
                          <td data-label="Vendor">{entry.vendor_name || entry.vendor_id}</td>
                          <td data-label="Date">{formatDeliveryDate(entry.delivery_date)}</td>
                          <td data-label="Total">{formatCurrency(entry.total_amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </section>
          </div>
        )}

        {listWindowOpen && (
          <div className="modal-overlay">
            <div className="pos-modal-card">
              <div className="pos-modal-header">
                <h3>Vendor Pickup List</h3>
                <button className="small-button" onClick={() => setListWindowOpen(false)}>Close</button>
              </div>
              {pickupEntries.length === 0 ? (
                <p>No vendor pickups available.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Vendor ID</th>
                      <th>Vendor</th>
                      <th>Date</th>
                      <th>Total</th>
                      {canManagePickupEntries && <th>Action</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {pickupEntries.map((entry) => (
                      <tr key={entry.id}>
                        <td data-label="Vendor ID">{getDisplayVendorId(entry)}</td>
                        <td data-label="Vendor">{entry.vendor_name || entry.vendor_id}</td>
                        <td data-label="Date">{formatDeliveryDate(entry.delivery_date)}</td>
                        <td data-label="Total">{formatCurrency(entry.total_amount)}</td>
                        {canManagePickupEntries && (
                          <td data-label="Action" style={{ display: 'flex', gap: 8 }}>
                            <button type="button" className="small-button" onClick={() => openEditPickup(entry)}>Edit</button>
                            <button type="button" className="small-button" onClick={() => handleDeletePickup(entry.id)}>Delete</button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {returnsOpen && (
          <div className="modal-overlay">
            <div className="pos-modal-card--narrow">
              <div className="pos-modal-header">
                <h3>Vendor Returns</h3>
                <button className="small-button" onClick={() => { setReturnsOpen(false); resetReturnForm(); }}>Close</button>
              </div>

              <form onSubmit={submitReturn} className="pos-modal-form">
                <div className="pos-modal-form-grid" style={{ gridColumn: '1 / -1' }}>
                  <label>
                    Return Date
                    <input type="date" value={returnForm.return_date} onChange={(event) => setReturnForm({ ...returnForm, return_date: event.target.value })} required />
                  </label>
                  <label>
                    Return Time
                    <input type="time" value={returnForm.return_time} onChange={(event) => setReturnForm({ ...returnForm, return_time: event.target.value })} required />
                  </label>
                </div>

                <div className="pos-modal-form-grid" style={{ gridColumn: '1 / -1' }}>
                  <label>
                    Vendor
                    <select value={returnForm.vendor_id} onChange={(event) => setReturnForm({ ...returnForm, vendor_id: event.target.value })} required>
                      <option value="">Select vendor</option>
                      {vendors.map((vendor) => (
                        <option key={vendor.id} value={vendor.vendor_id ?? vendor.id}>
                          {vendor.name} ({vendor.vendor_code || `VND-${String(vendor.vendor_id ?? vendor.id).padStart(4, '0')}`})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Vendor ID
                    <input value={returnForm.vendor_id || ''} readOnly placeholder="Auto-filled from vendor" />
                  </label>
                </div>

                <div className="pos-modal-form-grid" style={{ gridColumn: '1 / -1' }}>
                  <label>
                    Product
                    <select value={returnForm.product_id} onChange={(event) => setReturnForm({ ...returnForm, product_id: event.target.value })} required>
                      <option value="">Select product</option>
                      {products.map((product) => (
                        <option key={product.id} value={product.id}>{product.name} - {product.category || 'General'}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Quantity
                    <input type="number" min="1" value={returnForm.quantity} onChange={(event) => setReturnForm({ ...returnForm, quantity: event.target.value })} required />
                  </label>
                </div>

                <div className="pos-modal-form-grid" style={{ gridColumn: '1 / -1' }}>
                  <label>
                    Product Price
                    <input value={returnForm.product_price} readOnly placeholder="Auto-filled from product data" />
                  </label>
                  <label>
                    Total Product Price Returned
                    <input value={returnForm.total_product_price_returned} readOnly placeholder="Product price × quantity" />
                  </label>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8, gridColumn: '1 / -1' }}>
                  <button type="button" className="small-button" onClick={() => { setReturnsOpen(false); resetReturnForm(); }}>Cancel</button>
                  <button type="submit" className="primary-button">Save Return</button>
                </div>
              </form>

            </div>
          </div>
        )}

        {returnsHistoryOpen && (
          <div className="modal-overlay">
            <div className="pos-modal-card">
              <div className="pos-modal-header">
                <div>
                  <h3>Vendor Return History</h3>
                  <p className="muted-text">Review and remove recorded product returns.</p>
                </div>
                <button className="small-button" onClick={() => setReturnsHistoryOpen(false)}>Close</button>
              </div>
              {returnEntries.length === 0 ? (
                <p>No return history available.</p>
              ) : (
                <div className="management-table-wrap">
                  <table>
                    <thead><tr><th>ID</th><th>Vendor</th><th>Product</th><th>Date</th><th>Time</th><th>Qty</th><th>Returned Amount</th><th>Action</th></tr></thead>
                    <tbody>{returnEntries.map((entry) => <tr key={entry.id}>
                      <td data-label="ID">{entry.id}</td>
                      <td data-label="Vendor">{entry.vendor_name || entry.vendor_id}</td>
                      <td data-label="Product">{entry.product_name || entry.product_id}</td>
                          <td data-label="Date">{formatDeliveryDate(entry.return_date)}</td>
                      <td data-label="Time">{entry.return_time}</td>
                      <td data-label="Qty">{entry.quantity}</td>
                      <td data-label="Returned Amount">{formatCurrency(entry.total_product_price_returned)}</td>
                      <td data-label="Action"><button type="button" className="small-button" onClick={async () => {
                        const res = await fetch(apiUrl(`/api/vendor-returns/${entry.id}`), { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
                        if (res.ok) {
                          setReturnEntries((current) => current.filter((row) => Number(row.id) !== Number(entry.id)));
                          setStatus('Vendor return removed successfully.');
                        } else {
                          const body = await res.json().catch(() => ({}));
                          setError(body.error || 'Unable to remove vendor return.');
                        }
                      }}>Remove Return</button></td>
                    </tr>)}</tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {pickupOpen && (
          <div className="modal-overlay">
            <div className="pos-modal-card--narrow">
              <div className="pos-modal-header">
                <h3>{pickupMode === 'edit' ? 'Edit Vendor Pickup' : 'Add Vendor Pickup'}</h3>
                <button className="small-button" onClick={() => { setPickupOpen(false); resetPickupForm(); }}>Close</button>
              </div>

              <form onSubmit={submitPickup} className="pos-modal-form">
                <div className="pos-modal-form-grid" style={{ gridColumn: '1 / -1' }}>
                  <label>
                    Pick-up date
                    <input type="date" value={pickupForm.pickup_date} onChange={(event) => setPickupForm({ ...pickupForm, pickup_date: event.target.value })} required />
                  </label>
                  <label>
                    Pick-up time
                    <input type="time" value={pickupForm.pickup_time} onChange={(event) => setPickupForm({ ...pickupForm, pickup_time: event.target.value })} required />
                  </label>
                </div>

                <div className="pos-modal-form-grid" style={{ gridColumn: '1 / -1' }}>
                  <label>
                    Vendor
                    <select value={pickupForm.vendor_id} onChange={(event) => setPickupForm({ ...pickupForm, vendor_id: event.target.value })} required>
                      <option value="">Select vendor</option>
                      {vendors.map((vendor) => (
                        <option key={vendor.id} value={vendor.vendor_id ?? vendor.id}>
                          {vendor.name} ({vendor.vendor_code || `VND-${String(vendor.vendor_id ?? vendor.id).padStart(4, '0')}`})
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="pos-modal-form-grid" style={{ gridColumn: '1 / -1' }}>
                  <label>
                    Product
                    <select value={pickupForm.product_id} onChange={(event) => setPickupForm({ ...pickupForm, product_id: event.target.value })} required>
                      <option value="">Select product</option>
                      {products.map((product) => (
                        <option key={product.id} value={product.id}>{product.name} - {product.category || 'General'} — Stock: {product.current_stock} {product.unit || 'units'}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Category
                    <input value={pickupForm.category} readOnly placeholder="Auto-filled from product data" />
                  </label>
                </div>

                <div className="pos-modal-form-grid" style={{ gridColumn: '1 / -1' }}>
                  <label>
                    Quantity
                    <input type="number" min="1" value={pickupForm.quantity} onChange={(event) => setPickupForm({ ...pickupForm, quantity: event.target.value })} required />
                  </label>
                  <label>
                    Unit price
                    <input value={pickupForm.unit_price} readOnly placeholder="Auto-filled from product data" />
                  </label>
                  <label>
                    Total price
                    <input value={pickupForm.total_price} readOnly placeholder="Quantity × unit price" />
                  </label>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8, gridColumn: '1 / -1' }}>
                  <button type="button" className="small-button" onClick={() => { setPickupOpen(false); resetPickupForm(); }}>Cancel</button>
                  <button type="submit" className="primary-button" disabled={submitting}>
                    {submitting ? (pickupMode === 'edit' ? 'Updating...' : 'Recording...') : (pickupMode === 'edit' ? 'Update Vendor Pickup' : 'Save Vendor Pickup')}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {saleOpen && (
          <div className="modal-overlay">
            <div className="pos-modal-card--narrow">
              <div className="pos-modal-header">
                <h3>Record Sale</h3>
                <button type="button" className="small-button" onClick={() => setSaleOpen(false)}>Close</button>
              </div>
              <form onSubmit={submitSale} className="pos-modal-form">
                <label>
                  Product
                  <select value={saleForm.product_id} onChange={(event) => setSaleForm({ ...saleForm, product_id: event.target.value })} required>
                    <option value="">Select product</option>
                    {products.map((product) => <option key={product.id} value={product.id}>{product.name} — Stock: {product.current_stock}</option>)}
                  </select>
                </label>
                <label>
                  Quantity
                  <input type="number" min="1" step="1" value={saleForm.quantity} onChange={(event) => setSaleForm({ ...saleForm, quantity: event.target.value })} required />
                </label>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8, gridColumn: '1 / -1' }}>
                  <button type="button" className="small-button" onClick={() => setSaleOpen(false)}>Cancel</button>
                  <button type="submit" className="primary-button">Save Sale</button>
                </div>
              </form>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

export default POS;
