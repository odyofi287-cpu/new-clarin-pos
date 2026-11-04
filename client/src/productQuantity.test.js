import test from "node:test";
import assert from "node:assert/strict";
import { formatItemQuantity } from "./productQuantity.js";

test("product quantities consistently use Item/Items without changing quantities", () => {
  assert.equal(formatItemQuantity(1), "1 Item");
  assert.equal(formatItemQuantity("2"), "2 Items");
  assert.equal(formatItemQuantity(0), "0 Items");
  assert.equal(formatItemQuantity(null), "0 Items");
  assert.equal(formatItemQuantity(1234), "1,234 Items");
});
