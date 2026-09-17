---
name: jev-review
description: Check a diff against the repo's written rules and Rob's personal code principles using Jev, a fast classifier. Run the rules check after each coherent implementation slice and before final handoff; use the jev_review scorecard only as a secondary signal. Also use when asked to add, tune, or calibrate a rule. Skip for formatting-only or docs-only changes.
---

# Jev Review

Jev is a **System One model**: a classifier that answers typed questions in ~200 ms. It does not reason about code. Measured consequences, which shape everything below:

- Asked a **generic** question about a bare diff ("is correctness strong?"), it cannot tell a bug from its fix. It rated three known bugs the same as, or better than, their fixes.
- Asked a **pointed** question with the **rule written down**, it separates them cleanly (bug 0.72–0.95, fix 0.05–0.09 on the same pairs).

So the knowledge has to come from you. Jev's job is to check a diff against rules that are already written, cheaply enough to do on every slice.

## 1. Rules check (primary)

```sh
node <this-skill-dir>/scripts/jev-rules.mjs              # working tree vs HEAD
node <this-skill-dir>/scripts/jev-rules.mjs --base main  # whole branch
```

It merges two rule lists and asks one yes/no question per rule, per changed file:

- `principles.json` next to this file — personal principles, applied in every repo.
- `.jev/rules.json` at the repo root — that repo's invariants. Absent is fine.

Output is `probability  rule-id  file`, highest first. Exit `0` clean, `1` hits at or above `--threshold` (default 0.6), `2` could not run. `--json` returns every probability, not just hits. Needs `JEV_API_KEY`. Untracked files are not in `git diff`; `git add -N` them first.

**Reading a hit.** A hit is a pointer, not a verdict. Open the file, read the rule, decide.

- ≥ 0.8: almost always real, or the diff's *context lines* contain a violation you did not write. Both are worth knowing.
- 0.6–0.8: read the code. Often a rule worded too broadly.
- A hit you judge wrong is a **rule bug**. Tighten the rule's wording or its `paths` rather than ignoring it, or it will fire again forever.
- A 5xx from the API means no answer. Never report a check that did not run as clean.

Correctness and the user's requirements outrank every rule. Never restructure sound code just to lower a probability.

## 2. Writing rules

```json
{ "rules": [ { "id": "kebab-case-id", "paths": "optional regex on file path", "rule": "…" } ] }
```

A rule that discriminates has three parts, in plain prose: **what is forbidden**, **why** (the failure it causes), and **what to do instead**. Name the concrete APIs and identifiers a violation would contain.

- One rule, one concern. Jev works best on many small independent questions.
- State exemptions in the rule ("code inside X itself is exempt").
- Use `paths` to keep a rule off files it cannot apply to. It is the main false-positive control.
- Vague principles ("write clean code") do not discriminate. If you cannot describe what a violation looks like, it is not a rule yet.
- Good sources: a repo's CLAUDE.md / AGENTS.md invariants, postmortems, and anything a reviewer has had to say twice.

**Calibrate every new rule** before trusting it. Write the smallest diff that violates it and the same diff fixed, then:

```sh
node scripts/jev-rules.mjs --rules my-rules.json --diff-file bad.diff  --json
node scripts/jev-rules.mjs --rules my-rules.json --diff-file good.diff --json
```

Keep the rule when bad scores ≥ 0.7 and good ≤ 0.3. Otherwise reword and retry; it takes seconds.

When the user corrects the same kind of mistake twice, or a bug ships that a written rule would have caught, propose a new rule for `.jev/rules.json` (repo-specific) or `principles.json` (applies everywhere).

## 3. Scorecard (secondary)

The `jev_review` MCP tool scores 19 generic dimensions. Run-to-run noise is about ±0.3, so ignore any change under 0.5, and ignore dimensions whose confidence is under ~0.4. Its issue text is a fixed menu with no locations.

It is only informative when you put the relevant rules and invariants into `repositoryContext`; without them it sees a diff and guesses. Use it as a coarse "this slice looks large or risky" signal and for `previousEvaluation` comparisons across a refactor. Do not use it to find bugs, and never optimise code toward its scores.

## Cadence

1. Implement a coherent slice; run fast local checks.
2. Run the rules check. Investigate hits; fix real ones; fix the rule for false ones.
3. Re-run after fixes and once more before handoff, against the branch base.
4. Jev complements tests, type checks, and a reasoning reviewer. It replaces none of them: it only knows the rules someone wrote down.

Do not send secrets, credentials, environment files, generated output, or vendored code. Every call sends the diff to the Jev API.
