import { expect, it } from "vitest";
import { check, cli, store } from "./helpers/plan-control-fixtures.ts";

it("rejects treating an existing zero-byte store as a parse error", () => {
  expect(check("item-list", store.replace("if (!text) return [];", "if (!text) throw new Error('empty store');"))).not.toBe(0);
});
it("rejects success for an unknown command", () => {
  expect(check("item-add", store, cli.replace("process.exitCode = 2", "process.exitCode = command === 'unknown' ? 0 : 2"))).not.toBe(0);
});
it("rejects success when the command is missing", () => {
  expect(check("item-add", store, cli.replace("process.exitCode = 2", "process.exitCode = command === undefined ? 0 : 2"))).not.toBe(0);
});
it("rejects announcing saved after a failed write", () => {
  expect(check("item-add", store, cli.replace("console.error(e.message);", "process.stdout.write('saved\\n'); console.error(e.message);"))).not.toBe(0);
});
it("rejects dropping the record shape validation", () => {
  expect(check("item-list", store.replace(/    if \(!row.*throw new Error\('invalid item record'\);/, ""))).not.toBe(0);
});
it("rejects emitting partial output before a later malformed record", () => {
  const streaming = store.replace(/  return lines.map\(line => \{[\s\S]*?  \}\);/, "  return (function* () { for (const line of lines) yield JSON.parse(line).name; })();");
  expect(check("item-list", streaming)).not.toBe(0);
});
it("rejects forbidding a valid interior tab", () => {
  expect(check("item-add", store.replace("if (!name ||", "if (name.includes('\\t') || !name ||"))).not.toBe(0);
});
it("rejects resolving a relative override against the application directory", () => {
  const wrong = store.replace("process.env.ITEMS_FILE ||", "(process.env.ITEMS_FILE ? new URL('../' + process.env.ITEMS_FILE, import.meta.url) : null) ||");
  expect(check("item-add", wrong)).not.toBe(0);
});
it("rejects deleting existing items when a blank add is refused", () => {
  const wrong = store.replace("throw new Error('item name must not be blank');", "{ writeFileSync(file, ''); throw new Error('item name must not be blank'); }");
  expect(check("item-blank", wrong)).not.toBe(0);
});
it("rejects the first task saving invalid records before the diagnostic task", () => {
  expect(check("item-add", store.replace("if (!name || /[\\r\\n]/.test(name))", "if (false)"))).not.toBe(0);
});
it("allows the first task's safe generic refusal but requires the second task's exact diagnostic", () => {
  const intermediate = store.replace("item name must not be blank", "invalid item name");
  expect(check("item-add", intermediate)).toBe(0);
  expect(check("item-blank", intermediate)).not.toBe(0);
});
