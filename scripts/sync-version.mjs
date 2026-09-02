import { readFileSync, writeFileSync } from "node:fs";

const root = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const dshPath = new URL("../dsh/package.json", import.meta.url);
const dsh = JSON.parse(readFileSync(dshPath, "utf8"));

dsh.version = root.version;
dsh.dependencies.openchiaro = root.version;
writeFileSync(dshPath, `${JSON.stringify(dsh, null, 2)}\n`);
