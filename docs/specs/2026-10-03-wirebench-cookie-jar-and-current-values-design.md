# Cookie jar and current values — design

Issue: [#44](https://github.com/wirebench/wirebench/issues/44). Roadmap item 8. This resolves REST
client spec §15 item 4 (the cookie jar) and layout-and-environments spec §12 question 1 (initial
versus current values).

## Goal

Two session features REST users expect, built on one idea: a store in the main process for values
that do not belong in the project folder.

1. **A cookie jar.** It is shared by every request in a workspace and opt-in per request. Cookies
   with an expiry survive a restart, encrypted. A manager lets you see, edit and clear what the jar
   holds.
2. **Current values.** A variable keeps its committed value in the project files. You can also give
   it a current value that applies for this session only and never touches disk.

## Decisions (owner, 2026-10-03)

1. **The jar persists per cookie.** A cookie with `Expires` or `Max-Age` is saved, encrypted, and
   reloaded on start. A session cookie (neither attribute) lives in memory and is gone on quit, as
   in a browser.
2. **One jar, opt-in.** Every REST send stores what it receives in the workspace jar. A request
   sends jar cookies only when its *Send cookies* setting is on, and the default stays off. A send
   is therefore reproducible unless you ask otherwise. The per-request cookie memory goes away.
3. **Only the user sets current values.** You type them in the variables table. Scripts and
   sequence transfers keep writing to the Sequence scope, and ADR-0015 is unchanged.
4. **Headless gets a per-run jar.** `wirebench run` and the MCP server keep an in-memory jar for the
   run or the server process, so `sendCookies: true` stops being a silent no-op. Current values do
   not exist headless; `--var` already plays that part.

## Scope

- REST sends, including REST steps of a sequence, store into the jar and read from it. SOAP, gRPC,
  WebSocket and SSE stay cookie-free, as today.
- The sequence `cookie` transfer is unchanged. It still lifts one cookie into `${#Sequence#name}`
  for a later step that wants it explicitly.
- Current values apply to every scope the variables table edits: Global, Workspace, each workspace
  environment, Project and each project environment. They reach every protocol, because expansion
  is shared.

Not in scope:
- `pm.cookies` and `pm.cookies.jar` in scripts stay unsupported.
- Cookies for SOAP or gRPC.
- Importing or exporting a jar.
- A public-suffix list (see §1.3).
- Persisting current values.

## Format decision

**None.** The layout-and-environments spec expected the initial/current split to need "a further
format decision". It does not, because current values are never written anywhere (decision 3 and
§5). The jar lives in `userData`, outside the project folder. The project's `formatVersion` (6) and
the workspace's (3) are unchanged, and the roadmap's "no format change" for item 8 holds. The only
cookie field in the project format stays `settings.sendCookies` on a REST request.

## 1. The jar (engine)

A new module, `packages/engine/src/rest/cookie-jar.ts`. It sits beside `rest/cookies.ts` and reuses
that module's RFC 6265 helpers (`domainMatches`, `pathMatches`, `defaultPath`). The desktop, the CLI
and the MCP server therefore share one implementation.

### 1.1 A stored cookie

```ts
export interface StoredCookie {
  readonly name: string;
  readonly value: string;
  /** The Domain attribute (no leading dot), or the request host for a host-only cookie. */
  readonly domain: string;
  /** True when the response gave no Domain: the cookie goes back to that exact host only. */
  readonly hostOnly: boolean;
  /** The Path attribute, or the default path of the URL that set it (RFC 6265 §5.1.4). */
  readonly path: string;
  /** Absolute expiry in epoch ms, from Max-Age first and then Expires; absent for a session cookie. */
  readonly expiresAt?: number;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite?: 'Strict' | 'Lax' | 'None';
  /** Epoch ms when first stored; kept when a later response replaces the value (§5.3 step 11). */
  readonly createdAt: number;
}
```

The identity of a stored cookie is `(name, domain, path)`. The response-side `Cookie` type
(`http/cookies.ts`) does not change. The jar turns a received `Cookie` into a `StoredCookie` when it
stores it, because only then is the request URL known.

### 1.2 Operations

```ts
export class CookieJar {
  constructor(initial?: readonly StoredCookie[]);
  /** Stores what a response to `url` set, at `now`: one verdict per cookie, in order. */
  store(url: string, cookies: readonly Cookie[], now: number): CookieVerdict[];
  /** The cookies a request to `url` carries at `now`, in RFC 6265 §5.4 order. */
  cookiesFor(url: string, now: number): StoredCookie[];
  list(now: number): StoredCookie[];
  set(cookie: StoredCookie): void;
  remove(key: CookieKey): boolean;
  removeDomain(domain: string): number;
  clear(): void;
  /** The cookies worth saving: unexpired, with an expiry. */
  persistent(now: number): StoredCookie[];
}

export type CookieKey = { readonly name: string; readonly domain: string; readonly path: string };
export type CookieVerdict =
  | { readonly stored: true }
  | { readonly stored: false; readonly reason: 'deleted' | 'domain-mismatch' | 'domain-not-allowed'
        | 'secure-over-http' | 'too-large' | 'malformed' };
```

- **Ordering (§5.4).** `cookiesFor` sorts by longer path first, then by earlier `createdAt`.
  `cookieHeader` builds the header from that list, as today.
- **Replacing (§5.3 step 11).** A stored cookie with the same identity is replaced, and its
  `createdAt` is kept.
- **Expiry and deletion.**
  - A cookie whose computed expiry is not in the future deletes the matching stored cookie and is
    not stored itself (verdict `deleted`). This is how a server logs you out (`Max-Age=0`, or a past
    `Expires`).
  - Expired cookies are never returned, and they are dropped from the jar whenever it is read.
- **Secure.** A cookie marked Secure is sent only to `https:` URLs. A plain `http:` response cannot
  set a Secure cookie, and it cannot overwrite an existing one (RFC 6265bis §5.6 steps 12–13). Both
  give the verdict `secure-over-http`.
- **Malformed lines** (`malformed: true`) and empty names are never stored (`malformed`).
- **Size.** At most 50 cookies per domain and 3000 in total. Past either limit, the cookie expiring
  soonest is evicted (session cookies count as latest), and then the oldest. A name plus value over
  4096 bytes is not stored (`too-large`).

### 1.3 Domain rules

When the response gives a `Domain`:
- **Lowercase and strip.** The domain is lowercased and a leading dot is stripped.
- **Domain-match.** The request host must domain-match it, or the cookie is ignored
  (`domain-mismatch`). A server cannot set cookies for a host it is not part of.
- **No IP or single label.** A `Domain` that is an IP address, or has a single label (`com`,
  `localhost`), is ignored (`domain-not-allowed`) unless it equals the request host exactly; in that
  case the cookie is stored host-only.

There is no public-suffix list. A server under `a.example.co.uk` can therefore set
`Domain=co.uk`, and that cookie then reaches every `*.co.uk` host you send to with *Send cookies*
on. This is residual risk, accepted for these reasons:
- the jar holds your own test traffic;
- cookies go out only from requests you opted in;
- a public-suffix list is a large, moving dependency.

`docs/security.md` records this.

### 1.4 The send host seam

`SendHost.cookies` (`run/host.ts`) moves from "keyed by request" to "keyed by URL":

```ts
readonly cookies?: {
  /** The jar cookies a request to `url` would carry; sent only when its `sendCookies` is on. */
  cookiesFor(url: string): readonly StoredCookie[];
  /** What a response to `url` set; every REST send reports it, whatever its sendCookies. */
  remember(url: string, cookies: readonly Cookie[]): readonly CookieVerdict[];
};
```

- **The URL is the final one.** `rest/run.ts` passes the URL actually requested: after expansion,
  and per redirect hop when redirects are followed. Each hop's `Set-Cookie` is stored against that
  hop's URL, and the next hop reads the jar again.
- **Sending.** When `sendCookies` is on, the jar's `Cookie` header is merged with any `Cookie`
  header the request sets by hand. The hand-set pairs win on the same name.
- **No host.** When the host brings no `cookies`, nothing is sent or stored, as today.
- **What goes away.**
  - `ProjectHost.restCookies` and its accessors (`restCookiesFor`, `rememberRestCookies`), and
    their routing through `project-router` and `workspace-service`;
  - the per-request `cookiesToSend` call path in `rest/send.ts`.
  `cookiesToSend` stays exported for compatibility of the engine's public API, and is implemented
  over a throwaway `CookieJar`.
- **Header comment.** The "Wirebench keeps no cookie jar" comment in `rest/cookies.ts` is rewritten
  to describe the jar and the opt-in.

### 1.5 The Send cookies default

The engine sends only when `sendCookies === true`, but `rest-editor.tsx` shows the inherited default
as on. The renderer is fixed to show **off**, which is what the engine does and the REST spec says.
No project file changes, because the default is not written.

## 2. The desktop jar (main)

`apps/desktop/src/main/cookie-store.ts` owns one `CookieJar` per workspace id. The current
workspace's jar backs `SendHost.cookies` in `send/host.ts`.

### 2.1 Persistence

- **The file.** `userData/cookies/<workspaceId>.json`:

  ```json
  { "version": 1, "data": "<base64 safeStorage ciphertext of the JSON StoredCookie list>" }
  ```

- **What is saved.** Only `jar.persistent(now)`, encrypted as one blob with `safeStorage`, the
  backend `secrets.ts` uses.
- **No encryption.** When `safeStorage.isEncryptionAvailable()` is false, nothing is persisted and
  the jar is session-only. The manager says so: "Cookies are kept for this session only." Cookies are never written in plain text.
- **Writes.**
  - Writes are atomic: a temp file, then rename, as `global-properties.ts` does.
  - They are debounced to 1 s after the last change, and flushed on workspace switch and on
    `before-quit`.
  - A change to session cookies alone does not write.
- **Reads.**
  - The file is loaded when the workspace opens, and expired cookies are dropped.
  - A newer `version` makes the store refuse to read the file, keep a session-only jar, and log a
    warning; the file is left untouched.
  - An unreadable or undecryptable file is renamed to `<id>.json.corrupt` and the jar starts empty.
- **Deleting a workspace** deletes its cookie file.

### 2.2 IPC

The channels follow the `globals.*` pattern (`shared/ipc.ts`, `main/ipc/cookies.ts`), and each one
answers with the whole jar so the renderer holds no merge logic:

| Channel | Request | Response |
|---|---|---|
| `cookies.list` | `{}` | `CookieJarState` |
| `cookies.set` | `{ cookie: StoredCookieWire, replaces?: CookieKeyWire }` | `CookieJarState` |
| `cookies.remove` | `{ key: CookieKeyWire }` | `CookieJarState` |
| `cookies.removeDomain` | `{ domain: string }` | `CookieJarState` |
| `cookies.clear` | `{}` | `CookieJarState` |

- `CookieJarState` is `{ cookies: StoredCookieWire[], persisted: boolean }`, where `persisted` is
  false when there is no secure storage.
- The event `cookies.changed` carries `CookieJarState` and fires after a send changes the jar and
  after any channel above.
- The zod schemas live in `shared/wire-types.ts`, beside `cookieWireSchema`. They are leaf schemas
  with no engine value imports, which avoids the renderer wire-types CSP trap.
- **Values cross IPC.** Unlike secrets, the manager must show and edit cookie values, so
  `cookies.list` returns them. The renderer masks them by default (§3).

## 3. The cookie manager (renderer)

A **Cookies** editor tab, one per window, in `renderer/features/cookies/`. It is opened three ways:
- the command **View: Cookies** (`view.showCookies`);
- a **Manage cookies** link on the REST response's Cookies tab;
- a **Cookies…** item in the Environments view's header menu.

- **The table.** Rows are grouped by domain, sorted by domain and then name. The columns are Name,
  Value, Path, Expires, Secure and HttpOnly.
  - *Expires* shows a local date and time, or "Session".
  - A host-only cookie shows its domain without a leading dot, and gets a "host only" tag.
- **Values.** They are masked as `••••••` until **Show values** is toggled. The toggle is per tab
  and not remembered.
- **Editing.**
  - A value is edited in place: Enter or blur commits, Escape reverts (`useCommittedDraft`).
  - Path, Expires, Secure and HttpOnly are edited in an **Edit cookie** dialog, which also serves
    **Add cookie**.
  - Changing a cookie's identity (name, domain or path) goes through `cookies.set` with `replaces`.
- **Deleting.**
  - A row has a delete button; a domain group has **Delete all for <domain>**.
  - A toolbar has **Clear all**, behind a confirm dialog that names the count.
- **Persistence note.** When `persisted` is false, the note from §2.1 shows above the table.
- **Empty state.** "No cookies yet. Responses store cookies here; a request sends them when its
  Send cookies setting is on."
- **Live updates.** The tab listens for `cookies.changed`, so a send updates it live.
- **Size.** The table is a plain `<table>`, with test ids `cookie-manager`, `cookie-row` and
  `cookie-domain-group`. The jar is bounded at 3000 cookies (§1.2); past 500 rows it virtualises
  with `@tanstack/react-virtual`, already a dependency.

The response **Cookies** tab still shows what the response set. Each row gains a "stored" or
"ignored: <reason>" note, from the jar's verdict on that cookie (§1.2). To carry the note, the
exchange wire gains an optional `jar` verdict per cookie.

## 4. Headless (CLI and MCP)

- **The jar.** `packages/cli/src/send-host.ts` gains a `cookies` member backed by a `CookieJar`.
  - `wirebench run` creates one jar per run; it is shared by every request, sequence step and
    iteration of that run.
  - The MCP server creates one jar for the process lifetime, shared by its tools.
  - `wirebench call` creates one per call.
- **Nothing persists headless.**
- **Effect.** A REST request with `sendCookies: true` in a run carries the cookies earlier requests
  in that run received. `docs/cli.md` describes this, and its "no cookie jar" sentence about
  sequences is rewritten. A sequence's explicit `cookie` transfer still works, and is the way to
  move a cookie into a non-REST step.

## 5. Current values (main)

### 5.1 The store

`apps/desktop/src/main/current-values.ts` holds a map in memory per workspace id:

```ts
type ScopeKey =
  | { scope: 'global' }
  | { scope: 'workspace' }
  | { scope: 'workspaceEnvironment'; environmentId: string }
  | { scope: 'project'; projectId: string }
  | { scope: 'projectEnvironment'; projectId: string; environmentId: string };
// value: Record<variableName, string>
```

- It is never written to disk, never synced and never sent to the server. It is cleared on quit.
- Switching workspace keeps each workspace's map, so going back restores it. A workspace's map is
  dropped when the workspace is deleted.
- A current value exists only for a variable that has a committed value in that scope. You cannot
  invent a variable through the Current column.
  - Renaming a variable carries its current value with it.
  - Deleting a variable drops its current value.
  - A variable disabled in its scope keeps its current value, and it does not apply while disabled.

### 5.2 Expansion

`RunContext` gains an optional `current?: CurrentValues`. These are overlays keyed like the store,
already narrowed to the run's project and active environments. `scopesFor` (`run/context.ts`)
applies each overlay onto its own scope before the shorthand chain and the CLI `overrides`:

- The order of precedence within a scope is: CLI `--var` overrides (env scope, headless only), then
  the current value, then the committed value.
- A current value is a **template**, like a committed value. It is typed by the user, not taken
  from a response, so `${…}` inside it expands with the usual depth limit. ADR-0015 is not touched,
  because nothing response-derived enters this store.
- A current value of `${secret:name}` resolves through the keychain as usual. A literal current
  value that matches a known secret is masked in logs and History by the existing masker. The
  current-value store is never offered to scripts: `props.get` sees the effective value, as for a
  committed value.
- The pre-send preflight (`expansion-preflight.ts`) and the multi-environment send read the same
  overlays, so "unresolved" and per-environment results match what is sent.

### 5.3 IPC

| Channel | Request | Response |
|---|---|---|
| `currentValues.get` | `{}` | `CurrentValuesState` |
| `currentValues.set` | `{ key: ScopeKeyWire, name: string, value: string }` | `CurrentValuesState` |
| `currentValues.reset` | `{ key: ScopeKeyWire, name?: string }` | `CurrentValuesState` |

- `name` omitted resets the whole scope.
- The event `currentValues.changed` fires after any of these.
- The renderer mirrors the state in a zustand store, as `secrets-visibility.ts` does.

## 6. The Current column (renderer)

`VariablesTable` (`features/environments/variables-table.tsx`) gains a **Current** column after
Value, in every scope it renders.

- **Empty cell.** It shows the committed value in muted text as a placeholder, and the committed
  value applies.
- **Typing.** Typing sets a current value (`currentValues.set`). Enter or blur commits, and Escape
  reverts. Committing the same text as the committed value removes the override.
- **Overridden row.** It shows a dot in the Variable cell ("Current value set for this session")
  and a **Reset** icon button in the Current cell.
- **Reset all.** The table header gets **Reset current values** (`currentValues.reset` without a
  name), enabled when any override exists in that scope.
- **Inherited rows.** They show the effective value, with the current value marked when one
  applies, and stay read-only as today.
- **Secrets.** A variable whose committed value is `${secret:…}` shows its Current cell masked like
  the Value cell while secrets are hidden.
- **Hover and preview.** The status-bar environment switcher's hover and the request editor's
  expansion preview show the effective value.

Test ids: `env-variable-current`, `env-variable-current-reset` and `env-current-reset-all`.

## 7. Security

- **At rest.**
  - Cookies are encrypted with the OS keychain, or not persisted at all. Session cookies and
    current values never reach disk.
  - Neither ever reaches the project folder, a shared workspace's git tree, or the server.
- **Sending.**
  - Jar cookies leave only from REST requests with *Send cookies* on, only to matching
    domain/path, and Secure cookies only over https.
  - Cross-origin redirects already drop credential headers. The jar re-matches per hop, so a
    redirect to another host gets that host's cookies only.
- **Masking.**
  - `Cookie` and `Set-Cookie` are redacted in History and logs exactly as today.
  - The manager masks values until asked.
- **No public-suffix list.** This is residual risk, see §1.3.
- **Current values are user input.** ADR-0015's boundary (response values are data) is unchanged.

`docs/security.md` gains a "The cookie jar" section and a "Current values never touch disk"
section, each listing these controls.

## 8. Testing

- **Engine unit** (`packages/engine/test/unit/rest/cookie-jar.test.ts`):
  - host-only versus Domain;
  - domain rejection (mismatch, IP, single label);
  - path default and match;
  - ordering;
  - replacement keeping `createdAt`;
  - deletion by `Max-Age=0` and by a past `Expires`;
  - Secure set over http refused, and not overwritable from http;
  - the size limits and eviction;
  - `persistent()` excluding session cookies;
  - expired cookies dropped on read;
  - one verdict per cookie with the right reason.
- **Engine REST run:**
  - with `sendCookies` on, a second request to the same host carries the first one's cookie;
  - with it off, the cookie is stored but not sent;
  - a hand-set `Cookie` header wins on the same name;
  - redirect hops store and read per hop.
- **Engine scopes:**
  - `scopesFor` applies current overlays per scope, under `overrides`;
  - a disabled variable's current value does not apply;
  - a current value that is a template expands.
- **Desktop main:**
  - `cookie-store` round-trips encrypted through a fake `safeStorage`;
  - session cookies are not persisted;
  - no encryption means nothing is written;
  - a newer version is refused and the file left alone;
  - a corrupt file is renamed;
  - the debounce flushes on quit;
  - `current-values` follows rename and delete of a variable;
  - the IPC handlers answer with whole state.
- **Renderer:**
  - the manager groups, masks and unmasks, edits, deletes, clears with confirmation, and shows the
    persistence note;
  - the response Cookies tab shows the stored/ignored notes;
  - the Current column sets, resets and resets all, and shows the placeholder;
  - the Send cookies default shows off.
- **CLI:** `wirebench run` over two REST requests, a login that sets a cookie and a call with
  `sendCookies: true`; the second request carries the cookie, against a local server.
- **e2e** (CI only):
  - send a login request, then a request with *Send cookies* on, against a local server that checks
    the cookie;
  - open the manager and see the cookie;
  - set a current value and see the next send use it.

## 9. Documentation

- **REST client guide.**
  - The response section: cookies go into the workspace jar, *Send cookies* sends them, and the
    Cookies tab says what was stored.
  - A new "Cookies" section for the manager.
- **Environments guide.** A "Current values" section: what they are, that they last the session,
  and Reset.
- **Sequences guide** and **`docs/cli.md`.** Rewrite "no cookie jar": REST steps share the run's
  jar, and the `cookie` transfer is for explicit moves.
- **`docs/security.md`.** The two sections of §7.
- **Specs.** The REST client spec §15 item 4 and §3.3, and the layout-and-environments spec §12
  question 1, get a "Resolved by" note pointing here.
- **Roadmap.** Item 8 and milestone 3.1: #44 shipped. Remove the persistent cookie jar from the
  deferred list.
- **CHANGELOG.** Unreleased, under Added.
