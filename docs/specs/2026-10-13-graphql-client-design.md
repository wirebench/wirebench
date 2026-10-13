# GraphQL queries and mutations over HTTP — design

Issue: #77 · Date: 2026-10-13 · Status: approved to build (owner's answers, 2026-10-13)

## Objective

A developer writes a GraphQL query or mutation in Wirebench, with completion, validation and hover
documentation from the service's schema, and sends it with the auth, environments, History, runs and
scripts every HTTP request already has. A response that carries GraphQL `errors` shows them as Problems
and fails a run. Subscriptions are #99 and stay out: they wait for a streaming transport.

## Decisions (owner, 2026-10-13)

1. **A REST body mode, not a protocol kind.** A GraphQL request is a REST request whose body is
   `{ kind: 'graphql', query, variables, operationName? }`. The issue text called for a container of
   its own, but ADR-0017 forbids a protocol folder from importing another's. A `graphql` kind would
   first need REST's send, auth, redirects and cookies moved into core `http/`. As a body mode, the request
   gets runs, sequences, scripts, assertions, cURL, code generation, History, the HTTP log, cookies and
   environments at no extra cost. ADR-0017 and ADR-0023 are unchanged: no kind is added. The explorer
   still tells it apart, with a `GQL` badge in place of the method.
2. **The schema is kept in the project.** A fetched or imported schema is stored as SDL at
   `apis/<slug>/graphql/schema.graphql`. It is committed and diffable, like a cached OpenAPI definition.
   The API records where the schema came from (`graphqlSchema: { source, fetchedAt }` in `api.yaml`).
   *Fetch schema* runs introspection through the request's own URL, headers, auth and environment.
3. **Full editor support.** The query editor has completion, live validation markers and hover
   documentation. The variables editor completes the operation's variable names and is checked against
   their types. This uses the MIT packages `graphql` (engine) and `graphql-language-service` (desktop
   main). The language service runs in main and the renderer asks for it over IPC, as gRPC completion
   and script checking already do, so the renderer loads no GraphQL code and no worker.
4. **Errors are Problems and fail runs.** Each entry of a response's `errors` array becomes a Problem
   on the response. In a run or a sequence step it is a failed check, even on HTTP 200. The response's `data` is also
   checked against the schema. A mismatch is a warning-level Problem and does not fail a run, as a
   REST contract violation does not.

## Model and format

- `RestBody` gains the `graphql` arm: `query` (text), `variables` (JSON text, `''` for none) and
  `operationName` (absent: the server picks, which is right for a document with one operation).
- On disk, the query is the request's sibling file `<slug>.body.graphql`. That name already fits the
  `.body.<ext>` convention a save manages, so no new sibling rule is needed. `variables` (a YAML block
  string, omitted when empty) and `operationName` stay in the request document:
  `body: { kind: graphql, file: x.body.graphql, variables: "...", operationName: Q }`.
- `RestApi.graphqlSchema?: { source: string; fetchedAt: string }`. `source` is the URL that was
  introspected, or the file name that was imported. Omitted when unset, so an API without one saves
  byte-identical.
- **Format 11.** A 6.0 build would refuse the `graphql` body arm when it parses the request, so it must
  refuse the project as too new rather than fail on a request. The v11 JSON Schemas are generated, and v10
  goes back to its released content.

## Sending

- **Expansion.** `${…}` references expand in the query as written, with no escaping, because a reference
  in a query is meant to splice text in. Variables expand with JSON escaping when the request's
  *escape properties* setting is on, the same rule as a raw JSON body. `operationName` expands as written.
- **Lowering.** Right after expansion, the body becomes a raw JSON body:
  `{"query": …, "variables": …, "operationName": …}`. `variables` is left out when blank and
  `operationName` when absent. Variables that do not parse as JSON after expansion refuse the send in the prepare
  stage with `graphql-variables-invalid`. Everything after resolve sees an ordinary
  `application/json` POST body: the pre-request script, the wire, History, the HTTP log, cURL and
  code generation. A History resend replays that JSON.
- The method is the request's own. Switching a request's body to GraphQL sets its method to `POST` when
  it was `GET` or `HEAD`. GET-encoded GraphQL is not offered.
- A saved request's secret scan and secret moves cover the query and the variables.

## The schema

- **Fetch schema** (desktop, in the body editor): sends the request as edited, with its body replaced
  by the standard introspection query, through the normal send path. The exchange is not recorded
  in History. A response with `data.__schema` is turned into SDL (`buildClientSchema` + `printSchema`)
  and saved. Anything else (a non-JSON body, `errors`, an HTTP error) is reported with the server's
  first message, and the stored schema is kept.
- **Import schema…**: main's file picker. It takes an SDL file (`.graphql`, `.graphqls`, `.gql`) or an
  introspection result (`.json`, with or without the `data` wrapper). Both are validated before
  anything is written. The schema is stored as SDL either way.
- **Clear schema** removes the file and the `graphqlSchema` field.
- The schema file is read with the project. Main keeps the built schema per API until the file or the
  API changes.

## Editor

- The body tab adds a **GraphQL** kind. It shows the query editor (Monaco's GraphQL grammar), a
  variables editor (JSON) below it, and a toolbar with the schema state ("No schema" / "Schema from
  <source>, <date>"), *Fetch schema*, *Import schema…* and *Clear*. When the query has more than one
  operation, an operation picker sets `operationName`.
- Completion, diagnostics and hover come from main (`request.graphqlAssist`), with the schema the API
  has. The query is passed as typed, unsaved. With no schema, the editor still reports syntax errors.
- The variables editor completes the variables the selected operation declares, and marks a missing
  required variable, an unknown one, or a value of the wrong type.
- The explorer shows `GQL` for a request whose body is GraphQL. An API's *New request* menu gains
  *New GraphQL request* (a `POST` with an empty GraphQL body).

## Response

- When the request's body was GraphQL and the response is JSON, the engine checks it
  (`checkGraphqlResponse`):
  - Each `errors[i]` gives an error-level problem: its `message`, its `path`, and the pointer
    `/errors/i`.
  - `data` is checked against the operation's selection set: a field the operation did not select, a
    selected field missing, `null` in a non-null position, a scalar or enum of the wrong type, or a list
    expected and not found. Each gives a warning-level problem at its JSON pointer. The check is skipped
    with no schema or no parsable query, and above 1 MiB of body. At most 50 problems are kept, with
    messages capped at 300 characters. Values from the body are never copied into a message.
- The exchange summary carries `graphql: { errors, problems, checked }`. The response pane shows a chip
  ("No GraphQL errors" / "2 GraphQL errors" / "Schema mismatch"), marks the body at each pointer as the
  contract markers do, and records the problems in the Problems view under the `graphql` source.
  A new send replaces that request's rows.
- **Runs and sequences.** A send whose request body was GraphQL adds a check named "GraphQL errors". It
  fails when `errors` is non-empty, and its `actual` holds the first messages. It does not count as an
  assertion for `--require-assertions`.

## Imports and exports

- OpenCollection GraphQL items, `.http` `GRAPHQL` requests and Postman `graphql` bodies now import as
  GraphQL bodies, where before they were lowered to JSON or skipped. The notes that pointed at #77 go away.
- Postman export writes a GraphQL body as `mode: graphql`. Every other export writes the lowered JSON.

## Out of scope

- Subscriptions (#99), GET-encoded queries, persisted queries, file uploads (multipart GraphQL), and
  `@defer` / `@stream` incremental delivery.
- A GraphQL mock, and generating requests from a schema's operations.
- A schema-browser view (the hover and completion carry the documentation).

## Testing

- Engine unit tests for the model round-trip, storage (sibling file, byte-identical saves, format 11),
  expansion and lowering, invalid variables, introspection-to-SDL, import of SDL and JSON, the response
  check, the run check, the secret scan, and the importers and the Postman export.
- Desktop unit tests for the mutations, the introspection and import channels, the assist channel, the
  summary, and the renderer's body tab, chip, Problems rows and explorer badge.
- One e2e spec: create a GraphQL request against the e2e fixture server, fetch its schema, see a
  completion, send, and see an `errors` Problem.
