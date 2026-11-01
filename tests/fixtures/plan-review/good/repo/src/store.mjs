// Items live in data/items.jsonl, one JSON object per line (D2).
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const FILE = "data/items.jsonl";
export function saveItem(name) {
  if (typeof name !== "string" || !name.trim()) throw new Error("item name must be a nonblank string");
  appendFileSync(FILE, JSON.stringify({ name: name.trim() }) + "\n");
}
export function listItems() {
  return existsSync(FILE) ? readFileSync(FILE, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).name) : [];
}
