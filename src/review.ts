#!/usr/bin/env tsx
/**
 * critique — an agentic, multi-tier code reviewer.
 *
 *   input (diff | file | dir)
 *     -> Tier 1: four hunter agents (cheap model, read-only tools) explore the code
 *        in parallel and report findings, following references across files
 *     -> dedup (deterministic)
 *     -> Tier 2: judge agent (big model) re-reads the code and verifies each finding,
 *        rejecting false positives and calibrating severity
 *     -> rich CLI report
 *
 * Cost discipline (best-effort, given the SDK abstracts the wire format):
 *   - tiered models: high-recall cheap model hunts; expensive model only judges deduped findings
 *   - stable prefixes: each charter + the tool set never change, so the system+tools
 *     prefix is cacheable across every turn of an agent loop
 *   - grep-first prompting + low thinking for hunters; dedup before the judge
 */

import { execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { HUNTERS, JUDGE_PROMPT, type HunterSpec } from "./prompts.js";

// ---------------------------------------------------------------------------
// Config (override model slugs via env if OpenRouter names differ)
// ---------------------------------------------------------------------------
const PROVIDER = "openrouter";
const HUNTER_MODEL = process.env.CRITIQUE_HUNTER_MODEL ?? "google/gemini-3.5-flash";
const JUDGE_MODEL = process.env.CRITIQUE_JUDGE_MODEL ?? "anthropic/claude-opus-4.8";

const MODELS_JSON = fileURLToPath(new URL("../models.json", import.meta.url));
const REVIEWER_DIR = fileURLToPath(new URL("..", import.meta.url));
const AGENT_DIR = process.env.PI_AGENT_DIR ?? "~/.pi/agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type Severity = "blocker" | "high" | "medium" | "low" | "nit";
const SEVERITY_ORDER: Severity[] = ["blocker", "high", "medium", "low", "nit"];

export interface Finding {
  id: number;
  dimension: string;
  severity: Severity;
  title: string;
  file: string;
  startLine: number;
  endLine: number;
  rationale: string;
  suggestion: string;
  standardRef: string;
  confidence?: number;
  // filled by the judge
  verdict?: "confirm" | "reject" | "revise";
  judgeNote?: string;
}

interface Scope {
  cwd: string;
  label: string;
  prompt: string;
}

// ---------------------------------------------------------------------------
// Model registry
// ---------------------------------------------------------------------------
function setup() {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage, MODELS_JSON);
  return { authStorage, modelRegistry };
}

function requireModel(modelRegistry: any, id: string) {
  const model = modelRegistry.find(PROVIDER, id);
  if (!model) {
    throw new Error(
      `Model "${PROVIDER}/${id}" not found. Check models.json and that the OpenRouter ` +
        `slug is correct (override with CRITIQUE_HUNTER_MODEL / CRITIQUE_JUDGE_MODEL).`,
    );
  }
  return model;
}

// ---------------------------------------------------------------------------
// Input adapters: diff | file | directory  ->  Scope
// ---------------------------------------------------------------------------
function git(args: string): string {
  return execSync(`git ${args}`, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
}

function buildScope(opts: {
  staged?: boolean;
  diff?: string;
  path?: string;
}): Scope {
  if (opts.staged || opts.diff) {
    const range = opts.staged ? "--staged" : (opts.diff as string);
    const diff = git(`diff ${range} --unified=3`).trim();
    if (!diff) throw new Error(`No changes for \`git diff ${range}\`.`);
    return {
      cwd: process.cwd(),
      label: opts.staged ? "staged changes" : `diff ${opts.diff}`,
      prompt:
        `Review the following git diff. Focus your attention on the CHANGED lines, ` +
        `but read the surrounding code and any related files (the repo root is the ` +
        `current working directory) to understand the change in context.\n\n` +
        "```diff\n" + diff + "\n```",
    };
  }

  const target = opts.path ?? ".";
  const abs = resolve(target);
  if (!existsSync(abs)) throw new Error(`Path not found: ${target}`);

  if (statSync(abs).isDirectory()) {
    return {
      cwd: abs,
      label: `directory ${target}`,
      prompt:
        `Review the source code in this directory (the current working directory). ` +
        `Explore it, prioritise the most important and highest-risk code, and review ` +
        `what matters. Skip vendored, generated, and dependency files.`,
    };
  }

  return {
    cwd: process.cwd(),
    label: `file ${target}`,
    prompt:
      `Review the file \`${target}\`. Read it in full, and read any files it imports ` +
      `or depends on for the context you need.`,
  };
}

// ---------------------------------------------------------------------------
// Tier 1 — hunter agents
// ---------------------------------------------------------------------------
function reportFindingTool(sink: Omit<Finding, "id">[], dimension: string) {
  return defineTool({
    name: "report_finding",
    label: "Report Finding",
    description: "Report a single, verified code-review finding within your dimension.",
    parameters: Type.Object({
      severity: Type.String({ description: "blocker | high | medium | low | nit" }),
      title: Type.String({ description: "One-line summary of the issue" }),
      file: Type.String({ description: "Path to the file (as read)" }),
      startLine: Type.Number({ description: "First line of the issue" }),
      endLine: Type.Number({ description: "Last line of the issue" }),
      rationale: Type.String({ description: "Why this is a problem, citing the code" }),
      suggestion: Type.String({ description: "Concrete fix" }),
      standardRef: Type.String({
        description: 'Rule/standard violated, e.g. "CWE-89", "Clean Code: function length"',
      }),
      confidence: Type.Optional(Type.Number({ description: "0..1" })),
    }),
    execute: async (_id, p: any) => {
      sink.push({
        dimension,
        severity: normSeverity(p.severity),
        title: p.title,
        file: p.file,
        startLine: p.startLine ?? 0,
        endLine: p.endLine ?? p.startLine ?? 0,
        rationale: p.rationale,
        suggestion: p.suggestion,
        standardRef: p.standardRef,
        confidence: p.confidence,
      });
      return { content: [{ type: "text", text: `Recorded: ${p.title}` }], details: {} };
    },
  });
}

async function runHunter(
  spec: HunterSpec,
  scope: Scope,
  ctx: { authStorage: any; modelRegistry: any; model: any },
): Promise<Omit<Finding, "id">[]> {
  const sink: Omit<Finding, "id">[] = [];
  // loader cwd = reviewer dir, NOT the target — so a reviewed repo's AGENTS.md
  // can never inject instructions into our reviewer (prompt-injection hygiene).
  const loader = new DefaultResourceLoader({
    cwd: REVIEWER_DIR,
    agentDir: AGENT_DIR,
    systemPromptOverride: () => spec.charter,
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: scope.cwd,
    model: ctx.model,
    thinkingLevel: "low",
    tools: ["read", "grep", "find", "ls", "report_finding"],
    customTools: [reportFindingTool(sink, spec.key)],
    resourceLoader: loader,
    authStorage: ctx.authStorage,
    modelRegistry: ctx.modelRegistry,
    sessionManager: SessionManager.inMemory(),
  });

  session.subscribe((event: any) => {
    if (event.type === "tool_execution_start") {
      progress(`  ${spec.label}: ${event.toolName}`);
    }
  });

  await session.prompt(scope.prompt);
  session.dispose();
  return sink;
}

// ---------------------------------------------------------------------------
// Dedup (deterministic) — collapse near-identical findings across hunters
// ---------------------------------------------------------------------------
function dedup(raw: Omit<Finding, "id">[]): Finding[] {
  const seen = new Map<string, Finding>();
  let id = 0;
  for (const f of raw) {
    const key = `${f.file}:${f.startLine}:${f.dimension}:${f.title.toLowerCase().slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.set(key, { ...f, id: id++ });
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Tier 2 — judge agent
// ---------------------------------------------------------------------------
function submitVerdictTool(findings: Map<number, Finding>) {
  return defineTool({
    name: "submit_verdict",
    label: "Submit Verdict",
    description: "Record your verdict for one candidate finding (by id).",
    parameters: Type.Object({
      id: Type.Number({ description: "The finding id" }),
      verdict: Type.String({ description: "confirm | reject | revise" }),
      severity: Type.Optional(Type.String({ description: "Corrected severity if revising" })),
      suggestion: Type.Optional(Type.String({ description: "Final actionable suggestion" })),
      note: Type.String({ description: "Why — your verification reasoning" }),
    }),
    execute: async (_id, p: any) => {
      const f = findings.get(p.id);
      if (f) {
        f.verdict = ["confirm", "reject", "revise"].includes(p.verdict) ? p.verdict : "reject";
        f.judgeNote = p.note;
        if (p.severity) f.severity = normSeverity(p.severity);
        if (p.suggestion) f.suggestion = p.suggestion;
      }
      return { content: [{ type: "text", text: `Verdict for #${p.id}: ${p.verdict}` }], details: {} };
    },
  });
}

async function runJudge(
  findings: Finding[],
  scope: Scope,
  ctx: { authStorage: any; modelRegistry: any; model: any },
): Promise<void> {
  if (findings.length === 0) return;
  const byId = new Map(findings.map((f) => [f.id, f]));

  const loader = new DefaultResourceLoader({
    cwd: REVIEWER_DIR,
    agentDir: AGENT_DIR,
    systemPromptOverride: () => JUDGE_PROMPT,
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: scope.cwd,
    model: ctx.model,
    thinkingLevel: "high",
    tools: ["read", "grep", "find", "submit_verdict"],
    customTools: [submitVerdictTool(byId)],
    resourceLoader: loader,
    authStorage: ctx.authStorage,
    modelRegistry: ctx.modelRegistry,
    sessionManager: SessionManager.inMemory(),
  });

  session.subscribe((event: any) => {
    if (event.type === "tool_execution_start" && event.toolName !== "submit_verdict") {
      progress(`  judge: ${event.toolName}`);
    }
  });

  const candidates = findings.map((f) => ({
    id: f.id,
    dimension: f.dimension,
    severity: f.severity,
    title: f.title,
    file: f.file,
    startLine: f.startLine,
    endLine: f.endLine,
    rationale: f.rationale,
    standardRef: f.standardRef,
  }));

  await session.prompt(
    `Here are the candidate findings to verify. Call submit_verdict once per id.\n\n` +
      "```json\n" + JSON.stringify(candidates, null, 2) + "\n```",
  );
  session.dispose();

  // Anything the judge never ruled on is treated as unverified -> rejected.
  for (const f of findings) if (!f.verdict) { f.verdict = "reject"; f.judgeNote = "Not verified by judge."; }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function normSeverity(s: string): Severity {
  const v = (s ?? "").toLowerCase().trim();
  return (SEVERITY_ORDER as string[]).includes(v) ? (v as Severity) : "medium";
}

const QUIET = process.env.CRITIQUE_QUIET === "1";
function progress(msg: string) {
  if (!QUIET) process.stderr.write(dim(msg) + "\n");
}

// minimal ANSI (respect NO_COLOR / non-tty)
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = c("2"), bold = c("1"), red = c("31"), yellow = c("33"), blue = c("34"), green = c("32"), gray = c("90");
const SEV_COLOR: Record<Severity, (s: string) => string> = {
  blocker: c("41;97"), high: red, medium: yellow, low: blue, nit: gray,
};

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function overallVerdict(confirmed: Finding[]): string {
  if (confirmed.some((f) => f.severity === "blocker" || f.severity === "high")) return "REQUEST CHANGES";
  if (confirmed.length > 0) return "APPROVE WITH COMMENTS";
  return "APPROVE";
}

function renderPretty(findings: Finding[], scope: Scope): string {
  const confirmed = findings.filter((f) => f.verdict !== "reject");
  const rejected = findings.filter((f) => f.verdict === "reject");
  const out: string[] = [];

  out.push("");
  out.push(bold(`critique — review of ${scope.label}`));
  // per-dimension tally
  for (const h of HUNTERS) {
    const conf = confirmed.filter((f) => f.dimension === h.key).length;
    const tot = findings.filter((f) => f.dimension === h.key).length;
    out.push(`  ${h.label.padEnd(28)} ${conf} confirmed${tot - conf > 0 ? gray(` (+${tot - conf} rejected)`) : ""}`);
  }
  out.push("");

  for (const sev of SEVERITY_ORDER) {
    const group = confirmed.filter((f) => f.severity === sev);
    for (const f of group) {
      const tag = SEV_COLOR[sev](` ${sev.toUpperCase()} `);
      out.push(`${tag} ${bold(f.title)}  ${gray(`[${f.dimension}] ${f.file}:${f.startLine}`)}`);
      out.push(`    ${f.rationale}`);
      out.push(`    ${green("fix:")} ${f.suggestion}`);
      out.push(`    ${gray(f.standardRef + (f.verdict === "revise" ? " · revised by judge" : ""))}`);
      out.push("");
    }
  }

  if (rejected.length) {
    out.push(gray(`Judge rejected ${rejected.length} candidate(s): ` + rejected.map((f) => f.title).join("; ")));
    out.push("");
  }

  const verdict = overallVerdict(confirmed);
  const vcolor = verdict === "REQUEST CHANGES" ? red : verdict === "APPROVE" ? green : yellow;
  out.push(bold("Verdict: ") + vcolor(verdict) + gray(`  (${confirmed.length} issue(s) confirmed)`));
  out.push("");
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Public API (used by the test) + orchestration
// ---------------------------------------------------------------------------
export async function review(opts: { staged?: boolean; diff?: string; path?: string }): Promise<Finding[]> {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not set.");
  }
  const scope = buildScope(opts);
  const { authStorage, modelRegistry } = setup();
  const hunterModel = requireModel(modelRegistry, HUNTER_MODEL);
  const judgeModel = requireModel(modelRegistry, JUDGE_MODEL);

  progress(`Hunting (${HUNTERS.length} agents on ${HUNTER_MODEL}) over ${scope.label}…`);
  const raw = (
    await Promise.all(
      HUNTERS.map((h) => runHunter(h, scope, { authStorage, modelRegistry, model: hunterModel })),
    )
  ).flat();

  const findings = dedup(raw);
  progress(`Judging ${findings.length} candidate(s) on ${JUDGE_MODEL}…`);
  await runJudge(findings, scope, { authStorage, modelRegistry, model: judgeModel });
  return findings;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
interface CliArgs {
  staged?: boolean;
  diff?: string;
  path?: string;
  json?: boolean;
  markdown?: boolean;
  help?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const o: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--staged") o.staged = true;
    else if (a === "--diff") o.diff = argv[++i];
    else if (a === "--json") o.json = true;
    else if (a === "--markdown") o.markdown = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else if (!a.startsWith("-")) o.path = a;
  }
  return o;
}

const HELP = `critique — agentic multi-tier code reviewer

Usage:
  critique [path]            review a file or directory
  critique --staged          review staged git changes
  critique --diff <range>    review a git diff range (e.g. main..HEAD)

Options:
  --json        emit findings as JSON
  --markdown    emit findings as Markdown (PR-comment friendly)

Env:
  OPENROUTER_API_KEY        required
  CRITIQUE_HUNTER_MODEL     default google/gemini-3.5-flash
  CRITIQUE_JUDGE_MODEL      default anthropic/claude-opus-4.8`;

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if ((o as any).help) { console.log(HELP); return; }
  try {
    const findings = await review(o);
    const confirmed = findings.filter((f) => f.verdict !== "reject");
    if (o.json) {
      console.log(JSON.stringify({ verdict: overallVerdict(confirmed), findings: confirmed }, null, 2));
    } else if (o.markdown) {
      console.log(renderMarkdown(confirmed, overallVerdict(confirmed)));
    } else {
      console.log(renderPretty(findings, buildScope(o)));
    }
  } catch (err: any) {
    process.stderr.write(red(`Error: ${err.message}`) + "\n");
    process.exit(1);
  }
}

function renderMarkdown(confirmed: Finding[], verdict: string): string {
  const lines = [`## critique review — **${verdict}** (${confirmed.length} confirmed)`, ""];
  for (const sev of SEVERITY_ORDER) {
    for (const f of confirmed.filter((x) => x.severity === sev)) {
      lines.push(`- **[${sev}] ${f.title}** \`${f.file}:${f.startLine}\` _(${f.dimension}, ${f.standardRef})_`);
      lines.push(`  - ${f.rationale}`);
      lines.push(`  - _fix:_ ${f.suggestion}`);
    }
  }
  return lines.join("\n");
}

// run as CLI when invoked directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
