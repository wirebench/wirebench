# Wirebench: OpenAPI linting — design

Date: 2026-10-12 · Status: design, owner calls taken (§9) · Issue #342 (milestone 5.2)

- Builds on:
  - The OpenAPI reader: `versionOf` (`rest/openapi/parse.ts`) names the version a document declares;
    `parseDocumentText` reads JSON or YAML.
  - The reference policy in `http/ref-policy.ts`. A `file:` root may only reach files inside its
    own folder tree, an `http(s):` root never reaches `file:`, and the depth and document caps
    stop runaway graphs. `json/schema/refs.ts` resolves OpenAPI `$ref`s under it today.
  - The CLI's source reading and project caches: `readSource`, `fetcherFor` (`ops/import.ts`) and
    `openProject` (`ops/project.ts`). `wirebench diff-contract` (#56) set the verb shape: a source, a
    gate flag and `--reporter <kind>=<file>`.
  - The desktop Problems view (`renderer/state/problems.ts`): grouped by `groupId`, so a re-lint
    replaces only its own rows.

## 1. Goal

`wirebench lint <definition>` checks an OpenAPI 2.0, 3.0, 3.1 or 3.2 document against two built-in
rule sets and the project's own rule sets. It prints the findings, writes JSON and SARIF reports, and
sets its exit code from `--fail-severity`. The desktop shows the same findings in Problems.

Out of scope: Swagger 1.x, AsyncAPI, WSDL (WS-I already covers WSDL) and fixing findings
automatically. A document a `$ref` pulls in is linted too, where the runner reaches it, and its
findings name that document.

## 2. Engine: an open-source linter, fenced (`rest/openapi/lint/`)

The rule runner is a widely used open-source OpenAPI linter (Apache-2.0). We use only its core,
function library, parsers and reference resolver; we do not take its bundled rule sets. Wirebench
writes the rules itself (§3, §4) and owns the boundary around the runner:

- **References.** The runner gets a resolver that has only our own readers for `file`, `http` and
  `https`. Every reference first goes through `referencePolicyFor(rootLocation)`. A remote
  reference is refused unless the root itself is remote, or the caller passes `allowRemoteRefs`. Only
  then is it read through the caller's `FetchDocument`. The caller's fetcher is the network fetcher
  for the CLI, and the offline definition-cache fetcher for the desktop and `project:<name>`. A refused
  reference becomes an `invalid-ref` error finding that gives the reason. The runner's own HTTP and
  file readers are never used.
- **Versions.** `versionOf` decides. A 1.x document is refused with `lint-unsupported-version`. Rules
  are scoped by two of our own format predicates, `openapi2` and `openapi3`, where `openapi3` covers
  3.0, 3.1 and 3.2. The runner's own format detection does not know 3.2.
- **Regexes.** The built-in rules are functions over values and use no pattern on document text
  beyond fixed, linear ones. A pattern from a project rule set never runs on the caller's thread
  (§5).

```ts
type LintSeverity = 'error' | 'warning' | 'info' | 'hint';
interface LintFinding {
  readonly rule: string;            // 'operation-operationId', 'owasp-plain-http', 'invalid-ref', …
  readonly severity: LintSeverity;
  readonly message: string;
  readonly path: string;            // JSON Pointer into the document the finding is in
  readonly source: string;          // that document's location (root, or a referenced file)
  readonly range?: { start: { line: number; column: number }; end: { line: number; column: number } }; // 1-based
}
interface LintReport {
  readonly version: OpenApiVersion; readonly declaredVersion: string;
  readonly findings: readonly LintFinding[];       // sorted: source, line, column, rule
  readonly rules: readonly LintRuleInfo[];         // every rule that ran: id, severity, description, ruleset
}
lintOpenApi(input: { text: string; location: string }, options: {
  fetchDocument: FetchDocument; rulesets?: readonly LintRulesetFile[]; allowRemoteRefs?: boolean; signal?: AbortSignal;
}): Promise<LintReport>
```

## 3. Built-in rule set `hygiene` (default severity warning)

| Rule                    | Finds                                                                         |
| ----------------------- | ----------------------------------------------------------------------------- |
| `info-description`      | `info.description` missing or empty                                           |
| `operation-operationId` | an operation with no `operationId`                                            |
| `operation-operationId-unique` (error) | two operations with the same `operationId`                     |
| `operation-description` | an operation with neither `summary` nor `description`                         |
| `operation-success-response` | an operation with no 2xx or 3xx response                                 |
| `parameter-description` | an inline parameter with no `description`                                     |
| `schema-description`    | a reusable schema (`components.schemas` / `definitions`) with no `description` |
| `media-example`         | a 3.x request or response media type with no `example`, `examples` or schema `example` |
| `inline-object-schema`  | a request or response body whose schema is an inline object with properties, rather than a `$ref` to a reusable schema (checked on the unresolved document) |

## 4. Built-in rule set `owasp` (default severity error)

These rules cover the OWASP API Security Top 10 items that a definition alone can show:

| Rule                         | Finds                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `owasp-security-defined`     | no security scheme at all (`components.securitySchemes` / `securityDefinitions`)        |
| `owasp-operation-security`   | an operation with no effective security requirement, unless it declares `security: []` (warning) |
| `owasp-plain-http`           | an `http://` server URL (2.0: `schemes` containing `http`) or OAuth flow URL. A loopback host is exempt |
| `owasp-security-scheme-undefined` | a security requirement that names a scheme the document does not define           |
| `owasp-oauth-scope-undefined`| a requirement that asks for an OAuth scope that none of the scheme's flows define       |

## 5. Project rule sets

YAML files in the project's `lint/` folder (`*.yaml`, `*.yml`, read in name order) and files given
with `--ruleset <file>`. The project is `--project <dir>`, or the current directory when it holds
`wirebench.yaml`. Each file is validated with zod, and an invalid file is a usage error (exit 2) that
names the file and the field.

```yaml
builtin: [hygiene, owasp]         # optional; which built-ins run (default both). [] = none
rules:
  operation-description: off      # a built-in rule: off | error | warning | info | hint
  owasp-plain-http: warning
  summary-length:                 # a rule of your own
    target: operation             # info | server | operation | parameter | schema | response | media | security-scheme | tag
    field: summary                # dotted name inside the target, letters/digits/_-$@ only
    check: max-length             # present | absent | pattern | not-pattern | max-length | min-length | one-of
    value: 80                     # number for the lengths, string for the patterns, list for one-of
    severity: warning             # default warning
    message: Keep summaries under 80 characters   # optional
```

- Each target maps to fixed JSONPath expressions for each format (for example, `schema` is
  `$.components.schemas[*]` or `$.definitions[*]`). Users never write JSONPath.
- When files disagree, the later one wins: `lint/` files in name order, then each `--ruleset` file.
  A custom rule id must not reuse a built-in id; a built-in rule may only be set to a severity.
- A pattern must compile and be at most 500 characters. It is tested on the engine's existing
  time-bounded regex worker (`xpath/evaluate-async.ts`, the one assertions use), batched per pattern
  for the whole lint. A pattern that backtracks past the budget becomes a finding saying the field
  could not be checked; it never hangs the CLI or the desktop's main process. A static screen was
  rejected because it refuses common safe patterns such as `^[a-z]+(?:-[a-z]+)*$`.

## 6. CLI: `wirebench lint`

```
wirebench lint <definition> [--fail-severity error|warning|info|hint|none] [--ruleset <file>]…
               [--reporter json=<file>|sarif=<file>]… [--project <dir>] [--allow-remote-refs] [-q]
```

- `<definition>` is a file, an http(s) URL, or `project:<name>`. A `project:<name>` source is the
  REST API's cached definition, read offline.
- Each finding prints as one line, `openapi.yaml:12:5  error    owasp-plain-http  <message>  (<pointer>)`.
  The `file:line:col` form opens in editors and terminals. A summary line follows:
  `2 errors, 5 warnings, 0 infos, 0 hints in openapi.yaml`. `-q` prints only the summary.
- Exit codes: 0 when no finding is at or above `--fail-severity` (default `error`); 1 when one is.
  2 for a usage error, an unreadable file, a bad rule set or an unsupported version. 3 when the
  document cannot be fetched or parsed.
- JSON report: `{ tool, version, document, declaredVersion, summary, findings[] }`.
- SARIF 2.1.0 report: one run, `tool.driver` with every rule that ran, and results with `ruleId`,
  `level` (`hint` and `info` both become `note`), the message, and the physical location: a URI
  relative to the current directory for a file, or the URL as given, with a 1-based region. Code
  scanning reads this directly.

## 7. Desktop

- A new channel `api.restLint { apiId } → { findings: LintFindingWire[] }`. Main reads the API's
  definition cache offline, loads the project's `lint/` rule sets, and runs `lintOpenApi`. A bad rule
  set comes back as a single `error` finding named `ruleset-invalid`.
- The Problems store gets a `lint` source and `setLint(apiId, findings)`, with group `lint:<apiId>`.
  An `error` finding stays an error; the other severities show as warnings. Each row shows the rule
  id, the message and `line:column`, and its breadcrumb names the API.
- A command, **Lint definition** (`rest.lintDefinition`), appears when the API has a cached
  definition. It runs the lint and opens Problems.
- An OpenAPI import, and an applied definition update, run the lint for that API afterwards. A lint
  failure there is logged and never fails the import.

## 8. Testing

Fixture documents live in `packages/engine/test/fixtures/lint/`. There is a clean document and a
noisy document for each of 2.0, 3.0, 3.1 and 3.2, plus a multi-file document with references that
leave its folder and point at a remote host. Engine unit tests cover each rule, the reference fence,
overrides, custom rules, a backtracking pattern, JSON and SARIF output, and sorting. CLI tests cover flags,
exit codes, `project:`, `lint/` loading and the reporters. Desktop tests cover the store, the command
gate and the main handler.

## 9. Owner calls (2026-10-12)

- Wrap an open-source linter rather than write a rule engine from scratch.
- Both built-in rule sets run by default; a project rule set can switch off any built-in rule or
  change its severity.
- Custom rules use targets and checks, live in the project's `lint/` folder, and can also be given
  with `--ruleset`.
- The desktop lints on a command, and after an import or a definition update.
- Decided without asking: `--fail-severity` defaults to `error`; `hint` and `info` both become SARIF
  `note`. The runner's install-time telemetry dependency is never built here (`neverBuiltDependencies`).
