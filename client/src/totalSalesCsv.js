const HEADERS = [
  "Report Date", "Record Type", "Period Start", "Period End", "Product ID",
  "Product", "Category", "Unit", "Recorded Units", "Delivered Units",
  "Returned Units", "Net Units", "Recorded Sales (PHP)", "Delivery Value (PHP)",
  "Return Deductions (PHP)", "Net Sales (PHP)", "Transactions", "Sales Share (%)",
];

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value) {
  return number(value).toFixed(2);
}

function csvCell(value) {
  let text = String(value ?? "");
  // Only text fields need formula protection; legitimate negative numbers stay numeric.
  if (typeof value === "string" && /^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function monthBounds(month) {
  if (!/^\d{4}-\d{2}$/.test(month || "")) return ["", ""];
  const [year, monthNumber] = month.split("-").map(Number);
  if (monthNumber < 1 || monthNumber > 12) return ["", ""];
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return [`${month}-01`, `${month}-${lastDay}`];
}

/** Export the complete analytics snapshot, independently of the product search. */
export function buildTotalSalesCsv(data) {
  const reportDate = data.generated_for || "";
  const summary = data.summary || {};
  const rows = [HEADERS];
  const addPeriod = (type, start, end, totals = {}) => {
    rows.push([
      reportDate, type, start, end, "", "", "", "", "", "", "", "",
      number(totals.recorded_sales), number(totals.delivery_total),
      number(totals.return_total), number(totals.total),
      number(totals.transactions), "",
    ]);
  };
  addPeriod("Summary - All-time", "", "", summary.all_time);
  addPeriod("Summary - Daily", reportDate, reportDate, summary.daily);
  addPeriod("Summary - Weekly", summary.week_start || "", summary.week_end || "", summary.weekly);
  addPeriod("Summary - Monthly", ...monthBounds(summary.month), summary.monthly);
  for (const row of data.daily || []) addPeriod("Daily", row.period, row.period, row);
  for (const row of data.weekly || []) addPeriod("Weekly", row.period, row.period_end, row);
  for (const row of data.monthly || []) addPeriod("Monthly", ...monthBounds(row.period), row);
  for (const product of data.products || []) {
    rows.push([
      reportDate, "Product - All-time", "", "", product.product_id,
      product.name, product.category || "General", product.unit || "units",
      number(product.recorded_quantity), number(product.delivered_quantity),
      number(product.returned_quantity), number(product.net_quantity),
      number(product.recorded_sales), number(product.delivery_total),
      number(product.return_total), number(product.net_sales), "",
      number(product.share_percent),
    ]);
  }
  // PHP columns have fixed precision; keep their number type until escaping so
  // negative net sales are not mistaken for untrusted spreadsheet formulas.
  return "\uFEFF" + rows.map((row, index) => row.map((value, column) =>
    index > 0 && column >= 12 && column <= 15 ? money(value) : csvCell(value)
  ).join(",")).join("\r\n") + "\r\n";
}

export function totalSalesCsvFilename(data) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(data.generated_for || "") ? data.generated_for : "report";
  return `total-sales-${date}.csv`;
}
