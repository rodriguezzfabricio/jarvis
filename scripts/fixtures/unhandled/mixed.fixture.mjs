import { expect, it } from "vitest";

it("fails an assertion", () => {
  expect(1).toBe(2);
});

it("leaves an unhandled rejection behind", async () => {
  Promise.reject(new Error("unhandled on purpose"));
  await new Promise((r) => setTimeout(r, 50));
});
