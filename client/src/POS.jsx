import { useEffect, useMemo, useState } from "react";
import { apiUrl } from "./api";
import "./history.css";
import "./transaction-entry.css";

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
  const [entryMode, setEntryMode] = useState(null);
  const [productSearch, setProductSearch] = useState("");
  const [pickupQuantities, setPickupQuantities] = useState({});
  const [saleQuantities, setSaleQuantities] = useState({});
  const [returnQuantities, setReturnQuantities] = useState({});
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

  const transactionQuantities = entryMode === "pickup"
    ? pickupQuantities
    : entryMode === "return"
      ? returnQuantities
      : saleQuantities;
  const filteredCatalogProducts = useMemo(() => {
    const search = productSearch.trim().toLowerCase();
    if (!search) return products;
    return products.filter((product) => [product.name, product.category, product.unit]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(search)));
  }, [products, productSearch]);

  const transactionItems = useMemo(() => products
    .map((product) => ({ ...product, quantity: Number(transactionQuantities[product.id] || 0) }))
    .filter((product) => Number.isInteger(product.quantity) && product.quantity > 0), [products, transactionQuantities]);

  const transactionQuantityTotal = useMemo(
    () => transactionItems.reduce((total, item) => total + item.quantity, 0),
    [transactionItems]
  );

  const transactionTotal = useMemo(
    () => transactionItems.reduce((total, item) => total + (item.quantity * Number(item.selling_price || 0)), 0),
    [transactionItems]
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
    setPickupQuantities({});
  };

  const updateTransactionQuantity = (product, nextValue) => {
    const parsed = Number(nextValue);
    const quantity = Number.isFinite(parsed) ? Math.max(0, Math.min(Math.trunc(parsed), Number(product.current_stock || 0))) : 0;
    const setQuantities = entryMode === "pickup"
      ? setPickupQuantities
      : entryMode === "return"
        ? setReturnQuantities
        : setSaleQuantities;
    setQuantities((current) => ({ ...current, [product.id]: quantity }));
  };

  const closeTransactionEntry = () => {
    setEntryMode(null);
    setProductSearch("");
    setSaleQuantities({});
    setReturnQuantities({});
    resetPickupForm();
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
    setReturnQuantities({});
  };

  const submitSale = async (event) => {
    event.preventDefault();
    setError(null);
    setStatus(null);
    if (!transactionItems.length) {
      setError("Add at least one product with a quantity greater than zero.");
      return;
    }
    try {
      const res = await fetch(apiUrl('/api/sales'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ items: transactionItems.map((item) => ({ product_id: item.id, quantity: item.quantity })) }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Unable to record sale');
      setEntryMode(null);
      setSaleQuantities({});
      setProductSearch("");
      setSaleForm({ product_id: "", quantity: "1" });
      setStatus(`Sale recorded with ${transactionItems.length} product${transactionItems.length === 1 ? '' : 's'} and ${transactionQuantityTotal} total units.`);
      window.dispatchEvent(new Event('productsUpdated'));
    } catch (err) {
      setError(err.message || 'Unable to record sale');
    }
  };

  const openCreatePickup = () => {
    resetPickupForm();
    setEntryMode("pickup");
    setProductSearch("");
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
      const items = detailBody.data?.items || [];
      setEditingPickupId(record.id);
      setPickupMode("edit");
      setPickupForm({
        pickup_date: detailBody.data?.delivery_date || record.delivery_date || "",
        pickup_time: detailBody.data?.delivery_time || record.delivery_time || "09:00",
        vendor_id: String(detailBody.data?.vendor_id ?? record.vendor_id ?? ""),
        product_id: "",
        quantity: "1",
        category: "",
        unit_price: "",
        total_price: "0.00",
      });
      setPickupQuantities(Object.fromEntries(items.map((item) => [item.product_id, Number(item.quantity || 0)])));
      setEntryMode("pickup");
      setProductSearch("");
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

    if (!returnForm.return_date || !returnForm.return_time) {
      setError("Return date and return time are required.");
      return;
    }
    if (!vendorId) {
      setError("Please select a vendor.");
      return;
    }
    if (!transactionItems.length) {
      setError("Add at least one product with a quantity greater than zero.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(apiUrl('/api/vendor-returns'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          vendor_id: vendorId,
          return_date: returnForm.return_date,
          return_time: returnForm.return_time,
          items: transactionItems.map((item) => ({
            product_id: item.id,
            quantity: item.quantity,
            total_product_price_returned: item.quantity * Number(item.selling_price || 0),
          })),
        })
      });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error || 'Unable to record vendor return');
      }
      const returnedItems = body.data?.items || [];
      setStatus(`Vendor return recorded with ${returnedItems.length} product${returnedItems.length === 1 ? '' : 's'} — total ${formatCurrency(body.data?.total_amount || transactionTotal)}.`);
      setEntryMode(null);
      setProductSearch("");
      resetReturnForm();
      const selectedVendor = vendors.find((vendor) => Number(vendor.id) === vendorId);
      const returnBatch = {
        id: body.data?.return_batch_id || returnedItems[0]?.id,
        return_batch_id: body.data?.return_batch_id || null,
        vendor_id: vendorId,
        vendor_name: selectedVendor?.name,
        return_date: returnForm.return_date,
        return_time: returnForm.return_time,
        items: returnedItems.map((item) => `${item.product_name || item.product_id} (${item.quantity})`).join(', '),
        quantity: returnedItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
        total_product_price_returned: Number(body.data?.total_amount || transactionTotal),
        return_ids: returnedItems.map((item) => item.id),
      };
      setReturnEntries((current) => [returnBatch, ...current]);
      window.dispatchEvent(new Event('productsUpdated'));
    } catch (err) {
      setError(err.message || 'Unable to record vendor return');
    } finally {
      setSubmitting(false);
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
    if (!transactionItems.length) {
      setError("Add at least one product with a quantity greater than zero.");
      return;
    }

    const deliveryItems = transactionItems.map((item) => ({
      product_id: item.id,
      quantity: item.quantity,
      unit_cost: Number(item.selling_price || 0),
    }));

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
            items: deliveryItems,
          }),
        });
        const body = await res.json();
        if (!res.ok) {
          throw new Error(body.error || 'Unable to update vendor pickup');
        }
        setStatus(`Vendor pickup updated with ${transactionItems.length} product${transactionItems.length === 1 ? '' : 's'} — total ${formatCurrency(transactionTotal)}.`);
      } else {
        const res = await fetch(apiUrl('/api/deliveries'), {
          method: 'POST',
          headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            vendor_id: Number(pickupForm.vendor_id),
            pickup_datetime: `${pickupForm.pickup_date}T${pickupForm.pickup_time}`,
            items: deliveryItems,
          }),
        });
        const body = await res.json();
        if (!res.ok) {
          throw new Error(body.error || 'Unable to record vendor pickup');
        }
        setStatus(`Vendor pickup recorded with ${transactionItems.length} product${transactionItems.length === 1 ? '' : 's'} — total ${formatCurrency(transactionTotal)}.`);
      }
      setEntryMode(null);
      setProductSearch("");
      resetPickupForm();
      window.dispatchEvent(new Event('productsUpdated'));
    } catch (err) {
      setError(err.message || 'Unable to record vendor pickup');
    } finally {
      setSubmitting(false);
    }
  };

  if (entryMode) {
    const isPickupEntry = entryMode === "pickup";
    const isReturnEntry = entryMode === "return";
    const entryForm = isReturnEntry ? returnForm : pickupForm;
    const selectedVendor = vendors.find((vendor) => String(vendor.id) === String(entryForm.vendor_id));
    const submitLabel = isPickupEntry
      ? (pickupMode === "edit" ? "Update Vendor Pickup" : "Save Vendor Pickup")
      : isReturnEntry ? "Save Vendor Return" : "Record Sale";

    return (
      <div className="dashboard-shell">
        <section className="dashboard-card transaction-entry-page">
          <form onSubmit={isPickupEntry ? submitPickup : isReturnEntry ? submitReturn : submitSale}>
            <header className="transaction-entry-header">
              <div>
                <button type="button" className="transaction-back" onClick={closeTransactionEntry}>← Back to POS</button>
                <span className="transaction-eyebrow">{isPickupEntry ? "Vendor fulfillment" : isReturnEntry ? "Vendor returns" : "Point-of-sale checkout"}</span>
                <h2>{isPickupEntry ? (pickupMode === "edit" ? "Edit Vendor Pickup" : "Add Vendor Pickup") : isReturnEntry ? "Record Vendor Return" : "Record Sale"}</h2>
                <p>{isPickupEntry ? "Choose the vendor, pickup schedule, and every product included in this delivery." : isReturnEntry ? "Choose the vendor, return schedule, and every product included in this return." : "Add products and quantities to create one complete recorded sale."}</p>
              </div>
              <button type="button" className="small-button" onClick={closeTransactionEntry}>Cancel</button>
            </header>

            {error && <p className="error-message">{error}</p>}

            {(isPickupEntry || isReturnEntry) && (
              <section className="transaction-details" aria-label={isReturnEntry ? "Return details" : "Pickup details"}>
                <label>
                  {isReturnEntry ? "Return date" : "Pickup date"}
                  <input type="date" value={isReturnEntry ? returnForm.return_date : pickupForm.pickup_date} onChange={(event) => isReturnEntry ? setReturnForm({ ...returnForm, return_date: event.target.value }) : setPickupForm({ ...pickupForm, pickup_date: event.target.value })} required />
                </label>
                <label>
                  {isReturnEntry ? "Return time" : "Pickup time"}
                  <input type="time" value={isReturnEntry ? returnForm.return_time : pickupForm.pickup_time} onChange={(event) => isReturnEntry ? setReturnForm({ ...returnForm, return_time: event.target.value }) : setPickupForm({ ...pickupForm, pickup_time: event.target.value })} required />
                </label>
                <label className="transaction-vendor-field">
                  Vendor
                  <select value={entryForm.vendor_id} onChange={(event) => isReturnEntry ? setReturnForm({ ...returnForm, vendor_id: event.target.value }) : setPickupForm({ ...pickupForm, vendor_id: event.target.value })} required>
                    <option value="">Select vendor</option>
                    {vendors.map((vendor) => (
                      <option key={vendor.id} value={vendor.id}>
                        {vendor.name} ({vendor.vendor_code || `VND-${String(vendor.id).padStart(4, "0")}`})
                      </option>
                    ))}
                  </select>
                  {selectedVendor && <small>{selectedVendor.vendor_code || `VND-${String(selectedVendor.id).padStart(4, "0")}`}</small>}
                </label>
              </section>
            )}

            <section className="transaction-catalog" aria-label="Product catalog">
              <div className="transaction-catalog-heading">
                <div>
                  <span className="transaction-eyebrow">Products</span>
                  <h3>Build this {isPickupEntry ? "pickup" : isReturnEntry ? "return" : "sale"}</h3>
                  <p>Enter a quantity for each product you want to include.</p>
                </div>
                <label className="transaction-search">
                  <span className="sr-only">Search products</span>
                  <input value={productSearch} onChange={(event) => setProductSearch(event.target.value)} placeholder="Search products or categories" />
                </label>
              </div>

              {filteredCatalogProducts.length === 0 ? (
                <p className="transaction-empty">No products match your search.</p>
              ) : (
                <div className="transaction-product-grid">
                  {filteredCatalogProducts.map((product) => {
                    const quantity = Number(transactionQuantities[product.id] || 0);
                    const stock = Number(product.current_stock || 0);
                    const canAdd = quantity < stock;
                    return (
                      <article className={`transaction-product-card tone-${Number(product.id) % 4}`} key={product.id}>
                        <div className="transaction-product-art">
                          {product.image_url && (
                            <img
                              src={product.image_url}
                              alt={product.name || "Product"}
                              loading="lazy"
                              onError={(event) => {
                                event.currentTarget.style.display = "none";
                                event.currentTarget.nextElementSibling.hidden = false;
                              }}
                            />
                          )}
                          <span aria-hidden="true" hidden={Boolean(product.image_url)}>{String(product.name || "P").slice(0, 1).toUpperCase()}</span>
                        </div>
                        <div className="transaction-product-copy">
                          <span>{product.category || "General"}</span>
                          <h4>{product.name}</h4>
                          <p>{formatCurrency(product.selling_price)} · {stock} {product.unit || "units"} available</p>
                        </div>
                        <div className="transaction-quantity-control">
                          <button type="button" aria-label={`Remove one ${product.name}`} onClick={() => updateTransactionQuantity(product, quantity - 1)} disabled={quantity === 0}>−</button>
                          <label>
                            <span className="sr-only">Quantity for {product.name}</span>
                            <input type="number" min="0" max={stock} value={quantity || ""} placeholder="0" onChange={(event) => updateTransactionQuantity(product, event.target.value)} />
                          </label>
                          <button type="button" aria-label={`Add one ${product.name}`} onClick={() => updateTransactionQuantity(product, quantity + 1)} disabled={!canAdd}>+</button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>

            <aside className="transaction-summary">
              <div>
                <span className="transaction-eyebrow">{isReturnEntry ? "Return summary" : "Order summary"}</span>
                <h3>{transactionItems.length} product{transactionItems.length === 1 ? "" : "s"} · {transactionQuantityTotal} units</h3>
                {transactionItems.length ? (
                  <ul>
                    {transactionItems.map((item) => <li key={item.id}><span>{item.name} <b>×{item.quantity}</b></span><strong>{formatCurrency(item.quantity * Number(item.selling_price || 0))}</strong></li>)}
                  </ul>
                ) : <p>Choose product quantities to build this {isReturnEntry ? "return" : "record"}.</p>}
              </div>
              <div className="transaction-total">
                <span>Total</span>
                <strong>{formatCurrency(transactionTotal)}</strong>
              </div>
              <button className="primary-button" type="submit" disabled={submitting || !transactionItems.length}>
                {submitting ? "Saving…" : submitLabel}
              </button>
            </aside>
          </form>
        </section>
      </div>
    );
  }

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
              <button className="primary-button" onClick={() => { setSaleQuantities({}); setProductSearch(""); setEntryMode("sale"); setError(null); setStatus(null); }}>
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
              <button className="small-button" onClick={() => { resetReturnForm(); setProductSearch(""); setEntryMode("return"); setError(null); setStatus(null); }}>
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
                        <th>Product(s)</th>
                        <th>Date</th>
                        <th>Pickup Time</th>
                        <th>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pickupEntries.map((entry) => (
                        <tr key={`pickup-history-${entry.id}`}>
                          <td data-label="Pickup ID">{entry.id}</td>
                          <td data-label="Vendor ID">{getDisplayVendorId(entry)}</td>
                          <td data-label="Vendor">{entry.vendor_name || entry.vendor_id}</td>
                          <td data-label="Product(s)">{entry.items || "-"}</td>
                          <td data-label="Date">{formatDeliveryDate(entry.delivery_date)}</td>
                          <td data-label="Pickup Time">{entry.delivery_time || "-"}</td>
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
                      <th>Product(s)</th>
                      <th>Date</th>
                      <th>Pickup Time</th>
                      <th>Total</th>
                      {canManagePickupEntries && <th>Action</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {pickupEntries.map((entry) => (
                      <tr key={entry.id}>
                        <td data-label="Vendor ID">{getDisplayVendorId(entry)}</td>
                        <td data-label="Vendor">{entry.vendor_name || entry.vendor_id}</td>
                        <td data-label="Product(s)">{entry.items || "-"}</td>
                        <td data-label="Date">{formatDeliveryDate(entry.delivery_date)}</td>
                        <td data-label="Pickup Time">{entry.delivery_time || "-"}</td>
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
                  <p className="muted-text">Review grouped return records and their products.</p>
                </div>
                <button className="small-button" onClick={() => setReturnsHistoryOpen(false)}>Close</button>
              </div>
              {returnEntries.length === 0 ? (
                <p>No return history available.</p>
              ) : (
                <div className="management-table-wrap">
                  <table>
                    <thead><tr><th>Return ID</th><th>Vendor</th><th>Products</th><th>Date</th><th>Time</th><th>Qty</th><th>Returned Amount</th><th>Action</th></tr></thead>
                    <tbody>{returnEntries.map((entry) => <tr key={entry.id}>
                      <td data-label="Return ID">{entry.id}</td>
                      <td data-label="Vendor">{entry.vendor_name || entry.vendor_id}</td>
                      <td data-label="Products">{entry.items || entry.product_name || entry.product_id}</td>
                      <td data-label="Date">{formatDeliveryDate(entry.return_date)}</td>
                      <td data-label="Time">{entry.return_time}</td>
                      <td data-label="Qty">{entry.quantity}</td>
                      <td data-label="Returned Amount">{formatCurrency(entry.total_product_price_returned)}</td>
                      <td data-label="Action"><button type="button" className="small-button" onClick={async () => {
                        const legacyId = Array.isArray(entry.return_ids) ? entry.return_ids[0] : String(entry.return_ids || entry.id).split(',')[0];
                        const endpoint = entry.return_batch_id
                          ? `/api/vendor-returns/batch/${encodeURIComponent(entry.return_batch_id)}`
                          : `/api/vendor-returns/${legacyId}`;
                        const res = await fetch(apiUrl(endpoint), { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
                        if (res.ok) {
                          setReturnEntries((current) => current.filter((row) => entry.return_batch_id
                            ? row.return_batch_id !== entry.return_batch_id
                            : String(row.id) !== String(entry.id)));
                          setStatus(entry.return_batch_id ? 'Vendor return batch removed successfully.' : 'Vendor return removed successfully.');
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
