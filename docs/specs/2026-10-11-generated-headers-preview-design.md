# Preview of generated headers — design

Issue #346 · milestone 5.1 · 2026-10-11

## Problem

When a request fails, the first question is what was actually sent. A REST send puts headers on the
wire that the user never typed: the preference defaults (`User-Agent`, `Accept`, `Accept-Encoding`,
`Connection`), the body's `Content-Type`, the credentials (`Authorization` or an API key header), the
cookie jar's `Cookie`, and what the transport adds itself (`Host`, `Content-Length`). Today the
Headers tab shows only a guessed `Content-Type`, worked out in the renderer. Everything else shows up
afterwards, in the HTTP Log.

## What exists today (confirmed)

- `toRestSendInput` (engine `rest/send-input.ts`) builds `defaultHeaders` from the preferences.
- `sendRest` (engine `rest/send.ts`) merges, lowest first: defaults, then auth (`applyAuth`) + body
  `Content-Type` + a `Cookie` from a cookie list, then the typed headers. A typed header always wins.
  The cookie jar is read per hop by the HTTP client, and a typed `Cookie` is merged into the jar's
  pairs (the typed pair wins on the same name).
- `sendWithAuth` adds a preemptive Basic `Authorization`. A non-preemptive Basic, NTLM and Kerberos
  `Authorization` only appears in a challenge round trip. A typed `Authorization` turns all of these off.
- The HTTP client adds `Host` and `Content-Length`.
- `previewRest` (desktop `send/exchange.ts`) already resolves a request as its send resolves it, with
  no secret read. The cURL export and code generation build on it.
- The Headers tab (`renderer/features/rest-editor/headers-tab.tsx`) shows one computed row,
  `Content-Type`, from its own copy of the body rules. Nothing can be switched off.

## Decisions (owner, 2026-10-11)

1. **Switching off is saved on the request.** A new request setting `omitHeaders: string[]` lists the
   generated headers to leave out, by name, case-insensitive. The engine applies it on every send, so
   the desktop, the CLI and runs agree.
2. **Secrets stay masked** unless the session's *Show secrets* switch is on: the same rule the cURL
   export and the Code panel follow. With the switch off no secret is read at all.
3. **REST only.** SOAP, gRPC and WebSocket are follow-ups.
4. **Transport headers are shown read-only**: `Host`, `Content-Length`, and an `Authorization` that
   only a challenge round trip sends. Each says why it cannot be switched off here.

## Design

### Engine

- `RestRequestSettings.omitHeaders?: readonly string[]` (model, request file schema, desktop wire
  schema). Request-level only; it is not inherited from the API.
- `toRestSendInput` copies it into `RestSendSettings.omitHeaders`.
- One function builds the request headers for both the send and the preview: `restHeaderRows` in
  `rest/request-headers.ts`. It returns one row per header with its `source` (`preference`, `auth`,
  `body`, `cookie`, `typed`) and its `state` (`sent`, `overridden` by a typed header, `omitted`).
  `sendRest` builds its header map from the rows marked `sent`, so the preview cannot drift from the
  send.
- Omitting `Cookie` means the jar is not read for this send (it still stores what comes back).
- Omitting `Authorization` drops a bearer, OAuth2 or preemptive Basic header. A challenge-based
  credential (NTLM, Kerberos, non-preemptive Basic) cannot be omitted: its row is read-only, and the
  fix is to set Auth to *None*.
- `previewRestHeaders(input, { jar })` returns the rows plus the transport rows: `Host` from the
  composed URL, `Content-Length` from the encoded body, and a handshake `Authorization` row when the
  credential needs a round trip. The body is encoded as the send encodes it, so a multipart body's
  boundary and length are real.
- Code generation and the cURL export leave out omitted headers too.

### Desktop

- New channel `request.restHeaders` `{ requestId, draft? }` → `{ headers: GeneratedHeaderWire[] }`,
  registered by the REST kind. It uses `previewRest` and applies the credentials the way the cURL
  export does: real values only while *Show secrets* is on, a masked stand-in otherwise. An OAuth2
  token is never fetched: a cached one is used, otherwise the row says the token is fetched at send.
  Every value goes through `redactHeaders` (by name and recorded secret values) unless shown.
- A `${secret:name}` token is shown as typed, which names the secret without revealing it.

### Renderer

- The Headers tab gains a **Generated** section under the typed table, for REST only. Each row shows
  the name, the value, the source, and:
  - a switch: off adds the name to `omitHeaders`, on removes it;
  - **Override**: adds a typed header with the same name and the generated value (empty when it was
    masked), which then wins.
  - Read-only rows show a note instead of the controls.
- The section asks main again (debounced) when the draft, the environment or the current values
  change. While it has no answer, it shows nothing rather than a guess.
- The renderer's own `Content-Type` guess stays for the WebSocket editor only.

## Not in scope

- SOAP, gRPC and WebSocket previews.
- A webhook item's signing headers (they need the signing secret and the final body); the user docs
  say they are computed at send.
- API- or folder-level `omitHeaders`.

## Testing

- Engine unit tests: rows and states for every source, typed override, omit of each switchable
  source, jar skipped when `Cookie` is omitted, `sendRest` honours the omit list on the wire (local
  test server), transport rows, code generation and cURL skip omitted headers.
- Desktop main tests: the channel masks auth and cookie values with *Show secrets* off and reveals
  them with it on; no secret is read while off.
- Renderer tests: the section lists rows with sources; the switch patches `settings.omitHeaders`;
  Override adds a typed row; read-only rows have no switch.
