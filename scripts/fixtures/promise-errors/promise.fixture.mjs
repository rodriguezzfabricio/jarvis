import { expect, it } from "vitest";

it("rejects with the wrong error", async () => {
  await expect(Promise.reject(new Error("some other refusal"))).rejects.toThrow(/allowedDomains/);
});

it("rejects with a multi-line error where it should resolve", async () => {
  await expect(Promise.reject(new Error("first line\nsecond line"))).resolves.toBe(1);
});

it("throws a runtime error inside a .rejects matcher", async () => {
  await expect(Promise.reject(new Error("refused"))).rejects.toSatisfy(() => {
    throw new TypeError("a runtime error, not an assertion");
  });
});

it("resolves where it should reject", async () => {
  await expect(Promise.resolve(1)).rejects.toThrow();
});

it("throws a runtime error that ends like Vitest's own message", async () => {
  await expect(Promise.reject(new Error("refused"))).rejects.toSatisfy(() => {
    throw new TypeError("failed instead of resolving");
  });
});
