import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { getJevApiKey } from "../config/environment.js";
import type { JevQuestions } from "../evaluation/questions.js";
import { JevClient } from "../jev/client.js";
import { builtinRules } from "./builtin.js";

const MAX_FILE_DIFF_BYTES = 100_000;
const CONCURRENCY = 8;
const MAX_COUNTED_FILE_BYTES = 5_000_000;

export const ruleSchema = z
  .object({
    id: z.string().min(1),
    rule: z.string().min(1),
    /** Regex on the changed file's path. Omitted: the rule applies to every file. */
    paths: z.string().min(1).optional()
  })
  .strict();

/** Exact counts, checked locally. A classifier should not be asked to count. */
export const limitsSchema = z
  .object({
    maxFileLines: z.number().int().positive().optional(),
    maxFilesPerDirectory: z.number().int().positive().optional(),
    /** Regex on the changed file's path; matching files are exempt from every limit. */
    ignorePaths: z.string().min(1).optional()
  })
  .strict();

const ruleFileSchema = z.object({
  rules: z.array(ruleSchema).default([]),
  limits: limitsSchema.optional(),
  /** Ids of rules from a lower-precedence source (built-in or personal) to switch off. */
  disable: z.array(z.string()).default([])
});

export type Limits = z.infer<typeof limitsSchema>;
type RuleFile = z.infer<typeof ruleFileSchema>;

export type Rule = z.infer<typeof ruleSchema>;

export const rulesInputSchema = z
  .object({
    repoRoot: z.string().min(1).optional(),
    base: z.string().min(1).optional(),
    diff: z.string().min(1).optional(),
    rules: z.array(ruleSchema).optional(),
    threshold: z.number().min(0).max(1).optional(),
    includeAll: z.boolean().optional()
  })
  .strict();

export type RulesInput = z.infer<typeof rulesInputSchema>;

const resultSchema = z.object({
  file: z.string(),
  rule: z.string(),
  probability: z.number(),
  text: z.string()
});

export const rulesOutputSchema = z.object({
  threshold: z.number(),
  ruleSources: z.array(z.string()),
  rulesLoaded: z.number(),
  filesChecked: z.number(),
  skippedFiles: z.array(z.string()),
  hits: z.array(resultSchema),
  limitHits: z.array(z.object({ path: z.string(), limit: z.string(), value: z.number(), max: z.number() })),
  all: z.array(resultSchema).optional()
});

export type RulesOutput = z.infer<typeof rulesOutputSchema>;

export const USER_RULES_PATH = join(homedir(), ".jev", "rules.json");

export function repoRulesPath(repoRoot: string): string {
  return join(repoRoot, ".jev", "rules.json");
}

/** Later sources override earlier ones by id: built-in < user < repo < inline. */
export function mergeRules(sources: Rule[][]): Rule[] {
  const merged = new Map<string, Rule>();
  for (const source of sources) for (const rule of source) merged.set(rule.id, rule);
  return [...merged.values()];
}

export function readRuleFile(path: string): RuleFile | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = ruleFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`${path} is not a valid rules file: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

/**
 * Flags only what the diff makes worse: a file over the line limit that this
 * diff grew, and a directory over the file limit that this diff added a file to.
 */
export function checkLimits(repoRoot: string, chunks: Array<{ file: string; diff: string }>, limits: Limits): RulesOutput["limitHits"] {
  const hits: RulesOutput["limitHits"] = [];
  const crowded = new Set<string>();
  const ignored = limits.ignorePaths ? new RegExp(limits.ignorePaths) : undefined;
  for (const chunk of chunks) {
    if (ignored?.test(chunk.file)) continue;
    const path = resolve(repoRoot, chunk.file);
    if (relative(repoRoot, path).startsWith("..") || !existsSync(path)) continue;

    const lines = chunk.diff.split("\n");
    const added = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
    const removed = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
    if (limits.maxFileLines && added > removed && statSync(path).size <= MAX_COUNTED_FILE_BYTES) {
      const value = readFileSync(path, "utf8").split("\n").length;
      if (value > limits.maxFileLines) hits.push({ path: chunk.file, limit: "maxFileLines", value, max: limits.maxFileLines });
    }

    const directory = dirname(path);
    if (limits.maxFilesPerDirectory && chunk.diff.includes("\nnew file mode") && !crowded.has(directory)) {
      const value = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile()).length;
      if (value > limits.maxFilesPerDirectory) {
        crowded.add(directory);
        hits.push({ path: dirname(chunk.file), limit: "maxFilesPerDirectory", value, max: limits.maxFilesPerDirectory });
      }
    }
  }
  return hits;
}

export function splitDiff(diff: string): Array<{ file: string; diff: string }> {
  return diff
    .split(/^(?=diff --git )/m)
    .filter((chunk) => chunk.startsWith("diff --git "))
    .map((chunk) => ({ file: chunk.match(/^diff --git a\/(.+?) b\//)?.[1] ?? "(unknown)", diff: chunk }));
}

export function rulesFor(file: string, rules: Rule[]): Rule[] {
  return rules.filter((rule) => !rule.paths || new RegExp(rule.paths).test(file));
}

export function buildRuleQuestions(rules: Rule[]): JevQuestions {
  return Object.fromEntries(
    rules.map((rule) => [
      rule.id,
      {
        type: "noul",
        instructions: `Rule: ${rule.rule}\n\nAfter this diff is applied, does the code it touches violate this rule? Answer false when the diff has nothing to do with the rule.`,
        criteria: {
          true: "The resulting code violates the rule.",
          false: "The resulting code complies with the rule, or the rule does not apply to this diff."
        }
      }
    ])
  );
}

async function gitDiff(repoRoot: string, base: string): Promise<string> {
  // `base` comes from the caller; a leading dash would be read by git as an option.
  if (base.startsWith("-")) throw new Error("base must be a git ref, not an option.");
  const { stdout } = await promisify(execFile)("git", ["diff", base, "--"], {
    cwd: repoRoot,
    maxBuffer: 1 << 28,
    timeout: 30_000
  });
  return stdout;
}

export type RulesDependencies = {
  client?: Pick<JevClient, "evaluate">;
  userRulesPath?: string;
};

export async function checkRules(rawInput: RulesInput, dependencies: RulesDependencies = {}): Promise<RulesOutput> {
  const input = rulesInputSchema.parse(rawInput);
  if (!input.diff && !input.repoRoot) throw new Error("Provide repoRoot (to diff the working tree) or diff.");

  const userPath = dependencies.userRulesPath ?? USER_RULES_PATH;
  const files = [userPath, ...(input.repoRoot ? [repoRulesPath(input.repoRoot)] : [])];
  const loaded = files.flatMap((path) => {
    const file = readRuleFile(path);
    return file ? [{ path, ...file }] : [];
  });
  const disabled = new Set(loaded.flatMap((entry) => entry.disable));
  const rules = mergeRules([builtinRules, ...loaded.map((entry) => entry.rules), input.rules ?? []]).filter(
    (rule) => !disabled.has(rule.id)
  );
  const limits: Limits = Object.assign({}, ...loaded.map((entry) => entry.limits ?? {}));
  if (rules.length === 0 && !limits.maxFileLines && !limits.maxFilesPerDirectory) {
    throw new Error(`No rules found. Add ${userPath} (personal), .jev/rules.json at the repo root, or pass rules inline.`);
  }

  // `git diff <base>` covers committed and uncommitted work; untracked files are not included.
  const diff = input.diff ?? (await gitDiff(input.repoRoot as string, input.base ?? "HEAD"));
  const threshold = input.threshold ?? 0.6;

  const skippedFiles: string[] = [];
  const chunks = splitDiff(diff);
  const limitHits = input.repoRoot ? checkLimits(input.repoRoot, chunks, limits) : [];
  const work = chunks.flatMap((chunk) => {
    const applicable = rulesFor(chunk.file, rules);
    if (applicable.length === 0) return [];
    if (Buffer.byteLength(chunk.diff) > MAX_FILE_DIFF_BYTES) {
      skippedFiles.push(chunk.file);
      return [];
    }
    return [{ ...chunk, rules: applicable }];
  });

  // Every applicable rule rides in one request per file; chunk the question
  // map here if a rule list ever outgrows what the API accepts.
  const all: RulesOutput["hits"] = [];
  const client = work.length === 0 ? undefined : dependencies.client ?? new JevClient({ apiKey: getJevApiKey() });
  for (let index = 0; index < work.length; index += CONCURRENCY) {
    await Promise.all(
      work.slice(index, index + CONCURRENCY).map(async (item) => {
        const response = await (client as Pick<JevClient, "evaluate">).evaluate({ diff: item.diff }, buildRuleQuestions(item.rules));
        for (const rule of item.rules) {
          const answer = response.answers[rule.id];
          if (answer?.type !== "noul") throw new Error(`Jev returned no answer for rule "${rule.id}" on ${item.file}.`);
          all.push({ file: item.file, rule: rule.id, probability: answer.noul, text: rule.rule });
        }
      })
    );
  }

  all.sort((a, b) => b.probability - a.probability);
  return {
    threshold,
    ruleSources: ["built-in", ...loaded.map((entry) => entry.path), ...(input.rules?.length ? ["inline"] : [])],
    rulesLoaded: rules.length,
    filesChecked: work.length,
    skippedFiles,
    hits: all.filter((result) => result.probability >= threshold),
    limitHits,
    ...(input.includeAll ? { all } : {})
  };
}
