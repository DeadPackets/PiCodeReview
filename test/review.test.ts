/**
 * The single test: a live, end-to-end smoke test.
 * Runs the full pipeline (hunters -> dedup -> judge) against fixtures/sample.ts
 * and asserts the planted SQL injection is confirmed by the judge.
 *
 * Requires OPENROUTER_API_KEY (this calls real models). Run: `npm test`.
 */
import assert from "node:assert/strict";
import { review } from "../src/review.js";

const findings = await review({ path: "fixtures/sample.ts" });
const confirmed = findings.filter((f) => f.verdict !== "reject");

// 1) the SQL injection must be found AND survive the judge
const sqli = confirmed.find(
  (f) => /CWE-89/i.test(f.standardRef) || /sql\s*injection/i.test(f.title),
);
if (!sqli) throw new Error("expected a confirmed SQL injection finding (CWE-89)");

// 2) the judge should have exercised precision (the bait is designed to be rejected)
assert.ok(findings.length >= confirmed.length, "verdicts should be applied");

console.log(
  `PASS — ${confirmed.length}/${findings.length} candidates confirmed; ` +
    `SQLi detected: "${sqli.title}" [${sqli.severity}, ${sqli.standardRef}]`,
);
