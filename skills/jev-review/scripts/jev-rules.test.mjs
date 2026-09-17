import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildQuestions, loadRules, rulesFor, splitDiff } from "./jev-rules.mjs";

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

test("splits a diff per file and scopes rules by path", () => {
  const chunks = splitDiff(DIFF);
  assert.deepEqual(chunks.map(c => c.file), ["src/a.ts", "docs/b.md"]);
  assert.ok(chunks[0].diff.includes("+new") && !chunks[0].diff.includes("+y"));

  const rules = [{ id: "everywhere", rule: "r" }, { id: "src-only", rule: "r", paths: "^src/" }];
  assert.deepEqual(rulesFor("docs/b.md", rules).map(r => r.id), ["everywhere"]);
  assert.deepEqual(Object.keys(buildQuestions(rulesFor("src/a.ts", rules))), ["everywhere", "src-only"]);
});

test("merges rule files, skips missing ones, rejects duplicates", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-rules-"));
  const a = join(dir, "a.json"), b = join(dir, "b.json");
  writeFileSync(a, JSON.stringify({ rules: [{ id: "one", rule: "r" }] }));
  writeFileSync(b, JSON.stringify({ rules: [{ id: "one", rule: "r" }] }));
  assert.equal(loadRules([a, join(dir, "missing.json")]).length, 1);
  assert.throws(() => loadRules([a, b]), /duplicate rule id/);
});
