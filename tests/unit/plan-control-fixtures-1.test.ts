import { expect, it } from "vitest";
import { check, cli, store } from "./helpers/plan-control-fixtures.ts";

it.each(["good", "bad"])("%s checks accept the specified behavior without touching personal data", half => {
  for (const name of ["item-add", "item-blank", "item-list"]) expect(check(name, store, cli, half), name).toBe(0);
});
it("rejects a wrong default store even when the environment override works", () => {
  expect(check("item-add", store.replace("../data/items.jsonl", "../data/wrong.jsonl"))).not.toBe(0);
});
it("rejects dropping unquoted words from an item name", () => {
  expect(check("item-add", store, cli.replace("parts.join(' ')", "parts[0] ?? ''"))).not.toBe(0);
});
it("rejects silently omitting trim", () => {
  expect(check("item-add", store.replace("input.trim()", "input"))).not.toBe(0);
});
it("rejects the wrong blank-name exit code and missing error message", () => {
  expect(check("item-blank", store, cli.replace("console.error(e.message); process.exitCode = 1", "process.exitCode = 2"))).not.toBe(0);
});
it("rejects carriage returns inside a name", () => {
  expect(check("item-blank", store.replace("/[\\r\\n]/", "/[\\n]/"))).not.toBe(0);
});
it("rejects list using the wrong default even when add uses the correct one", () => {
  expect(check("item-list", store.replace("readFileSync(file,", "readFileSync(process.env.ITEMS_FILE || new URL('../data/wrong.jsonl', import.meta.url),"))).not.toBe(0);
});
it("rejects hiding file read failures as an empty list", () => {
  expect(check("item-list", store.replace("if (e.code === 'ENOENT') return []; throw e;", "return [];"))).not.toBe(0);
});
it("rejects accepting extra arguments to list", () => {
  expect(check("item-list", store, cli.replace(" && parts.length === 0", ""))).not.toBe(0);
});
