import { rangeError } from "./reportFormat.js";

export function salesPeriodRange(mode, value) {
  let start;
  let end;
  if (mode === "daily") start = end = value;
  else if (mode === "monthly" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    const [year, month] = value.split("-").map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    start = `${value}-01`; end = `${value}-${days}`;
  } else if (mode === "yearly" && /^\d{4}$/.test(value)) {
    start = `${value}-01-01`; end = `${value}-12-31`;
  } else throw new Error("Choose a valid reporting period.");
  const error = rangeError({ start_date: start, end_date: end });
  if (error) throw new Error(error);
  return { start_date: start, end_date: end };
}

export function switchSalesPeriod(selection, mode) {
  const anchor = selection.mode === "daily" ? selection.value : selection.mode === "monthly" ? `${selection.value}-01` : `${selection.value}-01-01`;
  return { mode, value: anchor.slice(0, mode === "daily" ? 10 : mode === "monthly" ? 7 : 4) };
}
