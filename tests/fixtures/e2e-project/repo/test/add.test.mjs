import assert from "node:assert/strict";
import { test } from "node:test";
import { add } from "../src/add.mjs";

test("add sums two numbers", () => {
  assert.equal(add(2, 3), 5);
  assert.equal(add(-1, 1), 0);
});
