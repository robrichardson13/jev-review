import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { JevResponse } from "../src/jev/schema.js";
import { builtinRules } from "../src/rules/builtin.js";
import { checkLimits, checkRules, mergeRules, rulesFor, splitDiff } from "../src/rules/rules.js";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new
diff --git a/docs/b.md b/docs/b.md
--- a/docs/b.md
+++ b/docs/b.md
@@ -1 +1 @@
-x
+y
`;

describe("rules check", () => {
  it("splits a diff per file, scopes rules by path, and lets later sources override by id", () => {
    assert.deepEqual(splitDiff(DIFF).map((chunk) => chunk.file), ["src/a.ts", "docs/b.md"]);

    const rules = [{ id: "everywhere", rule: "r" }, { id: "src-only", rule: "r", paths: "^src/" }];
    assert.deepEqual(rulesFor("docs/b.md", rules).map((rule) => rule.id), ["everywhere"]);

    const merged = mergeRules([[{ id: "one", rule: "user" }], [{ id: "one", rule: "repo" }, { id: "two", rule: "r" }]]);
    assert.deepEqual(merged.map((rule) => rule.rule), ["repo", "r"]);
  });

  it("merges user, repo, and inline rules and reports only hits at or above the threshold", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-rules-"));
    const userRulesPath = join(dir, "user.json");
    writeFileSync(userRulesPath, JSON.stringify({ rules: [{ id: "personal", rule: "p" }], disable: builtinRules.map((rule) => rule.id).slice(1) }));
    mkdirSync(join(dir, ".jev"));
    writeFileSync(join(dir, ".jev", "rules.json"), JSON.stringify({ rules: [{ id: "repo-src", rule: "r", paths: "^src/" }] }));

    const asked: string[][] = [];
    const client = {
      evaluate: async (_state: unknown, questions: Record<string, unknown>): Promise<JevResponse> => {
        asked.push(Object.keys(questions));
        return {
          model: "fake",
          answers: Object.fromEntries(
            Object.keys(questions).map((id) => [id, { type: "noul" as const, noul: id === "repo-src" ? 0.9 : 0.1 }])
          )
        } as JevResponse;
      }
    };

    const output = await checkRules(
      { repoRoot: dir, diff: DIFF, rules: [{ id: "inline", rule: "i" }] },
      { client, userRulesPath }
    );

    assert.deepEqual(asked.map((ids) => ids.sort()).sort(), [["hardcoded-secret", "inline", "personal"], ["hardcoded-secret", "inline", "personal", "repo-src"]]);
    assert.equal(output.rulesLoaded, 4);
    assert.deepEqual(output.hits.map((hit) => `${hit.rule}@${hit.file}`), ["repo-src@src/a.ts"]);
    assert.equal(output.all, undefined);
  });

  it("flags a grown file over the line limit and a crowded directory a file was added to", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-limits-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "big.ts"), "line\n".repeat(50));
    writeFileSync(join(dir, "src", "shrunk.ts"), "line\n".repeat(50));
    writeFileSync(join(dir, "src", "new.ts"), "x\n");
    writeFileSync(join(dir, "src", "ignored.md"), "line\n".repeat(50));
    const chunk = (file: string, body: string) => ({ file, diff: `diff --git a/${file} b/${file}\n${body}` });
    const hits = checkLimits(dir, [
      chunk("src/big.ts", "@@\n+a\n+b\n-c\n"),
      chunk("src/shrunk.ts", "@@\n+a\n-b\n-c\n"),
      chunk("src/new.ts", "new file mode 100644\n@@\n+x\n"),
      chunk("../escape.ts", "@@\n+a\n"),
      chunk("src/ignored.md", "@@\n+a\n+b\n")
    ], { maxFileLines: 10, maxFilesPerDirectory: 2, ignorePaths: "\\.md$" });
    assert.deepEqual(hits.map((hit) => `${hit.limit}:${hit.path}:${hit.value}`), ["maxFileLines:src/big.ts:51", "maxFilesPerDirectory:src:4"]);
  });

  it("refuses to run with no rules rather than reporting a clean diff", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-rules-"));
    const userRulesPath = join(dir, "user.json");
    writeFileSync(userRulesPath, JSON.stringify({ disable: builtinRules.map((rule) => rule.id) }));
    await assert.rejects(checkRules({ repoRoot: dir, diff: DIFF }, { userRulesPath }), /No rules found/);
  });
});
