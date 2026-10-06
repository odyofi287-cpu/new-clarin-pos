import { BUSINESS_TIME_ZONE } from "./businessDate.js";

const column = (key, label, type = "text") => ({ key, label, type });
const metric = (label, value, type = "number") => ({ label, value, type });
const sum = (rows, key) => rows.reduce((value, row) => value + Number(row[key] || 0), 0);

export function buildReportDocument(mode, data, range, user, generatedAt = new Date().toISOString()) {
  const titles = { sales: "Recorded Sales Report", inventory: "Inventory Report", "vendor-deliveries": "Vendor Deliveries Report", "total-sales": "Total Sales Report" };
  const report = {
    mode, title: titles[mode], organization: "New Clarin Sports Arena POS",
    report_id: `NCSA-${mode.toUpperCase()}-${range.start}-${range.end}`,
    period: { start_date: range.start, end_date: range.end },
    generated_at: generatedAt, prepared_by: user.name || user.email || "Authorized user",
    time_zone: BUSINESS_TIME_ZONE, currency: "PHP", summary: [], sections: [], note: "",
  };
  if (mode === "sales") {
    report.summary = [metric("Recorded sales", sum(data, "total_amount"), "money"), metric("Transactions", data.length), metric("Units sold", sum(data, "quantity"))];
    report.sections = [{ title: "Recorded transactions", columns: [column("transaction_id", "Transaction ID"), column("sale_date", "Date", "date"), column("staff", "Staff"), column("items", "Products"), column("quantity", "Units", "number"), column("total_amount", "Amount (PHP)", "money")], rows: data }];
    report.note = "Recorded sales only. Vendor deliveries and return deductions are included in the Total Sales report.";
  } else if (mode === "inventory") {
    report.summary = [metric("Active products", data.length), metric("Stock-in units", sum(data, "stock_in")), metric("Stock-out units", sum(data, "stock_out")), metric("Low-stock products", data.filter((r) => r.stock_status === "LOW_STOCK").length), metric("Out-of-stock products", data.filter((r) => r.stock_status === "OUT_OF_STOCK").length)];
    report.sections = [{ title: "Stock movement and current inventory", columns: [column("product", "Product"), column("stock_in", "Stock in", "number"), column("stock_out", "Stock out", "number"), column("current_stock", "Current stock", "number"), column("minimum_stock", "Minimum stock", "number"), column("stock_status", "Status", "status")], rows: data }];
    report.note = "Stock-in and stock-out movements are filtered by the selected business dates. Current stock, minimum stock, and stock status are live values at report generation, not historical closing balances. Adjustments and returns may also change current stock.";
  } else if (mode === "vendor-deliveries") {
    report.summary = [metric("Original delivery value", sum(data, "amount"), "money"), metric("Deliveries", data.length), metric("Units delivered", sum(data, "quantity"))];
    report.sections = [{ title: "Vendor delivery records", columns: [column("delivery_id", "Delivery ID"), column("vendor", "Vendor"), column("delivery_date", "Delivery Date", "date"), column("products", "Products"), column("quantity", "Units", "number"), column("amount", "Amount (PHP)", "money")], rows: data }];
    report.note = "Amounts are the original delivery values before return deductions, regardless of payment status. Each bulk delivery is one record.";
  } else {
    report.summary = [metric("Recorded sales", data.totals.recorded_sales, "money"), metric("Delivery value", data.totals.delivery_total, "money"), metric("Return deductions", data.totals.return_total, "money"), metric("Net sales", data.totals.total, "money"), metric("Transactions", data.totals.transactions), metric("Products with activity", data.products.length)];
    const periodColumns = [column("period", "Period"), column("recorded_sales", "Recorded (PHP)", "money"), column("delivery_total", "Deliveries (PHP)", "money"), column("return_total", "Returns (PHP)", "money"), column("total", "Net sales (PHP)", "money"), column("transactions", "Transactions", "number")];
    report.sections = [{ title: "Product Sales", columns: [column("name", "Product"), column("category", "Category"), column("recorded_sales", "Recorded (PHP)", "money"), column("delivery_total", "Deliveries (PHP)", "money"), column("return_total", "Returns (PHP)", "money"), column("net_sales", "Net sales (PHP)", "money")], rows: data.products },
      { title: "Product quantities", columns: [column("product_id", "Product ID"), column("name", "Product"), column("unit", "Unit"), column("recorded_quantity", "Sold units", "number"), column("delivered_quantity", "Delivered units", "number"), column("returned_quantity", "Returned units", "number"), column("net_quantity", "Net units", "number")], rows: data.products },
      ...["daily", "weekly", "monthly"].map((key) => ({ title: `${key[0].toUpperCase()}${key.slice(1)} Sales`, columns: periodColumns, rows: data[key] }))];
    report.note = "Net sales = recorded sales + delivery value − recorded return deductions. All totals and product activity cover only the selected dates. Return deductions are positive amounts subtracted from sales. Daily, weekly, and monthly sections are separate views of the same activity; do not add them together. Weeks start on Monday; weeks and months at the range boundaries include only the selected dates. Dates without activity are omitted. Bulk returns count as one transaction per return batch.";
    const difference = sum(data.products, "net_sales") - data.totals.total;
    if (Math.abs(difference) >= 0.01) report.note += ` Reconciliation notice: product line values differ from recorded transaction totals by PHP ${difference.toFixed(2)}. Review the original transaction amounts and item pricing. No historical values have been modified.`;
  }
  // Report tables contain only their declared columns, not repeated image data
  // or internal fields. The API's product data still retains product images.
  report.sections = report.sections.map((section) => ({ ...section,
    rows: section.rows.map((row) => Object.fromEntries(section.columns.map((c) => [c.key, row[c.key]]))),
  }));
  return report;
}

function csvCell(value, trustedNumber = false) {
  let text = String(value ?? "");
  if (!trustedNumber && typeof value === "string" && /^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function reportCsv(report) {
  const width = Math.max(2, ...report.sections.map((s) => s.columns.length));
  const rows = [];
  const add = (values, types = []) => rows.push({ values, types });
  add([report.organization]); add([report.title]); add(["Report ID", report.report_id]);
  add(["From", report.period.start_date]); add(["To", report.period.end_date]);
  add(["Scope", report.period.scope === "all-time" ? "All time" : "Selected dates"]);
  add(["Prepared by", report.prepared_by]); add(["Generated at (UTC)", report.generated_at]);
  add(["Business time zone", report.time_zone]); add(["Currency", report.currency]);
  add([]); add(["SUMMARY"]); add(["Metric", "Value"]);
  for (const item of report.summary) add([item.label, item.type === "money" ? Number(item.value).toFixed(2) : item.value], ["text", item.type]);
  for (const section of report.sections) {
    add([]); add([section.title.toUpperCase()]); add(section.columns.map((c) => c.label));
    for (const row of section.rows) add(section.columns.map((c) => c.type === "money" ? Number(row[c.key] || 0).toFixed(2) : c.type === "status" ? String(row[c.key]).replaceAll("_", " ") : row[c.key]), section.columns.map((c) => c.type));
    if (!section.rows.length) add(["No records for the selected dates."]);
  }
  add([]); add(["Notes", report.note]);
  // Money columns are trusted formatter output; untrusted text is always escaped.
  return "\uFEFF" + rows.map(({ values, types }) => Array.from({ length: width }, (_, index) =>
    csvCell(values[index] ?? "", types[index] === "money" || types[index] === "number")
  ).join(",")).join("\r\n") + "\r\n";
}
