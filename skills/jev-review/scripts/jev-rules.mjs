#!/usr/bin/env node
// Checks a diff against written rules using Jev. One pointed yes/no question
// per rule, one API call per changed file, so every hit names a rule AND a file.
//
// Rules come from two places, merged:
//   <skill>/principles.json      personal principles, apply in every repo
//   <repo>/.jev/rules.json       that repo's own invariants
//
// Exit: 0 clean · 1 violations at/above threshold · 2 could not run.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MAX_FILE_DIFF_BYTES = 100_000;
const CONCURRENCY = 8;

export function loadRules(paths) {
  const rules = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    for (const rule of parsed.rules ?? []) {
      if (!rule.id || !rule.rule) throw new Error(`${path}: every rule needs "id" and "rule"`);
      if (rules.some(r => r.id === rule.id)) throw new Error(`${path}: duplicate rule id "${rule.id}"`);
      rules.push(rule);
    }
  }
  return rules;
}

/** Splits a unified diff into one chunk per file. */
export function splitDiff(diff) {
  return diff
    .split(/^(?=diff --git )/m)
    .filter(chunk => chunk.startsWith("diff --git "))
    .map(chunk => ({ file: chunk.match(/^diff --git a\/(.+?) b\//)?.[1] ?? "(unknown)", diff: chunk }));
}

/** A rule with `paths` (a regex) only applies to matching files. */
export function rulesFor(file, rules) {
  return rules.filter(rule => !rule.paths || new RegExp(rule.paths).test(file));
}

export function buildQuestions(rules) {
  return Object.fromEntries(rules.map(rule => [rule.id, {
    type: "noul",
    instructions: `Rule: ${rule.rule}\n\nAfter this diff is applied, does the code it touches violate this rule? Answer false when the diff has nothing to do with the rule.`,
    criteria: {
      true: "The resulting code violates the rule.",
      false: "The resulting code complies with the rule, or the rule does not apply to this diff."
    }
  }]));
}

async function ask(apiKey, state, questions) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ state, model: "jev-latest", questions })
    });
    if (response.ok) return (await response.json()).answers;
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === 2) throw new Error(`Jev API ${response.status}: ${(await response.text()).slice(0, 300)}`);
    await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
  }
}

function parseArgs(argv) {
  const args = { base: "HEAD", threshold: 0.6, json: false, diffFile: null, rulesFile: null };
  for (let i = 0; i < argv.length; i += 1) {
    const value = () => argv[++i] ?? fail(`${argv[i - 1]} needs a value`);
    if (argv[i] === "--base") args.base = value();
    else if (argv[i] === "--threshold") args.threshold = Number(value());
    else if (argv[i] === "--diff-file") args.diffFile = value();
    else if (argv[i] === "--rules") args.rulesFile = value();
    else if (argv[i] === "--json") args.json = true;
    else fail(`unknown argument ${argv[i]}\nusage: jev-rules [--base <ref>] [--threshold 0.6] [--diff-file <path>] [--rules <path>] [--json]`);
  }
  return args;
}

function fail(message) {
  console.error(`jev-rules: ${message}`);
  process.exit(2);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.JEV_API_KEY || fail("JEV_API_KEY is not set");
  const skillDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

  const rules = loadRules(args.rulesFile
    ? [args.rulesFile]
    : [join(skillDir, "principles.json"), join(repoRoot, ".jev", "rules.json")]);
  if (rules.length === 0) fail("no rules found (expected principles.json in the skill and/or .jev/rules.json in the repo)");

  // `git diff <base>` covers committed and uncommitted work; untracked files are not included.
  const diff = args.diffFile
    ? readFileSync(args.diffFile, "utf8")
    : execFileSync("git", ["diff", args.base], { encoding: "utf8", maxBuffer: 1 << 28 });

  const work = [];
  for (const chunk of splitDiff(diff)) {
    const applicable = rulesFor(chunk.file, rules);
    if (applicable.length === 0) continue;
    if (Buffer.byteLength(chunk.diff) > MAX_FILE_DIFF_BYTES) {
      console.error(`jev-rules: skipped ${chunk.file} (diff over ${MAX_FILE_DIFF_BYTES} bytes) — review it by hand`);
      continue;
    }
    work.push({ ...chunk, rules: applicable });
  }

  // ponytail: every applicable rule rides in one request per file; chunk the
  // question map if a repo's rule list ever outgrows what the API accepts.
  const results = [];
  for (let i = 0; i < work.length; i += CONCURRENCY) {
    await Promise.all(work.slice(i, i + CONCURRENCY).map(async item => {
      const answers = await ask(apiKey, { diff: item.diff }, buildQuestions(item.rules));
      for (const rule of item.rules) {
        results.push({ file: item.file, rule: rule.id, probability: answers[rule.id]?.noul ?? null, text: rule.rule });
      }
    }));
  }

  const hits = results
    .filter(result => result.probability !== null && result.probability >= args.threshold)
    .sort((a, b) => b.probability - a.probability);

  if (args.json) {
    console.log(JSON.stringify({ threshold: args.threshold, filesChecked: work.length, rules: rules.length, hits, all: results }, null, 2));
  } else {
    console.log(`jev-rules: ${rules.length} rules × ${work.length} files, threshold ${args.threshold}`);
    for (const hit of hits) console.log(`  ${hit.probability.toFixed(2)}  ${hit.rule}  ${hit.file}\n        ${hit.text}`);
    if (hits.length === 0) console.log("  no likely violations");
  }
  process.exit(hits.length > 0 ? 1 : 0);
}

// The skill directory is usually a symlink, so compare real paths.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => fail(error.message));
}
