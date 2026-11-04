import { useEffect, useMemo, useRef, useState } from "react";
import { apiUrl } from "./api";
import HistoryCalendar from "./HistoryCalendar.jsx";
import { filterHistory, countHistoryDates } from "./historyCalendar.js";
import { formatItemQuantity } from "./productQuantity";
import { packSize, packLabel } from "./deliveryPacks";
import { filterTransactions, transactionFilterOptions } from "./transactionFilters";
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

function formatConfirmationDateTime(value) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-PH", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Manila",
  }).format(parsed);
}

function getManilaBusinessDate() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function PaymentStatusBadge({ status }) {
  const isPaid = String(status || "UNPAID").toUpperCase() === "PAID";
  return <span className={`payment-status-badge ${isPaid ? "is-paid" : "is-unpaid"}`}>{isPaid ? "Paid" : "Unpaid"}</span>;
}

function getDisplayReturnId(entry) {
  if (entry?.return_code) return entry.return_code;
  const firstReturnId = Array.isArray(entry?.return_ids) ? entry.return_ids[0] : entry?.id;
  const numericId = Number(firstReturnId);
  return Number.isInteger(numericId) && numericId > 0
    ? `RTN-${String(numericId).padStart(4, "0")}`
    : String(firstReturnId || "-");
}

function getVendorOptionLabel(vendor) {
  const vendorCode = vendor.vendor_code || `VND-${String(vendor.id).padStart(4, "0")}`;
  const username = vendor.username ? `@${vendor.username}` : "No username";
  return `${vendor.name} (${username}) · ${vendorCode}`;
}

function POS({ token, role, vendorId, viewMode = "pos" }) {
  const REFRESH_INTERVAL_MS = 6000;
  const isPosEntryView = viewMode === "pos";
  const isDeliveriesView = viewMode === "deliveries";
  const isSalesHistoryView = viewMode === "sales-history";
  const canManagePickupEntries = role === "STAFF" && isDeliveriesView;
  const canManagePaymentStatus = ["ADMIN", "STAFF"].includes(role) && isDeliveriesView;
  const [products, setProducts] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [pickupOpen, setPickupOpen] = useState(false);
  const [saleOpen, setSaleOpen] = useState(false);
  const [saleForm, setSaleForm] = useState({ product_id: "", quantity: "1" });
  const [entryMode, setEntryMode] = useState(null);
  const [productSearch, setProductSearch] = useState("");
  const [pickupQuantities, setPickupQuantities] = useState({});
  const [pickupPackModes, setPickupPackModes] = useState({});
  const [saleQuantities, setSaleQuantities] = useState({});
  const [returnQuantities, setReturnQuantities] = useState({});
  const [returnDeliveries, setReturnDeliveries] = useState([]);
  const [returnDeliveriesLoading, setReturnDeliveriesLoading] = useState(false);
  const [returnDeliveriesError, setReturnDeliveriesError] = useState(null);
  const [returnProducts, setReturnProducts] = useState([]);
  const [returnProductsLoading, setReturnProductsLoading] = useState(false);
  const [returnProductsError, setReturnProductsError] = useState(null);
  const [returnEligibilityVersion, setReturnEligibilityVersion] = useState(0);
  const loadedReturnVendorId = useRef(null);
  const loadedReturnDeliveryKey = useRef(null);
  const [pickupEntries, setPickupEntries] = useState([]);
  const [salesHistory, setSalesHistory] = useState([]);
  const [pickupMode, setPickupMode] = useState("create");
  const [editingPickupId, setEditingPickupId] = useState(null);
  const [editingPickupOriginalQuantities, setEditingPickupOriginalQuantities] = useState({});
  const [editingPickupProducts, setEditingPickupProducts] = useState([]);
  const [historyMode, setHistoryMode] = useState(null);
  const [transactionFilters, setTransactionFilters] = useState({ product: "", account: "" });
  const [historySelections, setHistorySelections] = useState(() => Object.fromEntries(
    ['pickups', 'returns', 'payments', 'sales'].map((key) => [key, { mode: 'daily', date: getManilaBusinessDate() }])
  ));
  const activeHistoryKey = historyMode || 'sales';
  const historySelection = historySelections[activeHistoryKey];
  const updateHistorySelection = (selection) => setHistorySelections((current) => ({ ...current, [activeHistoryKey]: selection }));
  const [paymentVendorFilter, setPaymentVendorFilter] = useState("");
  const [returnsOpen, setReturnsOpen] = useState(false);
  const [returnEntries, setReturnEntries] = useState([]);
  const [returnForm, setReturnForm] = useState({
    return_date: getManilaBusinessDate(),
    return_time: "",
    vendor_id: "",
    delivery_id: "",
    product_id: "",
    quantity: "1",
    product_price: "",
    total_product_price_returned: "0.00",
  });
  const [pickupForm, setPickupForm] = useState({
    pickup_date: "",
    pickup_time: "",
    vendor_id: "",
    payment_status: "UNPAID",
    product_id: "",
    quantity: "1",
    category: "",
    unit_price: "",
    total_price: "0.00"
  });
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmingPaymentId, setConfirmingPaymentId] = useState(null);
  const [expandedPaymentIds, setExpandedPaymentIds] = useState(() => new Set());

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

        const records = (body.data || []).slice().sort((a, b) => `${b.delivery_date || ''} ${b.delivery_time || ''} ${b.id}`.localeCompare(`${a.delivery_date || ''} ${a.delivery_time || ''} ${a.id}`));
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
      setReturnEligibilityVersion((current) => current + 1);
    };

    const intervalId = window.setInterval(refreshData, REFRESH_INTERVAL_MS);

    const handleProductsUpdated = () => {
      loadProducts();
      loadVendors();
      loadPickupRecords();
      loadVendorReturns();
      loadSalesHistory();
      setReturnEligibilityVersion((current) => current + 1);
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

  useEffect(() => {
    const selectedVendorId = Number(returnForm.vendor_id);
    if (entryMode !== "return" || !selectedVendorId) {
      loadedReturnVendorId.current = null;
      setReturnDeliveries([]);
      setReturnDeliveriesLoading(false);
      setReturnDeliveriesError(null);
      return undefined;
    }

    let active = true;
    const controller = new AbortController();
    const isInitialVendorLoad = loadedReturnVendorId.current !== selectedVendorId;
    if (isInitialVendorLoad) setReturnDeliveriesLoading(true);
    setReturnDeliveriesError(null);

    fetch(apiUrl(`/api/vendor-returns/eligible-deliveries?vendor_id=${encodeURIComponent(selectedVendorId)}`), {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Unable to load today's deliveries");
        if (active) {
          loadedReturnVendorId.current = selectedVendorId;
          if (body.business_date) {
            setReturnForm((current) => ({ ...current, return_date: body.business_date }));
          }
          setReturnDeliveries(body.data || []);
        }
      })
      .catch((fetchError) => {
        if (active && fetchError.name !== "AbortError") {
          if (isInitialVendorLoad) {
            setReturnDeliveries([]);
            setReturnDeliveriesError(fetchError.message || "Unable to load today's deliveries");
          }
        }
      })
      .finally(() => {
        if (active) setReturnDeliveriesLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [token, entryMode, returnForm.vendor_id, returnEligibilityVersion]);

  useEffect(() => {
    const selectedVendorId = Number(returnForm.vendor_id);
    const selectedDeliveryId = Number(returnForm.delivery_id);
    if (entryMode !== "return" || !selectedVendorId || !selectedDeliveryId) {
      loadedReturnDeliveryKey.current = null;
      setReturnProducts([]);
      setReturnProductsLoading(false);
      setReturnProductsError(null);
      return undefined;
    }

    let active = true;
    const controller = new AbortController();
    const deliveryKey = `${selectedVendorId}-${selectedDeliveryId}`;
    const isInitialDeliveryLoad = loadedReturnDeliveryKey.current !== deliveryKey;
    if (isInitialDeliveryLoad) {
      setReturnProducts([]);
      setReturnProductsLoading(true);
    }
    setReturnProductsError(null);

    fetch(apiUrl(`/api/vendor-returns/eligible-products?vendor_id=${encodeURIComponent(selectedVendorId)}&delivery_id=${encodeURIComponent(selectedDeliveryId)}`), {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Unable to load delivered products");
        if (!active) return;
        const deliveredProducts = body.data || [];
        const returnableByProduct = new Map(deliveredProducts.map((product) => [String(product.id), Number(product.returnable_quantity || 0)]));
        loadedReturnDeliveryKey.current = deliveryKey;
        setReturnProducts(deliveredProducts);
        setReturnQuantities((current) => Object.fromEntries(
          Object.entries(current)
            .filter(([productId]) => returnableByProduct.has(String(productId)))
            .map(([productId, quantity]) => [productId, Math.min(Number(quantity || 0), returnableByProduct.get(String(productId)))])
        ));
      })
      .catch((fetchError) => {
        if (active && fetchError.name !== "AbortError") {
          if (isInitialDeliveryLoad) {
            setReturnProducts([]);
            setReturnProductsError(fetchError.message || "Unable to load delivered products");
          }
        }
      })
      .finally(() => {
        if (active) setReturnProductsLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [token, entryMode, returnForm.vendor_id, returnForm.delivery_id, returnEligibilityVersion]);

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
  const catalogProducts = useMemo(() => {
    if (entryMode === "return") return returnProducts;
    if (entryMode !== "pickup" || pickupMode !== "edit") return products;
    const merged = new Map(products.map((product) => [Number(product.id), product]));
    // Existing delivery lines remain editable even after catalog deletion. They
    // are never added back to the ordinary product catalog or new transactions.
    for (const product of editingPickupProducts) merged.set(Number(product.id), product);
    return [...merged.values()];
  }, [entryMode, pickupMode, products, returnProducts, editingPickupProducts]);
  const filteredCatalogProducts = useMemo(() => {
    const search = productSearch.trim().toLowerCase();
    if (!search) return catalogProducts;
    return catalogProducts.filter((product) => [product.name, product.category, product.unit]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(search)));
  }, [catalogProducts, productSearch]);

  const transactionItems = useMemo(() => catalogProducts
    .map((product) => ({ ...product, quantity: Number(transactionQuantities[product.id] || 0), entry_unit: entryMode === "pickup" ? (pickupPackModes[product.id] || "item") : "item" }))
    .map((product) => ({ ...product, entry_quantity: product.quantity / (packSize(product, product.entry_unit) || 1) }))
    .filter((product) => Number.isInteger(product.quantity) && product.quantity > 0), [catalogProducts, transactionQuantities, entryMode, pickupPackModes]);

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
  const selectedReturnDelivery = useMemo(
    () => returnDeliveries.find((delivery) => String(delivery.id) === String(returnForm.delivery_id)) || null,
    [returnDeliveries, returnForm.delivery_id]
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
      payment_status: "UNPAID",
      product_id: "",
      quantity: "1",
      category: "",
      unit_price: "",
      total_price: "0.00"
    });
    setEditingPickupId(null);
    setPickupMode("create");
    setPickupQuantities({});
    setPickupPackModes({});
    setEditingPickupOriginalQuantities({});
    setEditingPickupProducts([]);
  };

  const updateTransactionQuantity = (product, nextValue) => {
    const parsed = Number(nextValue);
    // When changing an existing pickup, its original quantities are restored
    // before the replacement is saved. They must therefore remain available
    // in the editor even though they are not part of current displayed stock.
    const availableStock = entryMode === "return"
      ? Number(product.returnable_quantity || 0)
      : entryMode === "pickup" && pickupMode === "edit"
        ? (product.deleted_at || Number(product.active) !== 1 ? 0 : Number(product.current_stock || 0)) + Number(editingPickupOriginalQuantities[product.id] || 0)
        : Number(product.current_stock || 0);
    const multiplier = entryMode === "pickup" ? packSize(product, pickupPackModes[product.id] || "item") : 1;
    const quantity = Number.isFinite(parsed) && multiplier ? Math.max(0, Math.min(Math.trunc(parsed / multiplier), Math.floor(availableStock / multiplier))) * multiplier : 0;
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
      return_date: getManilaBusinessDate(),
      return_time: "",
      vendor_id: "",
      delivery_id: "",
      product_id: "",
      quantity: "1",
      product_price: "",
      total_product_price_returned: "0.00",
    });
    setReturnQuantities({});
    setReturnDeliveries([]);
    setReturnDeliveriesError(null);
    setReturnDeliveriesLoading(false);
    setReturnProducts([]);
    setReturnProductsError(null);
    setReturnProductsLoading(false);
    loadedReturnVendorId.current = null;
    loadedReturnDeliveryKey.current = null;
  };

  const handleTransactionVendorChange = (event, isReturnEntry) => {
    const nextVendorId = event.target.value;
    if (isReturnEntry) {
      setReturnForm((current) => ({ ...current, vendor_id: nextVendorId, delivery_id: "" }));
      setReturnQuantities({});
      setReturnDeliveries([]);
      setReturnDeliveriesError(null);
      setReturnProducts([]);
      setReturnProductsError(null);
      loadedReturnDeliveryKey.current = null;
      loadedReturnVendorId.current = null;
      setProductSearch("");
      return;
    }
    setPickupForm((current) => ({ ...current, vendor_id: nextVendorId }));
  };

  const handleReturnDeliveryChange = (event) => {
    const nextDeliveryId = event.target.value;
    setReturnForm((current) => ({ ...current, delivery_id: nextDeliveryId }));
    setReturnQuantities({});
    setReturnProducts([]);
    setReturnProductsError(null);
    loadedReturnDeliveryKey.current = null;
    setProductSearch("");
  };

  const handleConfirmPayment = async (entry) => {
    setError(null);
    setStatus(null);
    setConfirmingPaymentId(entry.id);

    try {
      const res = await fetch(apiUrl(`/api/deliveries/${entry.id}/confirm-payment`), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || "Unable to confirm delivery payment.");
      }

      setPickupEntries((current) => current.map((record) => Number(record.id) === Number(entry.id)
        ? { ...record, ...body.data }
        : record));
      setStatus(`Payment confirmed for delivery #${entry.id}.`);
    } catch (err) {
      setError(err.message || "Unable to confirm delivery payment.");
    } finally {
      setConfirmingPaymentId(null);
    }
  };

  const togglePaymentProducts = (deliveryId) => {
    setExpandedPaymentIds((current) => {
      const next = new Set(current);
      if (next.has(deliveryId)) next.delete(deliveryId);
      else next.add(deliveryId);
      return next;
    });
  };

  const filteredPickupHistory = isSalesHistoryView ? filterTransactions(pickupEntries, transactionFilters) : pickupEntries;
  const filteredRecordedHistory = isSalesHistoryView ? filterTransactions(salesHistory, transactionFilters) : salesHistory;
  const transactionOptions = transactionFilterOptions([...salesHistory, ...pickupEntries], products);
  const visiblePickupEntries = filterHistory(filteredPickupHistory, 'delivery_date', historySelection);
  const visibleReturnEntries = filterHistory(returnEntries, 'return_date', historySelection);
  const visibleSalesHistory = filterHistory(filteredRecordedHistory, 'sale_date', historySelection);
  const historyEmptySuffix = historySelection.mode === 'daily'
    ? ` for ${formatDeliveryDate(historySelection.date)}` : '';

  if (historyMode) {
    const isPickupHistory = historyMode === 'pickups';
    const isPaymentHistory = historyMode === 'payments';
    const title = isPaymentHistory ? 'Delivery Payment Status' : isPickupHistory ? 'Vendor Pickup List' : 'Vendor Return History';
    const description = isPaymentHistory
      ? 'Confirm vendor delivery payments and review who completed each confirmation.'
      : isPickupHistory
        ? 'Review every vendor pickup and the products included in each delivery.'
        : 'Review grouped return records and every product included in each return.';
    const paymentVendorOptions = [...new Map(pickupEntries.map((entry) => [String(entry.vendor_id), {
      id: entry.vendor_id,
      name: entry.vendor_name || `Vendor ${entry.vendor_id}`,
      vendor_code: getDisplayVendorId(entry),
    }])).values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const vendorPaymentEntries = paymentVendorFilter
      ? pickupEntries.filter((entry) => String(entry.vendor_id) === String(paymentVendorFilter))
      : pickupEntries;
    const filteredPaymentEntries = filterHistory(vendorPaymentEntries, 'delivery_date', historySelection);
    const paidDeliveryCount = filteredPaymentEntries.filter((entry) => String(entry.payment_status || 'UNPAID').toUpperCase() === 'PAID').length;
    const unpaidDeliveryCount = filteredPaymentEntries.length - paidDeliveryCount;
    const outstandingPaymentAmount = filteredPaymentEntries
      .filter((entry) => String(entry.payment_status || 'UNPAID').toUpperCase() !== 'PAID')
      .reduce((sum, entry) => sum + Number(entry.amount_due ?? entry.total_amount ?? 0), 0);

    return (
      <div className="dashboard-shell">
        <section className="dashboard-card transaction-entry-page transaction-history-page">
          <header className="transaction-entry-header">
            <div>
              <button type="button" className="transaction-back" onClick={() => setHistoryMode(null)}>← Back to Deliveries</button>
              <span className="transaction-eyebrow">{isPaymentHistory ? 'Payment confirmations' : isPickupHistory ? 'Delivery records' : 'Return records'}</span>
              <h2>{title}</h2>
              <p>{description}</p>
            </div>
            <button type="button" className="small-button" onClick={() => setHistoryMode(null)}>Back to Deliveries</button>
          </header>

          {error && <p className="error-message">{error}</p>}
          {status && <p className="success-message">{status}</p>}

          <HistoryCalendar selection={historySelection} onChange={updateHistorySelection}
            dateCounts={countHistoryDates(isPaymentHistory ? vendorPaymentEntries : isPickupHistory ? pickupEntries : returnEntries, isPickupHistory || isPaymentHistory ? 'delivery_date' : 'return_date')}
            recordCount={isPaymentHistory ? filteredPaymentEntries.length : isPickupHistory ? visiblePickupEntries.length : visibleReturnEntries.length} />

          <section className="transaction-history-list">
            <div className="transaction-history-heading">
              <div>
                <span className="transaction-eyebrow">{isPaymentHistory ? 'Payment status' : isPickupHistory ? 'Pickup history' : 'Return history'}</span>
                <h3>{isPaymentHistory ? `${filteredPaymentEntries.length} delivery account${filteredPaymentEntries.length === 1 ? '' : 's'}` : isPickupHistory ? `${visiblePickupEntries.length} delivery record${visiblePickupEntries.length === 1 ? '' : 's'}` : `${visibleReturnEntries.length} return record${visibleReturnEntries.length === 1 ? '' : 's'}`}</h3>
              </div>
              {isPaymentHistory && (
                <div className="payment-history-controls">
                  <label className="payment-vendor-filter">
                    <span>Filter by vendor</span>
                    <select value={paymentVendorFilter} onChange={(event) => setPaymentVendorFilter(event.target.value)}>
                      <option value="">All vendors</option>
                      {paymentVendorOptions.map((vendor) => <option key={vendor.id} value={vendor.id}>{vendor.name} · {vendor.vendor_code}</option>)}
                    </select>
                  </label>
                  <div className="payment-status-summary" aria-label="Filtered payment status totals">
                    <span className="is-paid"><b>{paidDeliveryCount}</b> Paid</span>
                    <span className="is-unpaid"><b>{unpaidDeliveryCount}</b> Unpaid</span>
                    <span className="is-due"><b>{formatCurrency(outstandingPaymentAmount)}</b> Outstanding</span>
                  </div>
                </div>
              )}
            </div>

            {isPaymentHistory ? (
              filteredPaymentEntries.length === 0 ? <p className="transaction-empty">No delivery accounts{paymentVendorFilter ? ' for the selected vendor' : ''}{historyEmptySuffix}.</p> : (
                <div className="payment-status-board">
                  {filteredPaymentEntries.map((entry) => {
                    const isPaid = String(entry.payment_status || 'UNPAID').toUpperCase() === 'PAID';
                    const isExpanded = expandedPaymentIds.has(entry.id);
                    const amountDue = Number(entry.amount_due ?? entry.total_amount ?? 0);
                    const returnDeduction = Number(entry.return_deduction || 0);
                    const productItems = String(entry.items || '').split(',').map((item) => item.trim()).filter(Boolean);
                    return <article className={`payment-account-card ${isPaid ? 'is-paid' : 'is-unpaid'} ${isExpanded ? 'is-expanded' : ''}`} key={`payment-${entry.id}`}>
                      <div className="payment-account-main">
                        <div className="payment-account-identity">
                          <span className="payment-delivery-number">#{entry.id}</span>
                          <div>
                            <span className="payment-card-label">Delivery account</span>
                            <h4>{entry.vendor_name || entry.vendor_id}</h4>
                            <small>{getDisplayVendorId(entry)}</small>
                          </div>
                        </div>

                        <div className="payment-account-amounts" aria-label={`Amounts for delivery ${entry.id}`}>
                          <div><span>Original</span><strong>{formatCurrency(entry.original_amount ?? entry.total_amount)}</strong></div>
                          <div className={returnDeduction > 0 ? 'has-deduction' : ''}><span>Returns</span><strong>-{formatCurrency(returnDeduction)}</strong></div>
                          <div className="is-due"><span>Amount due</span><strong>{formatCurrency(amountDue)}</strong></div>
                        </div>

                        <div className="payment-account-meta">
                          <PaymentStatusBadge status={entry.payment_status} />
                          <div className="payment-account-date"><span>Recorded</span><strong>{formatDeliveryDate(entry.delivery_date)}</strong><small>{entry.delivery_time || 'No time recorded'}</small></div>
                          {isPaid && <small className="payment-confirmation-note">Confirmed by {entry.payment_confirmed_by_name || 'authorized user'}<br />{formatConfirmationDateTime(entry.payment_confirmed_at)}</small>}
                        </div>

                        <div className="payment-row-actions">
                          <button type="button" className="payment-products-button" aria-expanded={isExpanded} onClick={() => togglePaymentProducts(entry.id)}>
                            <span>{isExpanded ? 'Hide Products' : 'Show Products'}</span><b aria-hidden="true">{isExpanded ? '−' : '+'}</b>
                          </button>
                          <button type="button" className="payment-confirm-button" disabled={isPaid || amountDue <= 0 || confirmingPaymentId === entry.id} onClick={() => handleConfirmPayment(entry)}>{confirmingPaymentId === entry.id ? 'Confirming…' : isPaid ? 'Payment Confirmed' : amountDue <= 0 ? 'No Amount Due' : 'Confirm Payment'}</button>
                        </div>
                      </div>

                      {isExpanded && <div className="payment-product-drawer">
                        <div className="payment-product-drawer-heading"><div><span>Delivery contents</span><strong>Products in delivery #{entry.id}</strong></div><small>{productItems.length} product line{productItems.length === 1 ? '' : 's'}</small></div>
                        {productItems.length ? <div className="payment-product-chips">{productItems.map((item, index) => <span key={`${entry.id}-${index}`}>{item}</span>)}</div> : <p>No product details available.</p>}
                      </div>}
                    </article>;
                  })}
                </div>
              )
            ) : isPickupHistory ? (
              visiblePickupEntries.length === 0 ? <p className="transaction-empty">No vendor pickups{historyEmptySuffix}.</p> : (
                <div className="management-table-wrap">
                  <table>
                    <thead><tr><th>Vendor ID</th><th>Vendor</th><th>Product(s)</th><th>Date</th><th>Pickup Time</th><th>Total</th><th>Payment</th>{canManagePickupEntries && <th>Action</th>}</tr></thead>
                    <tbody>{visiblePickupEntries.map((entry) => <tr key={entry.id}>
                      <td data-label="Vendor ID">{getDisplayVendorId(entry)}</td>
                      <td data-label="Vendor">{entry.vendor_name || entry.vendor_id}</td>
                      <td data-label="Product(s)">{entry.items || '-'}</td>
                      <td data-label="Date">{formatDeliveryDate(entry.delivery_date)}</td>
                      <td data-label="Pickup Time">{entry.delivery_time || '-'}</td>
                      <td data-label="Total">{formatCurrency(entry.total_amount)}</td>
                      <td data-label="Payment"><PaymentStatusBadge status={entry.payment_status} /></td>
                      {canManagePickupEntries && <td data-label="Action" className="transaction-history-actions"><button type="button" className="small-button" onClick={() => openEditPickup(entry)}>Edit</button><button type="button" className="small-button" onClick={() => handleDeletePickup(entry.id)}>Delete</button></td>}
                    </tr>)}</tbody>
                  </table>
                </div>
              )
            ) : (
              visibleReturnEntries.length === 0 ? <p className="transaction-empty">No return records{historyEmptySuffix}.</p> : (
                <div className="management-table-wrap">
                  <table>
                    <thead><tr><th>Return ID</th><th>Delivery #</th><th>Vendor</th><th>Products</th><th>Date</th><th>Time</th><th>Qty</th><th>Returned Amount</th></tr></thead>
                    <tbody>{visibleReturnEntries.map((entry) => <tr key={entry.id}>
                      <td data-label="Return ID">{getDisplayReturnId(entry)}</td>
                      <td data-label="Delivery #">{entry.delivery_id ? `#${entry.delivery_id}` : 'Legacy'}</td>
                      <td data-label="Vendor">{entry.vendor_name || entry.vendor_id}</td>
                      <td data-label="Products">{entry.items || entry.product_name || entry.product_id}</td>
                      <td data-label="Date">{formatDeliveryDate(entry.return_date)}</td>
                      <td data-label="Time">{entry.return_time}</td>
                      <td data-label="Qty">{entry.quantity}</td>
                      <td data-label="Returned Amount">{formatCurrency(entry.total_product_price_returned)}</td>
                    </tr>)}</tbody>
                  </table>
                </div>
              )
            )}
          </section>
        </section>
      </div>
    );
  }

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
      setStatus(`Sale recorded with ${transactionItems.length} product${transactionItems.length === 1 ? '' : 's'} and ${formatItemQuantity(transactionQuantityTotal)} in total.`);
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

  async function openEditPickup(record) {
    if (!canManagePickupEntries) return;
    try {
      const detailRes = await fetch(apiUrl(`/api/deliveries/${record.id}`), {
        headers: { Authorization: `Bearer ${token}` },
      });
      const detailBody = await detailRes.json();
      if (!detailRes.ok) {
        throw new Error(detailBody.error || "Unable to load pickup details");
      }
      const items = detailBody.data?.items || [];
      const originalProducts = await Promise.all(items.map(async (item) => {
        const response = await fetch(apiUrl(`/api/products/${item.product_id}`), { headers: { Authorization: `Bearer ${token}` } });
        const body = await response.json();
        if (!response.ok || !body.data) throw new Error(body.error || 'Unable to load an original delivery product');
        return { ...body.data, selling_price: Number(item.unit_cost) };
      }));
      setEditingPickupProducts(originalProducts);
      setEditingPickupId(record.id);
      setPickupMode("edit");
      setPickupForm({
        pickup_date: String(detailBody.data?.delivery_date || record.delivery_date || "").slice(0, 10),
        pickup_time: detailBody.data?.delivery_time || record.delivery_time || "09:00",
        vendor_id: String(detailBody.data?.vendor_id ?? record.vendor_id ?? ""),
        payment_status: String(detailBody.data?.payment_status || record.payment_status || "UNPAID").toUpperCase(),
        product_id: "",
        quantity: "1",
        category: "",
        unit_price: "",
        total_price: "0.00",
      });
      const originalQuantities = Object.fromEntries(items.map((item) => [item.product_id, Number(item.quantity || 0)]));
      setPickupQuantities(originalQuantities);
      // Open existing deliveries in Items; this also supports mixed legacy lines.
      setPickupPackModes({});
      setEditingPickupOriginalQuantities(originalQuantities);
      setHistoryMode(null);
      setEntryMode("pickup");
      setProductSearch("");
      setError(null);
      setStatus(null);
    } catch (err) {
      setError(err.message || "Unable to edit pickup");
    }
  }

  async function handleDeletePickup(pickupId) {
    if (!canManagePickupEntries) return;
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
        const records = (newBody.data || []).slice().sort((a, b) => `${b.delivery_date || ''} ${b.delivery_time || ''} ${b.id}`.localeCompare(`${a.delivery_date || ''} ${a.delivery_time || ''} ${a.id}`));
        setPickupEntries(records);
      }
    } catch (err) {
      setError(err.message || 'Unable to delete vendor pickup');
    }
  }

  const submitReturn = async (event) => {
    event.preventDefault();
    setError(null);
    setStatus(null);

    const vendorId = Number(returnForm.vendor_id);
    const deliveryId = Number(returnForm.delivery_id);

    if (!returnForm.return_date || !returnForm.return_time) {
      setError("Return date and return time are required.");
      return;
    }
    if (!vendorId) {
      setError("Please select a vendor.");
      return;
    }
    if (!deliveryId) {
      setError("Please select one of this vendor's deliveries from today.");
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
          delivery_id: deliveryId,
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
      const primaryReturnId = body.data?.return_id || returnedItems[0]?.id;
      const returnBatch = {
        id: primaryReturnId,
        return_code: body.data?.return_code || (primaryReturnId ? `RTN-${String(primaryReturnId).padStart(4, "0")}` : null),
        return_batch_id: body.data?.return_batch_id || null,
        vendor_id: vendorId,
        delivery_id: deliveryId,
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
      entry_unit: item.entry_unit,
      entry_quantity: item.entry_quantity,
    }));

    setSubmitting(true);
    try {
      if (pickupMode === "edit" && editingPickupId) {
        if (!canManagePickupEntries) throw new Error('Only Staff can edit vendor pickups.');
        const staffPassword = window.prompt('Enter your Staff password to confirm this pickup update:');
        if (!staffPassword || !staffPassword.trim()) {
          throw new Error('Staff verification password is required');
        }

        const verifyRes = await fetch(apiUrl('/api/users/verify-staff'), {
          method: 'POST',
          headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ password: staffPassword }),
        });
        const verifyBody = await verifyRes.json().catch(() => ({}));
        if (!verifyRes.ok) {
          throw new Error(verifyBody.error || 'Staff verification failed');
        }

        const res = await fetch(apiUrl(`/api/deliveries/${editingPickupId}`), {
          method: 'PUT',
          headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            vendor_id: Number(pickupForm.vendor_id),
            pickup_datetime: `${pickupForm.pickup_date}T${pickupForm.pickup_time}`,
            delivery_date: pickupForm.pickup_date,
            payment_status: pickupForm.payment_status,
            items: deliveryItems,
          }),
        });
        const body = await res.json();
        if (!res.ok) {
          throw new Error(body.error || 'Unable to update vendor pickup');
        }
        setPickupEntries((current) => current.map((record) => Number(record.id) === Number(editingPickupId) ? {
          ...record,
          ...body.data,
          items: (body.data?.items || []).map((item) => `${item.product_name || item.product_id} (${item.quantity})`).join(', '),
        } : record));
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
                <p>{isPickupEntry ? "Choose the vendor, pickup schedule, and every product included in this delivery." : isReturnEntry ? "Choose a vendor, select one of today's deliveries, then record its returned products." : "Add products and quantities to create one complete recorded sale."}</p>
              </div>
              <button type="button" className="small-button" onClick={closeTransactionEntry}>Cancel</button>
            </header>

            {error && <p className="error-message">{error}</p>}

            {(isPickupEntry || isReturnEntry) && (
              <section className={`transaction-details ${isPickupEntry && pickupMode === "edit" ? "has-payment-status" : ""} ${isReturnEntry ? "is-return-details" : ""}`} aria-label={isReturnEntry ? "Return details" : "Pickup details"}>
                <label>
                  {isReturnEntry ? "Return date" : "Pickup date"}
                  <input type="date" value={isReturnEntry ? returnForm.return_date : pickupForm.pickup_date} onChange={(event) => isReturnEntry ? setReturnForm({ ...returnForm, return_date: event.target.value }) : setPickupForm({ ...pickupForm, pickup_date: event.target.value })} readOnly={isReturnEntry} min={isReturnEntry ? returnForm.return_date : undefined} max={isReturnEntry ? returnForm.return_date : undefined} required />
                </label>
                <label>
                  {isReturnEntry ? "Return time" : "Pickup time"}
                  <input type="time" value={isReturnEntry ? returnForm.return_time : pickupForm.pickup_time} onChange={(event) => isReturnEntry ? setReturnForm({ ...returnForm, return_time: event.target.value }) : setPickupForm({ ...pickupForm, pickup_time: event.target.value })} required />
                </label>
                <label className="transaction-vendor-field">
                  Vendor
                  <select value={entryForm.vendor_id} onChange={(event) => handleTransactionVendorChange(event, isReturnEntry)} required>
                    <option value="">Select vendor</option>
                    {vendors.map((vendor) => (
                      <option key={vendor.id} value={vendor.id}>
                        {getVendorOptionLabel(vendor)}
                      </option>
                    ))}
                  </select>
                  {selectedVendor && <small>{selectedVendor.username ? `@${selectedVendor.username} · ` : ""}{selectedVendor.vendor_code || `VND-${String(selectedVendor.id).padStart(4, "0")}`}</small>}
                </label>
                {isReturnEntry && (
                  <label className="transaction-delivery-field">
                    Delivery
                    <select value={returnForm.delivery_id} onChange={handleReturnDeliveryChange} disabled={!returnForm.vendor_id || returnDeliveriesLoading} required>
                      <option value="">{returnDeliveriesLoading ? "Loading today's deliveries…" : "Select delivery"}</option>
                      {returnDeliveries.map((delivery) => {
                        const paid = String(delivery.payment_status || "UNPAID").toUpperCase() === "PAID";
                        return <option key={delivery.id} value={delivery.id} disabled={paid || !delivery.returnable}>
                          #{delivery.id} · {delivery.delivery_time || "No time"} · {formatCurrency(delivery.amount_due)} · {paid ? "Paid (closed)" : "Unpaid"}
                        </option>;
                      })}
                    </select>
                    {returnDeliveriesError
                      ? <small className="transaction-field-error">{returnDeliveriesError}</small>
                      : selectedReturnDelivery
                        ? <small>Original {formatCurrency(selectedReturnDelivery.original_amount)} · Previous returns -{formatCurrency(selectedReturnDelivery.return_deduction)} · Due {formatCurrency(selectedReturnDelivery.amount_due)}</small>
                        : returnForm.vendor_id && !returnDeliveriesLoading && <small>{returnDeliveries.length ? "Paid deliveries are shown but closed for returns." : "No deliveries were recorded for this vendor today."}</small>}
                  </label>
                )}
                {isPickupEntry && pickupMode === "edit" && (
                  <label className="transaction-payment-field">
                    Payment status
                    <select value={pickupForm.payment_status} onChange={(event) => setPickupForm({ ...pickupForm, payment_status: event.target.value })}>
                      <option value="UNPAID">Unpaid</option>
                      <option value="PAID">Paid</option>
                    </select>
                    <small>Paid records retain who confirmed the payment and when.</small>
                  </label>
                )}
              </section>
            )}

            <section className="transaction-catalog" aria-label="Product catalog">
              <div className="transaction-catalog-heading">
                <div>
                  <span className="transaction-eyebrow">Products</span>
                  <h3>{isReturnEntry && !entryForm.vendor_id ? "Select a vendor first" : isReturnEntry && !returnForm.delivery_id ? "Select a delivery" : `Build this ${isPickupEntry ? "pickup" : isReturnEntry ? "return" : "sale"}`}</h3>
                  <p>{isReturnEntry
                    ? !entryForm.vendor_id
                      ? "Choose a vendor above to load all deliveries recorded today."
                      : !returnForm.delivery_id
                        ? "Choose an unpaid delivery above to load only the products included in it."
                        : "Only products from the selected delivery are shown. Enter the quantity being returned."
                    : "Enter a quantity for each product you want to include."}</p>
                </div>
                {(!isReturnEntry || returnForm.delivery_id) && (
                  <label className="transaction-search">
                    <span className="sr-only">Search products</span>
                    <input value={productSearch} onChange={(event) => setProductSearch(event.target.value)} placeholder="Search products or categories" />
                  </label>
                )}
              </div>

              {isReturnEntry && !entryForm.vendor_id ? (
                <div className="transaction-vendor-required">
                  <span aria-hidden="true">↖</span>
                  <div><strong>Vendor selection required</strong><p>Choose a vendor to load today's delivery records.</p></div>
                </div>
              ) : isReturnEntry && !returnForm.delivery_id ? (
                <div className="transaction-vendor-required">
                  <span aria-hidden="true">↓</span>
                  <div><strong>Delivery selection required</strong><p>Choose an unpaid delivery to view its products and available return quantities.</p></div>
                </div>
              ) : isReturnEntry && returnProductsLoading ? (
                <p className="transaction-empty">Loading products delivered to this vendor...</p>
              ) : isReturnEntry && returnProductsError ? (
                <p className="transaction-empty transaction-empty-error">{returnProductsError}</p>
              ) : filteredCatalogProducts.length === 0 ? (
                <p className="transaction-empty">{isReturnEntry && !productSearch ? "This delivery has no products remaining for return." : "No products match your search."}</p>
              ) : (
                <div className="transaction-product-grid">
                  {filteredCatalogProducts.map((product) => {
                    const quantity = Number(transactionQuantities[product.id] || 0);
                    const packMode = entryMode === "pickup" ? pickupPackModes[product.id] || "item" : "item";
                    const multiplier = packSize(product, packMode) || 1;
                    const packQuantity = quantity / multiplier;
                    const stock = Number(product.current_stock || 0);
                    const availableStock = isReturnEntry
                      ? Number(product.returnable_quantity || 0)
                      : entryMode === "pickup" && pickupMode === "edit"
                        ? (product.deleted_at || Number(product.active) !== 1 ? 0 : stock) + Number(editingPickupOriginalQuantities[product.id] || 0)
                        : stock;
                    const canAdd = quantity + multiplier <= availableStock;
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
                          {product.volume_ml != null && <small className="transaction-size-note">{Number(product.volume_ml).toLocaleString()} mL{product.quantity_per_case ? ` · ${product.quantity_per_case} Items / case` : ""}</small>}
                          <p>{formatCurrency(product.selling_price)} · {isReturnEntry ? `${formatItemQuantity(product.delivered_quantity)} delivered` : `${formatItemQuantity(availableStock)} available`}</p>
                          {product.deleted_at && !isReturnEntry && <small className="removed-product-note">Deleted product · existing delivery only</small>}
                          {isReturnEntry && Number(product.returned_quantity || 0) > 0 && (
                            <small className="transaction-return-balance">{Number(product.returned_quantity)} returned · {availableStock} remaining</small>
                          )}
                        </div>
                        {entryMode === "pickup" && <div className="transaction-pack-choice">
                          <label>Deliver by<select aria-label={`Delivery basis for ${product.name}`} value={packMode} onChange={(event) => {
                            setPickupPackModes((current) => ({ ...current, [product.id]: event.target.value }));
                            setPickupQuantities((current) => ({ ...current, [product.id]: 0 }));
                          }}>
                            <option value="item">Item</option>
                            <option value="half-case" disabled={!packSize(product, "half-case")}>Half-case{packSize(product, "half-case") ? ` (${packSize(product, "half-case")} Items)` : " (unavailable)"}</option>
                            <option value="case" disabled={!packSize(product, "case")}>Case{packSize(product, "case") ? ` (${packSize(product, "case")} Items)` : " (set case size)"}</option>
                          </select></label>
                          <small>{formatCurrency(multiplier * Number(product.selling_price))} / {packMode === "item" ? "Item" : packMode} · {formatItemQuantity(quantity)} selected</small>
                        </div>}
                        <div className="transaction-quantity-control">
                          <button type="button" aria-label={`Remove one ${product.name}`} onClick={() => updateTransactionQuantity(product, quantity - multiplier)} disabled={quantity === 0}>−</button>
                          <label>
                            <span className="sr-only">Quantity for {product.name}</span>
                            <input type="number" min="0" step="1" max={Math.floor(availableStock / multiplier)} value={packQuantity || ""} placeholder="0" onChange={(event) => updateTransactionQuantity(product, Number(event.target.value) * multiplier)} />
                          </label>
                          <button type="button" aria-label={`Add one ${product.name}`} onClick={() => updateTransactionQuantity(product, quantity + multiplier)} disabled={!canAdd}>+</button>
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
                <h3>{transactionItems.length} product{transactionItems.length === 1 ? "" : "s"} · {formatItemQuantity(transactionQuantityTotal)}</h3>
                {transactionItems.length ? (
                  <ul>
                    {transactionItems.map((item) => <li key={item.id}><span>{item.name} <b>×{item.quantity}</b>{item.entry_unit !== "item" && <small className="transaction-pack-summary">{packLabel(item.entry_unit, item.entry_quantity)} · {formatItemQuantity(item.quantity)}</small>}</span><strong>{formatCurrency(item.quantity * Number(item.selling_price || 0))}</strong></li>)}
                  </ul>
                ) : <p>Choose product quantities to build this {isReturnEntry ? "return" : "record"}.</p>}
              </div>
              {isReturnEntry && selectedReturnDelivery && (
                <div className="return-delivery-calculation">
                  <div><span>Current amount due</span><strong>{formatCurrency(selectedReturnDelivery.amount_due)}</strong></div>
                  <div><span>This return deduction</span><strong>-{formatCurrency(transactionTotal)}</strong></div>
                  <div className="is-result"><span>Updated amount due</span><strong>{formatCurrency(Math.max(Number(selectedReturnDelivery.amount_due || 0) - transactionTotal, 0))}</strong></div>
                </div>
              )}
              <div className="transaction-total">
                <span>{isReturnEntry ? "Return Total" : "Total"}</span>
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
            <h2>{isSalesHistoryView ? "Sales & Pickup History" : isDeliveriesView ? "Deliveries" : "Direct-to-Vendor POS"}</h2>
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
              <button className="small-button" onClick={() => { setHistoryMode('pickups'); setError(null); setStatus(null); }}>
                Vendor Pickup List
              </button>
            )}
            {canManagePaymentStatus && (
              <button className="small-button payment-status-nav-button" onClick={() => { setPaymentVendorFilter(''); setHistoryMode('payments'); setError(null); setStatus(null); }}>
                Payment Status
              </button>
            )}
            {isDeliveriesView && role !== "VENDOR" && (
              <button className="small-button" onClick={() => { resetReturnForm(); setProductSearch(""); setEntryMode("return"); setError(null); setStatus(null); }}>
                Record Return
              </button>
            )}
            {isDeliveriesView && (
              <button className="small-button" onClick={() => { setHistoryMode('returns'); setError(null); setStatus(null); }}>
                Return History
              </button>
            )}
          </div>
        </div>

        {status && <p className="success-message">{status}</p>}
        {error && <p className="error-message">{error}</p>}

        {isSalesHistoryView && (
          <div className="history-sections">
            <section className="transaction-history-filters" aria-label="Filter sales and pickup history">
              <label>Product<select value={transactionFilters.product} onChange={(event) => setTransactionFilters((current) => ({ ...current, product: event.target.value }))}>
                <option value="">All products</option>
                {transactionOptions.products.map((product) => <option key={product.id} value={product.id}>{product.name} · #{product.id}</option>)}
              </select></label>
              <label>Sold / delivered by<select value={transactionFilters.account} onChange={(event) => setTransactionFilters((current) => ({ ...current, account: event.target.value }))}>
                <option value="">All accounts</option>
                {transactionOptions.accounts.map((account) => <option key={account.id} value={account.id}>{account.name}{account.username ? ` (@${account.username})` : ""}{account.id !== "unattributed" ? ` · #${account.id}` : ""}</option>)}
              </select></label>
              {(transactionFilters.product || transactionFilters.account) && <button type="button" className="small-button" onClick={() => setTransactionFilters({ product: "", account: "" })}>Clear filters</button>}
              <p>Filters match whole transactions, including bulk records. Delivery accounts identify the user who recorded the pickup.</p>
            </section>
            <HistoryCalendar selection={historySelection} onChange={updateHistorySelection}
              dateCounts={countHistoryDates([...filteredRecordedHistory.map((entry) => ({ date: entry.sale_date })), ...filteredPickupHistory.map((entry) => ({ date: entry.delivery_date }))], 'date')}
              recordCount={visibleSalesHistory.length + visiblePickupEntries.length} />
            <section className="history-section history-section-sales">
              <header className="history-section-header">
                <div><span className="history-section-kicker">Classification</span><h3>Recorded Sales</h3><p>Completed POS transactions.</p></div>
                <span className="history-section-count">{visibleSalesHistory.length} records</span>
              </header>
              <div className="history-table-wrap">
                {visibleSalesHistory.length === 0 ? (
                  <p className="history-empty">No recorded sales{historyEmptySuffix}.</p>
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
                      {visibleSalesHistory.map((entry) => (
                        <tr key={`sales-history-${entry.id}`}>
                          <td data-label="Sale ID">{entry.id}</td>
                          <td data-label="Date">{formatDeliveryDate(entry.sale_date)}</td>
                          <td data-label="Sold By"><span className="history-account-identity">{entry.actor_name || entry.sold_by || "Unattributed account"}{entry.actor_username && <small className="history-account-username">@{entry.actor_username}</small>}</span></td>
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
                <span className="history-section-count">{visiblePickupEntries.length} records</span>
              </header>
              <div className="history-table-wrap">
                {visiblePickupEntries.length === 0 ? (
                  <p className="history-empty">No vendor pickups{historyEmptySuffix}.</p>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>Pickup ID</th>
                        <th>Vendor ID</th>
                        <th>Vendor</th>
                        <th>Delivered By</th>
                        <th>Product(s)</th>
                        <th>Date</th>
                        <th>Pickup Time</th>
                        <th>Total</th>
                        <th>Payment</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visiblePickupEntries.map((entry) => (
                        <tr key={`pickup-history-${entry.id}`}>
                          <td data-label="Pickup ID">{entry.id}</td>
                          <td data-label="Vendor ID">{getDisplayVendorId(entry)}</td>
                          <td data-label="Vendor">{entry.vendor_name || entry.vendor_id}</td>
                          <td data-label="Delivered By"><span className="history-account-identity">{entry.actor_name || "Unattributed account"}{entry.actor_username && <small className="history-account-username">@{entry.actor_username}</small>}</span></td>
                          <td data-label="Product(s)">{entry.items || "-"}</td>
                          <td data-label="Date">{formatDeliveryDate(entry.delivery_date)}</td>
                          <td data-label="Pickup Time">{entry.delivery_time || "-"}</td>
                          <td data-label="Total">{formatCurrency(entry.total_amount)}</td>
                          <td data-label="Payment"><PaymentStatusBadge status={entry.payment_status} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </section>
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
                    <input type="date" value={returnForm.return_date} readOnly min={returnForm.return_date} max={returnForm.return_date} required />
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
                          {getVendorOptionLabel(vendor)}
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
                          {getVendorOptionLabel(vendor)}
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
                        <option key={product.id} value={product.id}>{product.name} - {product.category || 'General'} — Stock: {formatItemQuantity(product.current_stock)}</option>
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
                    Item price
                    <input value={pickupForm.unit_price} readOnly placeholder="Auto-filled from product data" />
                  </label>
                  <label>
                    Total price
                    <input value={pickupForm.total_price} readOnly placeholder="Quantity × item price" />
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
