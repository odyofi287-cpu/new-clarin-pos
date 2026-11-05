export function paymentStatus(status) {
  switch (String(status || "UNPAID").toUpperCase()) {
    case "PAID": return { label: "Paid", className: "is-paid" };
    case "FULLY_RETURNED": return { label: "Fully returned", className: "is-fully-returned" };
    default: return { label: "Unpaid", className: "is-unpaid" };
  }
}
