// Validator for the subset of JSON Schema that api/actions.schema.json uses. The image has no npm packages, so this is
// small on purpose: $ref to #/$defs, type, enum, const, pattern, length and size limits, required, properties,
// additionalProperties, items, propertyNames, oneOf, allOf, if/then. Anything else in the schema is ignored, so a new
// keyword must be added here and covered in tests/actions.test.ts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type S = any;
const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "api", "actions.schema.json");
export const root: S = JSON.parse(fs.readFileSync(FILE, "utf8"));

const kind = (v: unknown) => v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
const regex = new Map<string, RegExp>();
const re = (p: string) => regex.get(p) ?? regex.set(p, new RegExp(p, "u")).get(p)!;

function resolve(ref: string): S {
  if (ref === "#") return root;
  const m = /^#\/\$defs\/(\w+)$/.exec(ref);
  if (!m || !root.$defs[m[1]]) throw new Error(`unsupported $ref ${ref}`);
  return root.$defs[m[1]];
}

// Returns null when valid, otherwise a short message that starts with the path of the value.
export function check(s: S, v: unknown, at = ""): string | null {
  const bad = (msg: string) => `${at || "payload"}: ${msg}`;
  if (s.$ref) { const e = check(resolve(s.$ref), v, at); if (e) return e; }
  if (s.type) {
    const k = kind(v);
    const ok = s.type === "integer" ? Number.isInteger(v) : s.type === "number" ? k === "number" : k === s.type;
    if (!ok) return bad(`must be ${s.type}`);
  }
  if ("const" in s && v !== s.const) return bad(`must be ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.includes(v)) return bad(`must be one of ${s.enum.join(", ")}`);
  if (typeof v === "string") {
    if (s.minLength !== undefined && v.length < s.minLength) return bad(`shorter than ${s.minLength}`);
    if (s.maxLength !== undefined && v.length > s.maxLength) return bad(`longer than ${s.maxLength}`);
    if (s.pattern && !re(s.pattern).test(v)) return bad("has an invalid format");
  }
  if (typeof v === "number") {
    if (s.minimum !== undefined && v < s.minimum) return bad(`below ${s.minimum}`);
    if (s.maximum !== undefined && v > s.maximum) return bad(`above ${s.maximum}`);
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) return bad(`fewer than ${s.minItems} items`);
    if (s.maxItems !== undefined && v.length > s.maxItems) return bad(`more than ${s.maxItems} items`);
    if (s.items) for (let i = 0; i < v.length; i++) { const e = check(s.items, v[i], `${at}[${i}]`); if (e) return e; }
  }
  if (kind(v) === "object") {
    const o = v as Record<string, unknown>, keys = Object.keys(o);
    if (s.maxProperties !== undefined && keys.length > s.maxProperties) return bad(`more than ${s.maxProperties} properties`);
    for (const r of s.required ?? []) if (!(r in o)) return bad(`${r} is required`);
    if (s.propertyNames) for (const k of keys) { const e = check(s.propertyNames, k, `${at}.${k}`); if (e) return e; }
    for (const k of keys) {
      const sub = s.properties?.[k];
      const next = `${at ? at + "." : ""}${k}`;
      if (sub) { const e = check(sub, o[k], next); if (e) return e; }
      else if (s.additionalProperties === false) return bad(`unknown property ${k}`);
      else if (typeof s.additionalProperties === "object") { const e = check(s.additionalProperties, o[k], next); if (e) return e; }
    }
  }
  for (const sub of s.allOf ?? []) { const e = check(sub, v, at); if (e) return e; }
  if (s.if && !check(s.if, v, at) && s.then) { const e = check(s.then, v, at); if (e) return e; }
  if (s.oneOf) {
    const results = s.oneOf.map((b: S) => check(b, v, at));
    const n = results.filter((r: string | null) => r === null).length;
    if (n === 1) return null;
    if (n > 1) return bad("matches more than one alternative");
    // Discriminated union: report the alternative whose `type` constant matches, not the first one.
    const t = (v as any)?.type, i = s.oneOf.findIndex((b: S) => b.properties?.type?.const === t);
    return i >= 0 ? results[i] : bad("matches no alternative");
  }
  return null;
}

export const validate = (def: "Action" | "ActionResult" | "Event" | "Context", v: unknown) => check({ $ref: `#/$defs/${def}` }, v);
export const payloadOf = (def: string) => root.$defs[def];
