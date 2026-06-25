// Headless save-file diagnostic. Prints the same report App logs to the browser console.
//
// Usage:
//   npx tsx src/cli/diagnose.ts /tmp/save.json
// where save.json holds the contents of localStorage['treegame.save.v1'].

import { readFileSync } from "node:fs";
import { deserialize, type SaveData } from "../game/save";
import { diagnoseReport } from "../game/diagnose";

const path = process.argv[2];
if (!path) {
  console.error("Usage: npx tsx src/cli/diagnose.ts <save.json>");
  process.exit(1);
}
const data = JSON.parse(readFileSync(path, "utf8").trim()) as SaveData;
console.log(diagnoseReport(deserialize(data)));
