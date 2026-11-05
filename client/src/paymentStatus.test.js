import test from "node:test";
import assert from "node:assert/strict";
import { paymentStatus } from "./paymentStatus.js";

test("payment labels distinguish fully returned from paid and unpaid across histories", () => {
  assert.deepEqual(paymentStatus("FULLY_RETURNED"),{label:"Fully returned",className:"is-fully-returned"});
  assert.deepEqual(paymentStatus("paid"),{label:"Paid",className:"is-paid"});
  assert.deepEqual(paymentStatus(null),{label:"Unpaid",className:"is-unpaid"});
});
