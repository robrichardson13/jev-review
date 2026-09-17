import type { Rule } from "./rules.js";

/**
 * Universal rules that hold in any codebase. Lowest precedence: a personal or
 * repository rules file can override one by id or list it under `disable`.
 */
export const builtinRules: Rule[] = [
  {
    id: "hardcoded-secret",
    rule: "Never commit a credential. A literal API key, token, password, private key, or connection string with embedded credentials assigned in source, config, or a test is a violation; read it from the environment or a secret store instead. Obvious placeholders (\"your-key\", \"changeme\", \"xxx\"), fake fixture values clearly marked as such, and references to an environment variable name are exempt."
  },
  {
    id: "injection",
    rule: "Never build a SQL query, shell command, HTML fragment, or file path by concatenating or interpolating a value that can come from outside the process (request data, user input, file or network content). Use parameterised queries, an argument array instead of a shell string, escaping helpers, or path validation. Interpolating only constants or trusted internal identifiers is exempt."
  },
  {
    id: "tests-weakened",
    rule: "Do not make a failing test pass by weakening it. Deleting a test or assertion, marking a test skipped, disabled, or expected-to-fail, loosening an assertion to something that always holds, or swapping a real check for a snapshot or mock that asserts nothing is a violation unless the diff also removes the behaviour under test. Updating an expectation to match an intentional behaviour change in the same diff is exempt."
  },
  {
    id: "debug-leftover",
    rule: "Do not leave debugging artifacts in a change: ad-hoc print or console.log statements, debugger or breakpoint calls, a focused or exclusive test marker (.only, fit, fdescribe), hardcoded local paths or localhost URLs used for testing, temporary early returns, or blocks of commented-out code. Deliberate logging through the project's logger is exempt."
  },
  {
    id: "suppressed-check",
    rule: "Do not silence a safety check to get a change through. Adding a type or lint suppression (@ts-ignore, @ts-nocheck, eslint-disable, # type: ignore, # noqa, swiftlint:disable, as any), disabling TLS or certificate verification, turning off CSRF, auth, or signature validation, or bypassing commit hooks is a violation unless the same line states a specific reason the check is wrong here."
  },
  {
    id: "sensitive-data-logged",
    rule: "Do not write sensitive data to logs, error messages, analytics, or URLs: passwords, tokens, API keys, session cookies, full authorization headers, or personal data such as email addresses, phone numbers, and payment details. Log an identifier or a redacted form instead. Logging that a credential was present or absent, without its value, is exempt."
  }
];
