# Multi-environment send — design

Issue: #35 · Date: 2026-09-22 · Status: draft

## Problem

Checking that a request behaves the same on dev, test and prod today means: send, switch the active
environment, send again, then open two History entries and diff them. Switching the active
environment also changes every other open editor. The issue asks for one action that sends one
request to several environments and shows the responses side by side.

Done when: (1) the user can pick several environments for a single send; (2) the responses are
shown side by side with the semantic diff.

## Behaviour

- **Entry point.** A *Send to environments…* action next to Send in the SOAP request editor and the
  REST editor, plus a command-palette entry (`request.sendToEnvironments`). Disabled, with the
  reason as its tooltip, when fewer than two environments apply to the request (see *Which
  environments* below).
- **Which environments.** The ones that already decide where a normal send goes. Inside a
  workspace — which is how every project is opened in the app — that is the *workspace's*
  environments (a project environment only takes part through its slug link, as it does for a
  normal send); outside one, the project's own.
- **Picker.** A dialog lists those environments as checkboxes (the active one pre-ticked),
  with a *Baseline* radio per row (default: the active environment, else the first ticked). Send is
  enabled with two or more ticked. The last selection per request is remembered for the session.
- **Send.** Main resolves the request once per chosen environment — endpoint / base URL, property
  expansion, auth, TLS and proxy — exactly as a normal send would with that environment active,
  **without changing the active environment**. The sends run in parallel. The editor's unsaved
  edits (envelope, REST draft) are used for every environment, the same as a normal send.
- **Per-environment outcome.** Each environment settles on its own: `ok` (an exchange summary),
  or `error` (unresolved properties, no endpoint, transport failure — with the message). One
  failure never cancels the others. *Cancel* aborts all still-running sends.
- **Compare tab.** Results open in a new read-only editor tab, *Compare: \<request\> across N
  environments*:
  - one column per environment: name (baseline marked), resolved URL, status (HTTP status, SOAP
    fault flag), time, size, and the body pretty-printed;
  - under the columns, a diff of the baseline against a chosen other environment (a selector,
    defaulting to the first non-baseline), reusing the existing semantic diff: `DiffXmlEditor`
    via `DiffView` for bodies (XML or JSON pretty-printed alike) and `diffHeaders` from
    `log-compare.ts` for headers;
  - a summary line per non-baseline environment: *same body* / *body differs* / *status differs*
    / *failed*, so a wide fan-out is scannable without opening each diff.
- **History and HTTP Log.** Every individual send is recorded like any other send (one History
  entry and log row per environment, each naming its environment), so nothing is lost when the
  compare tab is closed.
- **Secrets.** Credentials resolve in main from the keychain per environment, as today. The
  renderer receives only the redacted summaries a normal send returns.

## Design

### Wire (additive, `apps/desktop/src/shared/wire-types.ts` + `ipc.ts`)

```ts
requestSendToEnvironmentsRequestSchema = z.object({
  batchId: z.string(),                 // cancels the whole fan-out
  requestId: z.string(),
  environmentIds: z.array(z.string()).min(2).max(10),
  soap: z.object({ envelopeXml: z.string(), headers: z.record(z.string()).optional() }).optional(),
  restDraft: restRequestPatchSchema.optional(),
});
envSendResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('ok'), environmentId, environmentName, kind: z.enum(['soap','rest']),
             soap: exchangeSummarySchema.optional(), rest: restExchangeSummarySchema.optional() }),
  z.object({ outcome: z.literal('error'), environmentId, environmentName, code: z.string(), message: z.string() }),
]);
requestSendToEnvironmentsResponseSchema = z.object({ results: z.array(envSendResultSchema) });
```

Channel `request.sendToEnvironments`. The renderer never sends an endpoint: main resolves it per
environment. `request.cancel` with the `batchId` aborts every child send.

### Main

- `ProjectHost` (small, additive): `restSend(requestId, draft, envId?)` passes `envId` to
  `scopesFor` and `resolveApiBaseUrl`; a new `endpointFor(requestId, envId)` wraps the existing
  `resolveEndpoint(project, envId, iface, request)`. Both default to the active environment, so
  existing callers are unchanged.
- Inside a workspace the `envId` those methods take is a *workspace* environment id.
  `ProjectHost` resolves it by handing the existing workspace resolvers
  (`resolveWorkspaceEndpoint`, `resolveWorkspaceApiBaseUrl`, `resolveWorkspaceScopes`) a copy of
  the workspace with that environment active — so the `<projectSlug>/<interfaceSlug>` override,
  the slug-linked project environment, the merged properties and the per-endpoint TLS decision
  all follow it — while the real workspace and its active environment stay as they are. An id
  the workspace does not have (a project environment id included) resolves nothing and fails
  that environment only. With no `envId` nothing changes.
- `ProjectHost.sendEnvironments()` (routed as `sendEnvironments(requestId)`) answers the
  environments that apply, in order, with the active one; `sendToEnvironments` names and
  validates the ids against it.
- New module `apps/desktop/src/main/multi-env-send.ts`:
  `sendToEnvironments(deps, request, signal)` — validates the ids against the project, then for
  each environment builds the send exactly as the single-send handlers do (SOAP:
  `sendInputFor(requestId, { endpoint: endpointFor(...), envelopeXml, headers })` with scopes for
  that env, then `sendAndRecordHistory`; REST: the existing `sendRestRequest` path with `envId`
  threaded through) and runs them with `Promise.allSettled`, mapping each to an `envSendResult`.
  Child `sendId`s are `${batchId}:${envId}`.
- The existing `sendRestRequest` / `withRequestProperties` gain an optional `envId` parameter; no
  behaviour change when it is absent.

### Renderer

- `features/multi-env/env-picker-dialog.tsx` — the picker; pure state helpers in
  `env-picker.ts` (`initialSelection`, `canSend`, `pickBaseline`).
- `features/multi-env/env-compare.ts` — pure: `toCompareColumns(results)`,
  `summarise(baseline, other): 'same' | 'body-differs' | 'status-differs' | 'failed'` (bodies
  compared after the same pretty-printing `log-compare.ts` uses, so formatting noise is not a
  difference).
- `features/multi-env/env-compare-view.tsx` — the tab; embeds `DiffView` and the header diff table.
- `editors.ts` gains a `kind: 'env-compare'` tab holding the results (session only, not persisted).
- One button each in the SOAP and REST editor toolbars; the command in `command-catalog.ts`.

### SOAP and REST both

Both send paths are already resolved in main from a `requestId` plus the editor's unsaved state, and
both already take property scopes that can be built for any environment (`scopesFor(envId)`), so
threading an environment id costs one parameter each. gRPC and WebSocket are left out: their
sessions are streaming and a side-by-side of streams is a different feature.

## Non-goals

- Picking a project's own environments inside a workspace: they do not decide a send there, so
  the picker does not offer them.
- Saved comparisons / baselines persisted to disk (snapshot regression is #34).
- Assertions or pass/fail across environments; gRPC and WebSocket; more than 10 environments.
- Changing the environment model.

## Testing

- Unit (vitest): wire schemas (min 2 ids, unknown fields rejected); `sendToEnvironments` with a fake
  service — per-env scopes and endpoints used, active env untouched, one env failing leaves the
  others `ok`, cancel aborts all; `ProjectHost.restSend`/`endpointFor` with an explicit `envId`,
  standalone and inside a workspace (a named workspace environment's endpoint, base URL and
  properties; the active one unchanged; an unknown id refused);
  `env-picker.ts` and `env-compare.ts` pure helpers; the compare view renders columns and the diff.
- e2e (`e2e/specs/multi-env-send.spec.ts`, CI): a workspace with two workspace environments pointing at two
  local stub servers returning different bodies; pick both, send, see two columns with their
  statuses, the diff showing the change, and the active environment unchanged afterwards. REST and
  SOAP each get one case.
- Docs: `docs-site/src/content/docs/guides/environments.mdx` gains a *Send to several environments*
  section.
