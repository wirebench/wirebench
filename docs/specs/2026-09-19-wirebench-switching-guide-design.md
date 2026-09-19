# Spec: Switching Guide

- Status: **approved** (2026-09-19).
- Plan: `docs/plans/2026-09-19-wirebench-switching-guide-plan.md`.
- Date: 2026-09-19.
- Issue: [#54](https://github.com/wirebench/wirebench/issues/54) · Roadmap item 2 · Milestone 2.2.
- Branch: `docs/switching-guide`, from `main`.

## Assumptions

1. There is one page per source that someone switches from: Postman collections, legacy SOAP projects,
   OpenAPI and Swagger, and cURL commands. WSDL and `.proto` files are service definitions, not saved
   work, so they stay in the importers guide.
2. The pages live in a new **Switching** sidebar section after Guides. The importers guide stays about the
   Import dialog and links to each switching page.
3. The four importer bugs found while taking the inventory are fixed before the pages are written, so the
   pages describe behaviour that holds. Each bug gets its own task and commit.
4. Two Postman mapping gaps found next to bug 1 are fixed in the same task:
   - An OAuth 2 grant other than authorization code or client credentials is reported. Today it silently
     becomes client credentials.
   - `{{var}}` in auth fields is translated, the same as everywhere else.
5. The legacy SOAP project page never names the tool that wrote the file (`pnpm check:banned-terms`).
   Postman is named, because it is the format's own name and the importer is already called that.
6. No importer carries a secret value across. The pages say so and link to the secrets guide.

## 1. Objective

**What.** One page per source. Each tells the reader what carries over, what does not, and where the
equivalent lives in Wirebench, so they can check it before or after an import.

**Who.** Someone arriving with saved requests in another client, and a platform team deciding whether a
migration is feasible.

**Why.** Switching cost is the moat. An importer that silently drops scripts or credentials loses the user
at the first send. A page that says so in advance keeps them.

## 2. Fixes first

| # | Bug | Fix |
| --- | --- | --- |
| 1 | The Postman importer computes warnings in `packages/engine/src/rest/postman/map.ts` and sends them to the renderer, but the summary panel never shows them. They cover scripts, unimported variables, credentials to re-enter, unsupported auth, dynamic variables and skipped items. | The Postman summary lists the warnings the same way the legacy SOAP summary does, with a **Copy report** button. The unused `skipped` wire field is removed or filled. This task also fixes the two gaps in assumption 4. |
| 2 | Pasting a cURL command with `-u user:pass` drops the password. The engine returns it for the keychain, but the dialog never stores it. | The dialog stores the password as a secret and passes its `passwordRef`, so the request's Basic auth works on the first send. The toast asking for a password only appears when the command gave none. |
| 3 | The cURL preview is built for SOAP even when the target is REST. It shows a SOAPAction row and reports `basic-auth-ignored` and `data-from-file-unsupported`, although the REST importer handles both. | The preview follows the target. For REST it shows the method, URL, headers, body kind and auth, and only REST problems. After an import, the problems are listed, not just counted. |
| 4 | Unknown cURL flags are assumed to take a value, so value-less flags such as `--ntlm`, `--digest`, `--basic`, `--anyauth`, `-G`, `-I`, `-O` and `--compressed` swallow the next token. Sometimes that token is the URL. | A fuller list of value-less flags. `--json` is parsed as a JSON body, and `-G` moves the `-d` data into the query. Each flag gets a unit test. |

## 3. Content

Every switching page has the same shape:

1. **In one line:** what the import produces (one API, one project, one request).
2. **What carries over:** a table of source construct, Wirebench equivalent, and a link to the guide for it.
3. **What does not:** a table of construct, what happens (reported, saved aside, dropped), and what to do.
4. **After importing:** a short checklist: re-enter secrets, define properties, review the report.
5. **Related:** the importers guide section, secrets, environments, property syntax.

| Page | Covers |
| --- | --- |
| Postman collections | Collections v2.0 and v2.1 only (no environment or globals exports); folders; bodies; `{{var}}` to `${var}`; `:param` to `{param}`; auth mapping per type; scripts and variables; secrets |
| Legacy SOAP project | Interfaces, operations, saved calls, endpoints, properties and environments; scripts, which are saved aside and never run; what is reported (assertions, attachments, WS-Security, test suites, mocks, unsupported auth); passwords and plain-text property values |
| OpenAPI and Swagger | Versions; servers; tags as folders; parameters (header rows off, optional query rows off); bodies; security schemes and the one-requirement rule; what is skipped (webhooks, callbacks, cookies, responses) |
| cURL commands | REST and SOAP targets; flag table; `-u` and the keychain; repeated `-d`; ignored flags |

The same change corrects four points where the importers guide contradicts the code:
- Test suites and mocks are warnings, not notes.
- The legacy import can fetch a definition that the file holds no copy of.
- Only saved calls are checked for passwords.
- The cURL preview shows header names and body length, not the full headers and body.

## Commands

```
Dev:     pnpm docs:dev
Build:   pnpm docs:build
Unit:    pnpm test
Gate:    WIREBENCH_SKIP_PERF=1 pnpm check
Shots:   pnpm docs:screenshots
```

## Project structure

```
docs-site/src/content/docs/switching/   postman.mdx legacy-soap-project.mdx openapi.mdx curl.mdx
docs-site/public/images/switching/      import-summary screenshots from docs-screenshots.spec.ts
packages/engine/src/rest/postman/       fix 1 (engine side)
packages/engine/src/rest/curl.ts        fix 4
apps/desktop/src/renderer/features/explorer/import-dialog.tsx         fix 1 (summary)
apps/desktop/src/renderer/features/request-editor/import-curl-dialog.tsx, curl-preview.ts   fixes 2, 3
```

## Code style

Fixes follow the surrounding code. The Postman summary reuses the legacy summary's list and Copy report
button rather than adding a second implementation. Pages follow the docs site's conventions:
- plain Markdown or MDX, in short sentences;
- root-relative links under `/wirebench/`;
- only screenshots taken by the spec.

## Testing strategy

- Engine unit tests for every mapping change: OAuth 2 grants, variables in auth fields, each cURL flag,
  `--json` and `-G`.
- Renderer unit tests for the Postman summary's warning list and the REST cURL preview.
- Two e2e tests:
  - A Postman import whose summary shows warnings.
  - A pasted `curl -u` whose request authenticates against the test server's Basic auth without the
    password being entered again.
- The docs build (with the link validator), `check:docs-images` and `check:doc-paths` cover the pages.

## Boundaries

- **Always:** run `WIREBENCH_SKIP_PERF=1 pnpm check` before each commit, with one commit per task. Every
  table row on a page must trace to code or a test.
- **Ask first:** changing what an importer maps beyond the four bugs and assumption 4; new dependencies.
- **Never:** name the tool behind the legacy SOAP format; carry secret values across an import; claim a
  mapping the code does not do.

## Success criteria

- [x] The Postman summary shows the import warnings with a Copy report button. OAuth 2 grants and
      variables in auth fields are handled as assumption 4 says.
- [x] A pasted `curl -u user:pass` sends authenticated without the password being entered again.
- [x] The cURL preview is correct for both REST and SOAP targets, and the problems are listed after an
      import.
- [x] Value-less cURL flags no longer swallow the next token, and `--json` and `-G` work.
- [x] Four switching pages exist under a Switching section, each with a carries-over table and a
      does-not table.
- [x] The four contradictions in the importers guide are corrected.
- [x] `pnpm check` and `pnpm docs:build` pass.

## Open questions

None.
