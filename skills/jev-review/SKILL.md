---
name: jev-review
description: Check a diff against written rules using Jev, a fast classifier - the user's personal rules plus the repository's own. Run the jev_rules check after each coherent implementation slice and before final handoff; use the jev_review scorecard only as a secondary signal. Also use when asked to add, tune, or calibrate a rule. Skip for formatting-only or docs-only changes.
---

# Jev Review

Jev is a **System One model**: a classifier that answers typed questions in ~200 ms. It does not reason about code. Measured consequences, which shape everything below:

- Asked a **generic** question about a bare diff ("is correctness strong?"), it cannot tell a bug from its fix. It rated known bugs the same as, or better than, their fixes.
- Asked a **pointed** question with the **rule written down**, it separates them cleanly (bug 0.72–0.95, fix 0.05–0.09 on the same pairs).

So the knowledge has to come from written rules. Jev's job is to check a diff against them, cheaply enough to do on every slice.

## 1. Rules check (primary)

Call the `jev_rules` MCP tool with `repoRoot` set to the repository's absolute path. The server runs `git diff` itself, so do not paste the diff:

```json
{ "repoRoot": "/abs/path/to/repo" }
{ "repoRoot": "/abs/path/to/repo", "base": "main" }
```

The first checks the working tree against `HEAD`; the second checks the whole branch. Rules are merged from four sources, later overriding earlier by `id`:

- Built-in: universal practice shipped with the server (`hardcoded-secret`, `injection`, `tests-weakened`, `debug-leftover`, `suppressed-check`, `sensitive-data-logged`).
- `~/.jev/rules.json`: the user's personal rules, applied in every repository.
- `<repoRoot>/.jev/rules.json`: that repository's invariants. Absent is fine.
- `rules` passed inline: for trying out or calibrating a rule.

A rules file may also set `limits` (`maxFileLines`, `maxFilesPerDirectory`, `ignorePaths`). These are exact counts checked locally, reported as `limitHits`, and only for what the diff makes worse: a file over the limit that this diff grew, or a crowded directory this diff added a file to. When one fires, split the file or move the new file into a subfolder as part of the change rather than deferring it.

The result lists `hits` (`probability`, `rule`, `file`) at or above `threshold` (default 0.6), plus `skippedFiles` for diffs too large to send. Untracked files are not in `git diff`; `git add -N` them first.

**Reading a hit.** A hit is a pointer, not a verdict. Open the file, read the rule, decide.

- ≥ 0.8: almost always real, or the diff's *context lines* contain a violation that was already there. Both are worth knowing.
- 0.6–0.8: read the code. Often a rule worded too broadly.
- A hit you judge wrong is a **rule bug**. Tighten the rule's wording or its `paths` rather than ignoring it, or it will fire again forever.
- A tool error means the check did not run. Never report that as clean, and review any `skippedFiles` by hand.

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
- Good sources: the repository's CLAUDE.md / AGENTS.md invariants, postmortems, and anything a reviewer has had to say twice.
- Put a rule in `.jev/rules.json` when it is about this codebase, and in `~/.jev/rules.json` when it is how the user wants code written everywhere. Practice that holds for every codebase and every user belongs in the built-in list.
- A rules file switches off a lower-precedence rule with `"disable": ["rule-id"]`, or replaces it by reusing its `id`.

**Calibrate every new rule** before trusting it. Write the smallest diff that violates it and the same diff fixed, then call `jev_rules` once with each:

```json
{ "diff": "<bad or good diff>", "rules": [ { "id": "my-rule", "rule": "…" } ], "includeAll": true }
```

Read your rule's probability in `all`. Keep the rule when bad scores ≥ 0.7 and good ≤ 0.3. Otherwise reword and retry; it takes seconds.

When the user corrects the same kind of mistake twice, or a bug ships that a written rule would have caught, propose a new rule and where it belongs.

## 3. Scorecard (secondary)

The `jev_review` tool scores 19 generic dimensions. Run-to-run noise is about ±0.3, so ignore any change under 0.5, and ignore dimensions whose confidence is under ~0.4. Its issue text is a fixed menu with no locations.

It is only informative when you put the relevant rules and invariants into `repositoryContext`; without them it sees a diff and guesses. Use it as a coarse "this slice looks large or risky" signal and for `previousEvaluation` comparisons across a refactor. Do not use it to find bugs, and never optimise code toward its scores.

## Cadence

1. Implement a coherent slice; run fast local checks.
2. Run the rules check. Investigate hits; fix real ones; fix the rule for false ones.
3. Re-run after fixes and once more before handoff, against the branch base.
4. Jev complements tests, type checks, and a reasoning reviewer. It replaces none of them: it only knows the rules someone wrote down.

Do not send secrets, credentials, environment files, generated output, or vendored code. Every call sends the diff to the Jev API.
