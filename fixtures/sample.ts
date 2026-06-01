// Demo file with deliberately planted issues (one per dimension) plus a
// false-positive bait, so `critique` can show recall AND the judge's precision.
import { exec } from "node:child_process";

declare const db: { query(sql: string): unknown };

// [security] SQL injection — user input concatenated into the query string. CWE-89.
export function getUser(req: { query: { id: string } }, res: { json(x: unknown): void }) {
  const id = req.query.id;
  const row = db.query("SELECT * FROM users WHERE id = '" + id + "'");
  res.json(row);
}

// [security] Hardcoded credential committed to source. CWE-798.
const API_KEY = "demo-not-a-real-key-0000-replace-with-process-env";

// [readability + structure + correctness] god-function: meaningless name, args a/b/c,
// deep nesting, does three unrelated things, and swallows the parse error silently.
export function doStuff(a: string, b: number, c: boolean): number {
  let r = 0;
  for (let i = 0; i < b; i++) {
    if (c) {
      if (a.length > 0) {
        try {
          const parsed = JSON.parse(a);
          r = r + (parsed.value || 0) * i;
        } catch (e) {
          // ignore
        }
      }
    }
  }
  return r;
}

// [false-positive bait] looks like command injection, but the command is a hardcoded
// constant with no untrusted input — the judge should REJECT a security flag here.
export function diskFree() {
  return exec("df -h");
}

// uses the constant above so it isn't dead code
export function authHeader() {
  return { Authorization: `Bearer ${API_KEY}` };
}
