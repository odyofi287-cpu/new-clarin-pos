const currency = (amount) => Number(amount || 0).toLocaleString("en-PH", { style: "currency", currency: "PHP" });

export const emptyProductEconomics = { volume_ml: "", quantity_per_case: "", base_price: "", markup_price: "" };
export const productEconomicsPayload = (form) => Object.fromEntries(Object.keys(emptyProductEconomics).map((key) => [key, Number(form[key])]));

export default function ProductEconomicsFields({ form, onChange }) {
  const field = (key, label, step, min) => <label key={key}>{label}<input type="number" min={min} step={step} value={form[key] ?? ""} onChange={(event) => onChange({ ...form, [key]: event.target.value })} required /></label>;
  const configured = form.base_price !== "" && form.base_price != null && form.markup_price !== "" && form.markup_price != null;
  return <fieldset className="product-economics-fields">
    <legend>Product size &amp; pricing</legend>
    <div className="product-economics-grid">
      {field("volume_ml", "Product volume (mL)", "0.01", "0.01")}
      {field("quantity_per_case", "Quantity per case (Items)", "1", "1")}
      {field("base_price", "Base price per Item (PHP)", "0.01", "0")}
      {field("markup_price", "Mark-up per Item (PHP)", "0.01", "0")}
    </div>
    <div className="product-price-preview"><span>Selling price per Item <small>Base price + mark-up</small></span><strong>{configured ? currency(Number(form.base_price) + Number(form.markup_price)) : "Enter pricing"}</strong></div>
    <p>Stock is counted in Items. An even case size enables half-case deliveries. Pricing changes apply to new transactions only.</p>
  </fieldset>;
}
