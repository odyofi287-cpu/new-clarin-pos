import test from "node:test";
import assert from "node:assert/strict";
import { packSize, packLabel } from "./deliveryPacks.js";

test("case and half-case delivery controls resolve to physical Items", () => {
  assert.equal(packSize({ quantity_per_case: 24 }, "case"), 24);
  assert.equal(packSize({ quantity_per_case: 24 }, "half-case"), 12);
  assert.equal(packSize({ quantity_per_case: 5 }, "half-case"), 0);
  assert.equal(packSize({}, "case"), 0);
  assert.equal(packSize({}, "item"), 1);
  assert.equal(packLabel("half-case", 2), "2 half-cases");
});
