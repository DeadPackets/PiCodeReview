# critique

A code reviewer that works like a review panel instead of one model skimming a diff.
A few specialist agents read the code the way a senior reviewer would: they grep, open
files, follow a reference into another module. Then a stronger model checks everything
they flagged against the real code before any of it reaches you.

Built on the [Pi SDK](https://pi.dev/docs/latest/sdk) (`@earendil-works/pi-coding-agent`)
with OpenRouter as the provider, so pointing it at a different model is a one-line change.

## How it works

```
input (git diff | file | directory)
  │
  ├─ Tier 1: four hunter agents, run in parallel, on a cheap model (gemini-3.5-flash)
  │     readability, structure/maintainability, correctness, security
  │     each gets read-only tools (read/grep/find/ls), explores the code,
  │     follows references across files, and reports what it finds
  │
  ├─ dedup (plain, deterministic)
  │
  └─ Tier 2: one judge agent, on a strong model (claude-opus-4.8)
        re-reads the cited code, confirms or throws out each finding,
        fixes the severity when it's wrong, and writes the actual fix
  → CLI report (also --json and --markdown)
```

The two tiers split the work along the line where recall and precision pull against each
other. The cheap model runs wide and is told to over-report; false positives are fine at
that stage. The expensive model runs narrow. It only ever sees the deduped shortlist, and
its whole job is to reject whatever doesn't hold up against the real code. So you pay
frontier prices for the small slice of work that actually needs frontier judgment.

Why agents and not chunk-the-file-and-prompt? Because most real findings depend on context
the file itself doesn't contain. Tainted input reaches a sink three files over. A function's
contract lives in the module that defines it, not the one that calls it. An agent that can
grep and open files reasons about that. A fixed context window can't.

The rubrics aren't my taste talking. They come from Google's
[Engineering Practices](https://google.github.io/eng-practices/review/), Robert Martin's
*Clean Code*, and the [CWE Top 25](https://cwe.mitre.org/top25/) plus OWASP Top 10 for the
security pass.

## Keeping the cost down

A few deliberate choices, given the 30-60 minute brief:

- The high-volume exploration runs on the cheap model. The expensive model only ever judges
  the shortlist.
- Each agent's charter and tool set are fixed for the whole run, so the system+tools prefix
  is byte-identical turn to turn and the provider can cache it. Only the small tail (the
  scope, the candidate findings) changes.
- Hunters think on "low" and are told to grep first rather than read whole trees. Dedup
  runs before the judge, so it never pays to verify the same thing twice.

One honest caveat: the SDK hides the wire format, so caching here means keeping the prefix
stable and letting the provider do its thing, not hand-rolling `cache_control` headers.

## Running it

```bash
npm install
export OPENROUTER_API_KEY=sk-or-...

npm run critique -- fixtures/sample.ts              # a file
npm run critique -- src/                            # a directory
npm run critique -- --staged                        # staged git changes
npm run critique -- --diff main..HEAD               # a diff range
npm run critique -- fixtures/sample.ts --markdown   # output you can paste into a PR

npm test                                            # one live test against the fixture
```

Swap models with `CRITIQUE_HUNTER_MODEL` and `CRITIQUE_JUDGE_MODEL` (any OpenRouter slug).

One security note worth calling out: each agent loads its system prompt from a fixed path in
this repo, never from the code under review. So a planted `AGENTS.md` in some target repo
can't talk the reviewer into ignoring its own bugs.

## The 100-word version (for the challenge writeup)

> A multi-tier code reviewer. Four specialist agents (readability, structure, correctness,
> security) run in parallel on a cheap, fast model with read-only tools. They explore the
> code like a real reviewer, grepping and following references across files, and they
> over-report on purpose. Then a frontier model judges the shortlist: it re-reads the cited
> code, drops the false positives, fixes the severities, and writes the actual fix. You get
> frontier-level precision while paying the cheap model for most of the work. Rubrics come
> from Google's Engineering Practices, Clean Code, and the CWE Top 25. Built on the Pi SDK
> over OpenRouter.
