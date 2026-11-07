import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFlags, normalizeWake, setupHelpText } from "../src/setup.mjs";
import { receiveModeOf } from "../src/kernel.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const help = parseFlags(["--help"]);
assert.equal(help.help, true);
assert.match(setupHelpText(), /不进入向导/);

assert.equal(normalizeWake("sweep"), "3");
assert.equal(normalizeWake("automation"), "3");
assert.equal(normalizeWake("event"), "1");
assert.equal(normalizeWake("poll"), "2");
assert.throws(() => normalizeWake("nope"));
assert.equal(parseFlags(["--wake", "sweep"]).wake, "sweep");

assert.equal(receiveModeOf({ events: true }), "event");
assert.equal(receiveModeOf({ events: false, doorbellFile: "/tmp/x" }), "event");
assert.equal(receiveModeOf({ events: false, pollSec: 900, sweepSec: 900 }), "automation");
assert.equal(receiveModeOf({ events: false, pollSec: 45, sweepSec: 900 }), "poll");

const schema = JSON.parse(fs.readFileSync(path.join(root, "schema/base-schema.json"), "utf8"));
const cards = schema.tables.find((t) => t.name === "AgentCards");
assert.ok(cards.fields.some((f) => f.name === "Metadata"));

const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
assert.equal(lock.packages[""].bin.lah, "bin/lah.mjs");
assert.equal(lock.packages[""].bin["hub-node"], "bin/hub-node.mjs");

const install = fs.readFileSync(path.join(root, "install.sh"), "utf8");
assert.match(install, /npm ci --omit=dev/);

const md = fs.readFileSync(path.join(root, "docs/base-schema.md"), "utf8");
assert.match(md, /\| Metadata \| Text \|/);

const kernel = fs.readFileSync(path.join(root, "src/kernel.mjs"), "utf8");
assert.match(kernel, /To_Node: await this\.initiatorOf\(task\)/);
assert.match(kernel, /String\(f1\(row, "Node_Desc"\) \?\? ""\) !== String\(this\.cfg\.nodeDesc\)/);
assert.match(kernel, /async markOffline\(/);
assert.match(kernel, /async run\(\{ once = false \} = \{\}\)/);

const r = spawnSync(process.execPath, [path.join(root, "bin/lah.mjs"), "setup", "--help"], {
  encoding: "utf8",
  timeout: 5000,
  env: { ...process.env, HUB_NODE_HOME: "/tmp/lah-selftest-does-not-exist" },
});
assert.equal(r.status, 0, r.stderr || r.stdout);
assert.match(r.stdout, /lah setup/);
assert.doesNotMatch(r.stdout + r.stderr, /tenant|凭据失败|发现 Base/);

const r2 = spawnSync(process.execPath, [path.join(root, "bin/lah.mjs"), "setup", "--wake", "nope", "--yes"], {
  encoding: "utf8",
  timeout: 5000,
});
assert.equal(r2.status, 2);
assert.match(r2.stderr, /未知 --wake/);

console.log("selftest-remaining-fixes: ok");
