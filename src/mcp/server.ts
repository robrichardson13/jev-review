import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { reviewInputSchema } from "../evaluation/input.js";
import { reviewWithJev } from "../evaluation/review.js";
import { evaluationSchema, type Evaluation } from "../evaluation/types.js";
import { checkRules, rulesInputSchema, rulesOutputSchema, type RulesOutput } from "../rules/rules.js";

const SERVER_INSTRUCTIONS = [
  "Jev is a fast classifier, not a reasoner: it judges a diff well against a rule that is written down, and poorly against generic quality questions.",
  "Prefer jev_rules: after each coherent implementation slice and before handoff, call it with repoRoot to check the working tree against the user's personal rules (~/.jev/rules.json) and the repository's rules (.jev/rules.json). Treat each hit as a pointer to inspect, not a verdict; a wrong hit means the rule's wording or paths should be tightened.",
  "The jev_review scorecard below is a secondary, coarse signal.",
  "Jev Review is a repeated scalar feedback loop, not a narrative reviewer.",
  "For every nontrivial coding task, call jev_review after the first coherent implementation to establish a baseline, then call it again after each meaningful improvement.",
  "Jev supplies metric scores, confidence, and score movement; it does not provide a prose root-cause analysis.",
  "The coding agent must inspect the requirements and code, diagnose why an important dimension is weak, make the smallest justified improvement, run relevant validation, and rescore.",
  "On follow-up calls, send the current implementation and pass the prior structured response unchanged as previousEvaluation so improvements and regressions are visible.",
  "A single baseline call is not completion: continue while important weak metrics remain and another evidence-based improvement is available.",
  "If a targeted score does not improve, reconsider the diagnosis rather than making random cosmetic changes.",
  "Do not repeat identical calls, review formatting-only changes, or game scores through scope expansion, speculative architecture, meaningless tests, unnecessary comments, or mechanical file splitting.",
  "Correctness, user requirements, and normal project validation always outrank score improvement."
].join(" ");

export type RulesHandler = (input: z.infer<typeof rulesInputSchema>) => Promise<RulesOutput>;
export type ReviewHandler = (input: z.infer<typeof reviewInputSchema>) => Promise<Evaluation>;

export function createMcpServer(review: ReviewHandler = reviewWithJev, rules: RulesHandler = checkRules): McpServer {
  const server = new McpServer(
    { name: "jev-review", version: "0.1.1" },
    { instructions: SERVER_INSTRUCTIONS }
  );

  server.registerTool(
    "jev_review",
    {
      title: "Jev software-quality review",
      description:
        "Run a scalar software-quality feedback loop over a focused implementation. For nontrivial work, call once to establish a baseline, then inspect the code yourself, improve weak important dimensions, validate, and call again with the prior result in previousEvaluation. Jev returns scores, confidence, and deltas—not a prose explanation of root causes. Do not stop after the baseline when another justified improvement is available. Send the current task, diff, relevant files, and repository context; never send the whole repository by default.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true
      },
      inputSchema: reviewInputSchema,
      outputSchema: evaluationSchema
    },
    async (input) => {
      try {
        const evaluation = await review(input);
        return {
          content: [{ type: "text", text: JSON.stringify(evaluation) }],
          structuredContent: evaluation
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Jev Review failed unexpectedly.";
        return {
          isError: true,
          content: [{ type: "text", text: message }]
        };
      }
    }
  );

  server.registerTool(
    "jev_rules",
    {
      title: "Jev rules check",
      description:
        "Check a diff against written rules: the user's personal rules (~/.jev/rules.json) merged with the repository's rules (<repoRoot>/.jev/rules.json), later overriding earlier by id. Asks Jev one yes/no question per rule per changed file and returns the likely violations as probability, rule id, and file. Pass repoRoot to diff the working tree against base (default HEAD; use the branch base before handoff) without sending the diff yourself. To calibrate a rule, pass diff and rules inline with includeAll, once with a violating diff and once with the fixed one: keep the rule when they score about 0.7 or higher and 0.3 or lower. An error means the check did not run, never that the diff is clean.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true
      },
      inputSchema: rulesInputSchema,
      outputSchema: rulesOutputSchema
    },
    async (input) => {
      try {
        const output = await rules(input);
        return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Jev rules check failed unexpectedly.";
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    }
  );

  return server;
}

export async function runStdioServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await createMcpServer().connect(transport);
}
