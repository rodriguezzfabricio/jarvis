import { listItems, saveItem } from "./store.mjs";
const [command, ...rest] = process.argv.slice(2);
if (command === "add") { saveItem(rest.join(" ")); console.log("saved"); }
else if (command === "list") { for (const name of listItems()) console.log(name); }
else { console.error("usage: node src/cli.mjs add <name> | list"); process.exit(2); }
