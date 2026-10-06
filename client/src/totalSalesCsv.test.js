import test from "node:test";
import assert from "node:assert/strict";
import { buildTotalSalesCsv, totalSalesCsvFilename } from "./totalSalesCsv.js";

function parseCsv(csv) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const text = csv.replace(/^\uFEFF/, "");
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index += 1; }
      else quoted = !quoted;
    } else if (!quoted && char === ",") {
      row.push(cell); cell = "";
    } else if (!quoted && char === "\r" && text[index + 1] === "\n") {
      row.push(cell); rows.push(row); row = []; cell = ""; index += 1;
    } else cell += char;
  }
  return rows;
}

const totals = { recorded_sales: 500.25, delivery_total: 300, return_total: 100.1, total: 700.15, transactions: 4 };
const fixture = {
  generated_for: "2026-10-06",
  summary: {
    all_time: totals, daily: totals, weekly: totals, monthly: totals,
    week_start: "2026-10-05", week_end: "2026-10-11", month: "2026-10",
  },
  daily: [{ period: "2026-10-06", ...totals }],
  weekly: [{ period: "2026-10-05", period_end: "2026-10-11", ...totals }],
  monthly: [{ period: "2026-10", ...totals }],
  products: [{
    product_id: 12, name: 'Piñá, "Special"\nLarge', category: "Food", unit: "packs",
    recorded_quantity: 5, delivered_quantity: 3, returned_quantity: 1, net_quantity: 7,
    ...totals, net_sales: 700.15, share_percent: 100, image_url: "data:image/png;base64,NOT_EXPORTED",
  }],
};

test("exports all summaries, chart periods and products with consistent columns", () => {
  const csv = buildTotalSalesCsv(fixture);
  const rows = parseCsv(csv);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.ok(csv.endsWith("\r\n"));
  assert.equal(rows.length, 9);
  assert.ok(rows.every((row) => row.length === 18));
  assert.deepEqual(rows.slice(1).map((row) => row[1]), [
    "Summary - All-time", "Summary - Daily", "Summary - Weekly", "Summary - Monthly",
    "Daily", "Weekly", "Monthly", "Product - All-time",
  ]);
  assert.deepEqual(rows[1].slice(12, 17), ["500.25", "300.00", "100.10", "700.15", "4"]);
  assert.deepEqual(rows[8].slice(8, 12), ["5", "3", "1", "7"]);
  assert.equal(rows[8][15], "700.15");
  assert.equal(rows[8][17], "100");
  assert.ok(!csv.includes("NOT_EXPORTED"));
});

test("retains Unicode and correctly escapes commas, quotes and newlines", () => {
  const rows = parseCsv(buildTotalSalesCsv(fixture));
  assert.equal(rows[8][5], fixture.products[0].name);
});

test("exports complete products independently of UI search", () => {
  const products = [...fixture.products, { product_id: 13, name: "Another product" }];
  const rows = parseCsv(buildTotalSalesCsv({ ...fixture, products, search: "no matches" }));
  assert.deepEqual(rows.filter((row) => row[1] === "Product - All-time").map((row) => row[4]), ["12", "13"]);
});

test("protects text from spreadsheet formulas without changing negative amounts", () => {
  for (const name of ["=HYPERLINK(\"url\")", "+SUM(1)", "-SUM(1)", "@SUM(1)", " \t=1+1", "\r=1+1"]) {
    const rows = parseCsv(buildTotalSalesCsv({
      ...fixture,
      products: [{ ...fixture.products[0], name, category: "=1+1", unit: "+1", net_quantity: -2, net_sales: -100.1 }],
    }));
    assert.equal(rows[8][5], `'${name}`);
    assert.equal(rows[8][6], "'=1+1");
    assert.equal(rows[8][7], "'+1");
    assert.equal(rows[8][11], "-2");
    assert.equal(rows[8][15], "-100.10");
  }
});

test("uses business dates and correct calendar month boundaries", () => {
  const rows = parseCsv(buildTotalSalesCsv({
    ...fixture,
    monthly: [{ period: "2024-02" }, { period: "2026-02" }, { period: "2026-12" }],
  }));
  assert.deepEqual(rows[2].slice(2, 4), ["2026-10-06", "2026-10-06"]);
  assert.deepEqual(rows[3].slice(2, 4), ["2026-10-05", "2026-10-11"]);
  assert.deepEqual(rows[4].slice(2, 4), ["2026-10-01", "2026-10-31"]);
  assert.deepEqual(rows[7].slice(2, 4), ["2024-02-01", "2024-02-29"]);
  assert.deepEqual(rows[8].slice(2, 4), ["2026-02-01", "2026-02-28"]);
  assert.deepEqual(rows[9].slice(2, 4), ["2026-12-01", "2026-12-31"]);
});

test("empty analytics remains a valid zero-value report", () => {
  const rows = parseCsv(buildTotalSalesCsv({ generated_for: "2026-10-06" }));
  assert.equal(rows.length, 5);
  assert.ok(rows.every((row) => row.length === 18));
  assert.deepEqual(rows[1].slice(12, 17), ["0.00", "0.00", "0.00", "0.00", "0"]);
});

test("filename uses server business date and rejects unsafe input", () => {
  assert.equal(totalSalesCsvFilename(fixture), "total-sales-2026-10-06.csv");
  assert.equal(totalSalesCsvFilename({}), "total-sales-report.csv");
  assert.equal(totalSalesCsvFilename({ generated_for: "../../file" }), "total-sales-report.csv");
});
