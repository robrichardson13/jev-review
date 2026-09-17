import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { getJevApiKey } from "../config/environment.js";
import type { JevQuestions } from "../evaluation/questions.js";
import { JevClient } from "../jev/client.js";

const MAX_FILE_DIFF_BYTES = 100_000;
const CONCURRENCY = 8;

export const ruleSchema = z
  .object({
    id: z.string().min(1),
    rule: z.string().min(1),
    /** Regex on the changed file's path. Omitted: the rule applies to every file. */
    paths: z.string().min(1).optional()
  })
  .strict();

const ruleFileSchema = z.object({ rules: z.array(ruleSchema) });

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
  all: z.array(resultSchema).optional()
});

export type RulesOutput = z.infer<typeof rulesOutputSchema>;

export const USER_RULES_PATH = join(homedir(), ".jev", "rules.json");

export function repoRulesPath(repoRoot: string): string {
  return join(repoRoot, ".jev", "rules.json");
}

/** Later sources override earlier ones by id: user < repo < inline. */
export function mergeRules(sources: Rule[][]): Rule[] {
  const merged = new Map<string, Rule>();
  for (const source of sources) for (const rule of source) merged.set(rule.id, rule);
  return [...merged.values()];
}

export function readRuleFile(path: string): Rule[] | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = ruleFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`${path} is not a valid rules file: ${parsed.error.issues[0]?.message}`);
  return parsed.data.rules;
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
  const loaded = files.map((path) => ({ path, rules: readRuleFile(path) })).filter((entry) => entry.rules);
  const rules = mergeRules([...loaded.map((entry) => entry.rules ?? []), input.rules ?? []]);
  if (rules.length === 0) {
    throw new Error(`No rules found. Add ${userPath} (personal), .jev/rules.json at the repo root, or pass rules inline.`);
  }

  // `git diff <base>` covers committed and uncommitted work; untracked files are not included.
  const diff = input.diff ?? (await gitDiff(input.repoRoot as string, input.base ?? "HEAD"));
  const threshold = input.threshold ?? 0.6;
  const client = dependencies.client ?? new JevClient({ apiKey: getJevApiKey() });

  const skippedFiles: string[] = [];
  const work = splitDiff(diff).flatMap((chunk) => {
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
  for (let index = 0; index < work.length; index += CONCURRENCY) {
    await Promise.all(
      work.slice(index, index + CONCURRENCY).map(async (item) => {
        const response = await client.evaluate({ diff: item.diff }, buildRuleQuestions(item.rules));
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
    ruleSources: [...loaded.map((entry) => entry.path), ...(input.rules?.length ? ["inline"] : [])],
    rulesLoaded: rules.length,
    filesChecked: work.length,
    skippedFiles,
    hits: all.filter((result) => result.probability >= threshold),
    ...(input.includeAll ? { all } : {})
  };
}
