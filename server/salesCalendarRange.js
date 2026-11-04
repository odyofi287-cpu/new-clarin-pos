import { dbGet, isInMemoryDb } from "./routes/dbCompat.js";
import { reportDate, reportRange } from "./reportData.js";

export function salesCalendarRangeInput(query) {
  if (!query.start_date || !query.end_date) throw new Error("Choose both a start date and an end date.");
  return reportRange(query);
}

export async function getSalesCalendarRange(db, start, end) {
  salesCalendarRangeInput({ start_date: start, end_date: end });
  let totals;
  if (isInMemoryDb(db)) {
    const sum = (rows, dateField, amountField) => rows
      .filter((row) => reportDate(row[dateField]) >= start && reportDate(row[dateField]) <= end)
      .reduce((total, row) => total + Number(row[amountField] || 0), 0);
    totals = {
      recorded_sales: sum(db.sales, "sale_date", "total_amount"),
      vendor_deliveries: sum(db.deliveries, "delivery_date", "total_amount"),
      vendor_returns: sum(db.vendor_returns, "return_date", "total_product_price_returned"),
    };
  } else {
    // One database snapshot, no multiplying joins or full-history downloads.
    // Inclusive DATE predicates use the existing business-date indexes.
    totals = await dbGet(db, `SELECT
      (SELECT COALESCE(SUM(total_amount), 0) FROM sales WHERE sale_date BETWEEN $1 AND $2) AS recorded_sales,
      (SELECT COALESCE(SUM(total_amount), 0) FROM deliveries WHERE delivery_date BETWEEN $3 AND $4) AS vendor_deliveries,
      (SELECT COALESCE(SUM(total_product_price_returned), 0) FROM vendor_returns WHERE return_date BETWEEN $5 AND $6) AS vendor_returns`,
    [start, end, start, end, start, end]);
  }
  const recordedSales = Number(totals.recorded_sales || 0);
  const deliveries = Number(totals.vendor_deliveries || 0);
  const returns = Number(totals.vendor_returns || 0);
  return {
    start_date: start,
    end_date: end,
    recorded_sales: recordedSales,
    vendor_deliveries: deliveries,
    vendor_returns: returns,
    net_sales: recordedSales + deliveries - returns,
  };
}
