// Protected driver for the acceptance checks. Runs in the candidate sandbox with the checkout as cwd,
// calls the candidate's code on inputs the check chose, and prints one observation per line. The
// expected values live in ../<check>.verify.sh, which the candidate sandbox can't read.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const load = (p) => import(pathToFileURL(resolve(p)).href);
const show = (v) => (typeof v === "number" ? String(v) : `${typeof v}:${String(v)}`);
const which = process.argv[2];

if (which === "ac1") {
  const { multiply } = await load("src/multiply.mjs");
  for (const [a, b] of [[2, 3], [-4, 5], [0, 9], [1.5, 2], [7, -1]]) console.log(`multiply(${a},${b})=${show(multiply(a, b))}`);
} else if (which === "ac2" || which === "ac3") {
  const { clamp } = await load("src/clamp.mjs");
  const inputs = which === "ac2"
    ? [[-5, 0, 10], [15, 0, 10], [-1.5, -1, 1], [100, 3, 4]]
    : [[5, 0, 10], [0, 0, 10], [10, 0, 10], [0.25, -1, 1]];
  for (const [x, lo, hi] of inputs) console.log(`clamp(${x},${lo},${hi})=${show(clamp(x, lo, hi))}`);
} else {
  console.error(`unknown check: ${which}`);
  process.exit(2);
}
