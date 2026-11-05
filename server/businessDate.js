const DEFAULT_TIME_ZONE = "Asia/Manila";

function getBusinessTimeZone() {
  const timeZone = process.env.BUSINESS_TIME_ZONE || DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return timeZone;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

const BUSINESS_TIME_ZONE = getBusinessTimeZone();

export function getBusinessDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function getBusinessTime(date = new Date()) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: BUSINESS_TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(date);
}

// Derive the business date, display time and audit timestamp from one instant.
export function getBusinessTimestamp(date = new Date()) {
  return { date: getBusinessDate(date), time: getBusinessTime(date), created_at: date.toISOString() };
}

export { BUSINESS_TIME_ZONE };
