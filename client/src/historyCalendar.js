import { rangeError } from "./reportFormat.js";

export function validHistoryDate(value) {
  return !rangeError({ start_date: value, end_date: value });
}

// These are business DATE fields, not creation timestamps. Never shift them
// through the device's timezone when comparing a selected calendar day.
export function historyDate(value) {
  const date = String(value || "").slice(0, 10);
  return validHistoryDate(date) ? date : "";
}

export function filterHistory(records, field, selection) {
  if (selection.mode === "all") return records;
  return records.filter((record) => historyDate(record[field]) === selection.date);
}

export function countHistoryDates(records, field) {
  return records.reduce((counts, record) => {
    const date = historyDate(record[field]);
    if (date) counts[date] = (counts[date] || 0) + 1;
    return counts;
  }, {});
}

export function shiftHistoryDate(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function shiftHistoryMonth(month, offset) {
  const value = new Date(`${month}-01T00:00:00Z`);
  value.setUTCMonth(value.getUTCMonth() + offset);
  return value.toISOString().slice(0, 7);
}

export function historyMonthDays(month) {
  const first = new Date(`${month}-01T00:00:00Z`);
  const length = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const cells = Array(first.getUTCDay()).fill(null);
  for (let day = 1; day <= length; day++) cells.push(`${month}-${String(day).padStart(2, "0")}`);
  while (cells.length % 7) cells.push(null);
  return cells;
}
