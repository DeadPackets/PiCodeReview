# critique

An **agentic, multi-tier code reviewer**. Instead of one model skimming a file, a panel
of specialist agents *explores the codebase the way a senior reviewer does* — grepping,
reading, and following references **across files** — then a frontier-model judge verifies
every finding against the real code before anything reaches you.

Built on the [Pi SDK](https://pi.dev/docs/latest/sdk) (`@earendil-works/pi-coding-agent`)
with **OpenRouter** as the provider, so any model is one config line away.

## How it works

```
input (git diff | file | directory)
  │
  ├─ Tier 1 — four hunter agents run in parallel  (cheap model: gemini-3.5-flash)
  │     Readability · Structure/Maintainability · Correctness/Bugs · Security
  │     each has read-only tools (read/grep/find/ls) and explores agentically,
  │     following code across files, then reports structured findings
  │
  ├─ dedup  (deterministic)
  │
  └─ Tier 2 — judge agent  (frontier model: claude-opus-4.8)
        re-reads the cited code, confirms / rejects / revises each finding,
        calibrates severity, and writes the final fix
  → rich CLI report (also --json / --markdown)
```

**Why two tiers:** the cheap model is run for *recall* (find every candidate, even at the
cost of false positives); the expensive model is run for *precision* (verify against the
real code and throw out what doesn't hold up). You get frontier-quality results at a
fraction of frontier cost.

**Why agentic (not chunk-and-prompt):** real review needs context. A finding often depends
on how code is *used* elsewhere — tainted input reaching a sink in another file, a function
whose contract is defined two modules away. The hunters and the judge can grep and read
across the repo to reason about that, which a fixed-window prompt can't.

The rubrics aren't personal taste — they're grounded in respected standards:
[Google's Engineering Practices](https://google.github.io/eng-practices/review/),
*Clean Code*, and the [CWE Top 25 (2024)](https://cwe.mitre.org/top25/) / OWASP Top 10 for security.

## Cost discipline

- **Tiered models** — the high-volume exploration runs on the cheap model; the frontier
  model only judges the (deduped) shortlist.
- **Cacheable prefixes** — each agent's charter and tool set are *stable*, so the
  system+tools prefix is reused across every turn of the agent loop; only the small
  variable suffix (the scope / candidate findings) changes.
- **Grep-first prompting** and low thinking for hunters; **dedup before the judge**.

## Run it

```bash
npm install
export OPENROUTER_API_KEY=sk-or-...

npm run critique -- fixtures/sample.ts     # review a file
npm run critique -- src/                    # review a directory
npm run critique -- --staged                # review staged git changes
npm run critique -- --diff main..HEAD       # review a diff range
npm run critique -- fixtures/sample.ts --markdown   # PR-comment output

npm test                                    # single live test on the fixture
```

Models are overridable: `CRITIQUE_HUNTER_MODEL`, `CRITIQUE_JUDGE_MODEL` (any OpenRouter slug).

A small security note: the reviewer loads its own system prompt from a fixed location, not
from the repo under review, so a malicious `AGENTS.md` in a target repo can't hijack it.

## The challenge submission (≈100 words)

> **Smart Code Reviewer.** A multi-tier, agentic reviewer. Four specialist agents —
> readability, structure, correctness, security — run in parallel on a cheap, fast model
> (Gemini 3.5 Flash) with read-only tools, exploring the codebase agentically and following
> references across files for real context. They over-report by design; a frontier-model
> judge (Claude Opus 4.8) then re-reads the cited code, rejects false positives, calibrates
> severity, and writes the fix. The result is frontier-quality precision at a fraction of the
> cost. Rubrics are grounded in Google's Engineering Practices, Clean Code, and the CWE Top 25.
> Built on the Pi SDK over OpenRouter, so swapping models is a one-line change.
