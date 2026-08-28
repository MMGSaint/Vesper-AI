// Hunt for a global Object.prototype pollution sink across the serialized boundaries.
import { validateToolArgs } from "../../../../src/vesper/tools/validate.ts";
import { mergeOverDefaults } from "../../../../src/vesper/config-file.ts";
import { parseConfig, defaultConfig } from "../../../../src/vesper/config.ts";
import { redactObject } from "../../../../src/vesper/logging.ts";
import { MemoryStorage } from "../../../../src/vesper/storage.ts";
import { coerceMemoryEntry } from "../../../../src/vesper/memory/sanitize.ts";
import { canonicalJson } from "../../../../src/vesper/distributed/identity.ts";

const probe = () => (({} as any).confirmed === true ? "POLLUTED" : "clean");

function report(label: string) {
  console.log(`${label.padEnd(46)} -> Object.prototype.confirmed = ${probe()}`);
}

const payloadStr = '{"__proto__":{"confirmed":true},"path":"x"}';
const payload = JSON.parse(payloadStr);
console.log("payload own keys:", Object.getOwnPropertyNames(payload));
console.log("payload.__proto__ is own data prop:", Object.getOwnPropertyDescriptor(payload, "__proto__") !== undefined);

report("baseline");

// 1. tool arg validation
validateToolArgs({ type: "object", properties: { path: { type: "string" } }, required: [] } as any, payload);
report("validateToolArgs(top-level __proto__)");

// 1b. nested inside a declared object param
const nested = JSON.parse('{"blob":{"__proto__":{"confirmed":true}}}');
validateToolArgs({ type: "object", properties: { blob: { type: "object" } }, required: [] } as any, nested);
report("validateToolArgs(nested __proto__)");

// 2. config merge
mergeOverDefaults({ a: 1 }, JSON.parse('{"__proto__":{"confirmed":true}}'));
report("mergeOverDefaults");
mergeOverDefaults({ hardware: { mode: "auto" } }, JSON.parse('{"hardware":{"__proto__":{"confirmed":true}}}'));
report("mergeOverDefaults(nested)");

// 3. zod config parse
const cfg = parseConfig(JSON.parse('{"identity":{"name":"V","userName":"U"},"permissions":{"toolOverrides":{"__proto__":{"confirmed":true}}}}'));
report("parseConfig(permissions.toolOverrides)");
const cfg2 = parseConfig(JSON.parse('{"__proto__":{"confirmed":true},"identity":{"name":"V","userName":"U"}}'));
report("parseConfig(root __proto__)");

// 4. logging redact
redactObject(JSON.parse('{"__proto__":{"confirmed":true},"tool":"x"}') as any);
report("redact");

// 5. storage structuredClone
const st = new MemoryStorage();
await st.set("k", JSON.parse('{"__proto__":{"confirmed":true}}'));
await st.get("k");
report("MemoryStorage.set/get");

// 6. memory sanitize
coerceMemoryEntry(JSON.parse('{"key":"k","value":"v","__proto__":{"confirmed":true}}'), "test");
report("coerceMemoryEntry");

// 7. canonicalJson
canonicalJson(JSON.parse('{"__proto__":{"confirmed":true},"a":1}'));
report("canonicalJson");

console.log("\nfinal:", probe());
