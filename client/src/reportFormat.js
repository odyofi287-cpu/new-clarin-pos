export function manilaToday() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function rangeError(range) {
  for (const value of [range.start_date, range.end_date]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "") || value < "0001-01-01"
      || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) return "Choose valid calendar dates.";
  }
  return range.start_date > range.end_date ? "The start date must be on or before the end date." : "";
}

export function formatReportValue(value, type = "text") {
  if (type === "money") return Number(value || 0).toLocaleString("en-PH", { style: "currency", currency: "PHP", minimumFractionDigits: 2 });
  if (type === "number") return Number(value || 0).toLocaleString("en-PH", { maximumFractionDigits: 3 });
  if (type === "date") return new Intl.DateTimeFormat("en-PH", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(`${String(value).slice(0, 10)}T00:00:00Z`));
  if (type === "status") return String(value || "").replaceAll("_", " ");
  return value == null || value === "" ? "—" : String(value);
}

export function downloadReportBlob(blob, filename) {
  let url, link;
  try {
    url = URL.createObjectURL(blob);
    link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
  } finally {
    link?.remove();
    if (url) window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
