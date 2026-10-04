# Cookie jar and current values Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every REST send stores the cookies its responses set in one jar. A request sends matching jar cookies only when its *Send cookies* setting is on. The app keeps one jar per workspace, and saves cookies with an expiry encrypted. A manager tab shows and edits the jar. The command line keeps one jar per run, call or MCP process. Every variables table gains a session-only **Current** column. Its values override the committed values for sends and previews, and never reach disk.

**Architecture:**
- **Engine.** `rest/cookie-jar.ts` holds the RFC 6265 jar (`CookieJar`). Its types live in core `http/cookies.ts` so `run/host.ts` can name them. The HTTP client gains a per-hop cookie hook. `sendRest` drives that hook from a `CookieJarHost`, and `rest/run.ts` lends it the host's jar. `run/current-values.ts` lays the session overlays over committed values inside `scopesFor`.
- **Desktop main.** `cookie-store.ts` keeps a jar per workspace id, encrypted through the `safeStorage` backend `secrets.ts` uses. `current-values.ts` keeps an in-memory map per workspace and follows renames and deletes by diffing committed values. Both have `globals.*`-style IPC channels and a changed event.
- **Desktop renderer.** The **Cookies** editor tab lives in `features/cookies/`. The response Cookies tab shows stored/ignored notes, the Send cookies default reads off, and `VariablesTable` gains a Current column.
- **CLI.** `cliSendHost` lends a `CookieJar`: one per run, one per `OpsBase` (a `call` process or an MCP server).

**Tech Stack:** TypeScript, Node `undici`, Electron 44 (`safeStorage`), React, zustand, zod 4, `@tanstack/react-virtual`, Vitest with Testing Library, Playwright (e2e, CI only).

**Spec:** `docs/specs/2026-10-03-wirebench-cookie-jar-and-current-values-design.md` (issue #44).

## Global Constraints

- **No format bump.** Project `formatVersion` stays 6 and the workspace format stays 3. Nothing about cookies or current values is written to a project folder, a workspace folder, a shared workspace's git tree or the server.
- **Cookies at rest.**
  - Cookies are never written in plain text. Only `jar.persistent(now)` is written, encrypted as one blob through `CryptoBackend` (`safeStorage`), to `<userData>/cookies/<workspaceId>.json`.
  - Without encryption nothing is written.
  - Session cookies never reach disk.
- **Current values at rest.** They live in main's memory only and never reach disk, sync or the server.
- **REST only.**
  - Only REST sends store into the jar and read from it. SOAP, gRPC and WebSocket are untouched.
  - Sending is opt-in per request through `request.settings.sendCookies === true`, and the default stays off.
  - A send whose host lends no `cookies` stores and sends nothing.
- **ADR-0015 is untouched.** Scripts never write current values, nothing response-derived enters the current-value store, and `props.get` sees only the effective value.
- **The renderer imports no engine values.** It never imports engine values from `shared/wire-types.ts` (the CSP trap). The new wire schemas are leaf zod schemas, and `shared/current-value-keys.ts` imports types only.
- **Commits.**
  - Run `WIREBENCH_SKIP_PERF=1 pnpm check` before every commit, and make one commit per task.
  - Each subject ends `(#44)`, with no `Co-Authored-By` and no `Claude-Session` trailer.
  - Never commit `.vitest/json/output.json`. If the gate writes it, `git checkout -- .vitest/json/output.json` (or leave it unstaged) before committing.
- **Product names.** Never name a product as the inspiration for a feature, in code or docs (`pnpm check:banned-terms`).
- **e2e runs in CI only.** Never start Electron or Playwright locally.
- **Targeted tests.** Run them from the repository root as `pnpm vitest run <path>`. `pnpm --filter … exec vitest` fails in a worktree.

## File map

| File | Change |
|---|---|
| `packages/engine/src/http/cookies.ts` | `StoredCookie`, `CookieKey`, `CookieRejection`, `CookieVerdict`, `CookieJarHost` |
| `packages/engine/src/rest/cookie-jar.ts` | Create: `CookieJar`, limits, `jarCookieHost`, `mergeCookieHeader`, `cookiesToSend` (moved) |
| `packages/engine/src/rest/cookies.ts` | Header comment rewritten; `cookiesToSend`/`CookieMatchOptions` move out |
| `packages/engine/src/index.ts` | Export the jar |
| `packages/engine/src/http/types.ts`, `http/client.ts` | `HttpCookieHook`, applied per redirect hop |
| `packages/engine/src/run/host.ts` | `SendHost.cookies?: CookieJarHost` |
| `packages/engine/src/rest/send.ts`, `rest/run.ts` | `RestSendInput.jar`, `RestExchange.cookieVerdicts`; per-request cookie path removed |
| `packages/engine/src/run/current-values.ts`, `run/context.ts`, `run/index.ts` | `CurrentValues`, `overlayCurrent`, `withCurrentValues`, `RunContext.current`, `scopesFor` |
| `packages/cli/src/send-host.ts`, `ops/context.ts`, `commands/ops.ts`, `ops/send.ts`, `commands/run.ts` | One jar per run, call and MCP process |
| `apps/desktop/src/main/cookie-store.ts` | Create: `CookieStore` |
| `apps/desktop/src/main/current-values.ts` | Create: `CurrentValuesStore` |
| `apps/desktop/src/main/ipc/cookies.ts`, `ipc/current-values.ts` | Create: channels |
| `apps/desktop/src/shared/wire-types.ts`, `shared/ipc.ts`, `shared/current-value-keys.ts` | Schemas, channels, events, `scopeKeyString` |
| `apps/desktop/src/main/engine-wire.ts` | Per-cookie `jar` verdict |
| `apps/desktop/src/main/send/host.ts`, `send/exchange.ts`, `ipc/request.ts` | Jar host and current values reach the send |
| `apps/desktop/src/main/project-host.ts`, `project-router.ts`, `workspace-service.ts` | Per-request cookies removed; `setCurrentValues`; `onDeleted` hook |
| `apps/desktop/src/main/index.ts` | Create and wire both stores |
| `apps/desktop/src/renderer/state/cookies.ts`, `state/current-values.ts` | Create: mirrors |
| `apps/desktop/src/renderer/features/cookies/cookie-manager.tsx`, `cookie-dialog.tsx`, `cookie-actions.ts` | Create: the Cookies tab |
| `apps/desktop/src/renderer/state/editors.ts`, `shell/editor-area.tsx` | `'cookies'` tab kind |
| `apps/desktop/src/shared/commands.ts`, `shared/command-catalog.ts`, `renderer/commands/register-view-commands.ts` | `view.showCookies` |
| `apps/desktop/src/renderer/features/environments/environments-view.tsx` | **Cookies…** header button |
| `apps/desktop/src/renderer/features/rest-editor/response/cookies-view.tsx`, `rest-editor.tsx` | Stored/ignored notes, **Manage cookies**, Send cookies default off |
| `apps/desktop/src/renderer/features/environments/variables-table.tsx`, `environment-page.tsx`, `features/project/project-tab.tsx` | Current column |
| `apps/desktop/src/renderer/shell/app-shell.tsx`, `shell/code-panel.tsx` | Subscribe; re-run on current values |
| `apps/desktop/test/mocks/wirebench-api.ts` | Defaults for `cookies` and `currentValues` |
| `e2e/specs/cookie-jar.spec.ts` | Create (CI only) |
| Docs: REST, environments and sequences guides, `docs/cli.md`, `docs/security.md`, specs, roadmap, CHANGELOG | Task 12 |

## Tasks

### Task 1: The engine cookie jar

**Files:**
- Modify: `packages/engine/src/http/cookies.ts` (after the `Cookie` interface)
- Create: `packages/engine/src/rest/cookie-jar.ts`
- Modify: `packages/engine/src/rest/cookies.ts` (header comment; `cookiesToSend` and `CookieMatchOptions` move to `cookie-jar.ts`)
- Modify: `packages/engine/src/index.ts` (lines 535–536)
- Test: `packages/engine/test/unit/rest/cookie-jar.test.ts` (create); `packages/engine/test/unit/rest/cookies.test.ts` (import path only)

**Interfaces:**
- Produces (from `http/cookies.ts`, re-exported by `rest/cookie-jar.ts` and the package root):
  - `interface StoredCookie { name; value; domain; hostOnly: boolean; path; expiresAt?: number; secure: boolean; httpOnly: boolean; sameSite?: 'Strict' | 'Lax' | 'None'; createdAt: number }`
  - `interface CookieKey { name: string; domain: string; path: string }`
  - `type CookieRejection = 'deleted' | 'domain-mismatch' | 'domain-not-allowed' | 'secure-over-http' | 'too-large' | 'malformed'`
  - `type CookieVerdict = { stored: true } | { stored: false; reason: CookieRejection }`
  - `interface CookieJarHost { cookiesFor(url: string): readonly StoredCookie[]; remember(url: string, cookies: readonly Cookie[]): readonly CookieVerdict[] }`
- Produces (from `rest/cookie-jar.ts`):
  - `class CookieJar { constructor(initial?: readonly StoredCookie[]); store(url: string, cookies: readonly Cookie[], now: number): CookieVerdict[]; cookiesFor(url: string, now: number): StoredCookie[]; list(now: number): StoredCookie[]; set(cookie: StoredCookie): void; remove(key: CookieKey): boolean; removeDomain(domain: string): number; clear(): void; persistent(now: number): StoredCookie[] }`
  - `MAX_COOKIES_PER_DOMAIN = 50`, `MAX_COOKIES = 3000`, `MAX_COOKIE_BYTES = 4096`
  - `jarCookieHost(jar: CookieJar, now?: () => number): CookieJarHost`
  - `mergeCookieHeader(jarCookies: readonly StoredCookie[], handSet: string | undefined): string | undefined`
  - `cookiesToSend(cookies: readonly Cookie[], url: string, now?: Date, options?: CookieMatchOptions): Cookie[]` (unchanged signature and results, now over a throwaway jar)

- [ ] **Step 1: Write the failing tests.** Create `packages/engine/test/unit/rest/cookie-jar.test.ts`:

```ts
/**
 * The cookie jar (cookie jar spec §1). A cookie sent to the wrong host, over plain HTTP, or after
 * the server deleted it is a credential leak, so the refusals matter as much as the matches.
 */
import { describe, expect, it } from 'vitest';
import type { Cookie } from '../../../src/http/cookies.js';
import {
  CookieJar,
  jarCookieHost,
  MAX_COOKIES,
  MAX_COOKIES_PER_DOMAIN,
  mergeCookieHeader,
  type StoredCookie,
} from '../../../src/rest/cookie-jar.js';

const NOW = Date.parse('2026-10-03T12:00:00Z');

function cookie(name: string, extra: Partial<Cookie> = {}): Cookie {
  return { name, value: `${name}-value`, ...extra };
}

function names(cookies: readonly StoredCookie[]): string[] {
  return cookies.map((stored) => stored.name);
}

describe('CookieJar — host-only and Domain', () => {
  it('stores a cookie with no Domain as host-only, under the default path of the URL that set it', () => {
    const jar = new CookieJar();
    expect(jar.store('https://api.example.test/v1/login', [cookie('sid')], NOW)).toEqual([{ stored: true }]);
    expect(jar.list(NOW)).toEqual([
      {
        name: 'sid',
        value: 'sid-value',
        domain: 'api.example.test',
        hostOnly: true,
        path: '/v1',
        secure: false,
        httpOnly: false,
        createdAt: NOW,
      },
    ]);
    expect(names(jar.cookiesFor('https://api.example.test/v1/pets', NOW))).toEqual(['sid']);
    expect(jar.cookiesFor('https://www.api.example.test/v1/pets', NOW)).toEqual([]);
    expect(jar.cookiesFor('https://example.test/v1/pets', NOW)).toEqual([]);
  });

  it('lowercases a Domain, strips its dot, and sends it to every host under it', () => {
    const jar = new CookieJar();
    jar.store('https://api.example.test/login', [cookie('wide', { domain: '.Example.TEST', path: '/' })], NOW);
    expect(jar.list(NOW)[0]).toMatchObject({ domain: 'example.test', hostOnly: false, path: '/' });
    expect(names(jar.cookiesFor('https://other.example.test/x', NOW))).toEqual(['wide']);
    expect(names(jar.cookiesFor('https://example.test/', NOW))).toEqual(['wide']);
    expect(jar.cookiesFor('https://evil-example.test/', NOW)).toEqual([]);
  });

  it('refuses a Domain the request host is not part of', () => {
    const jar = new CookieJar();
    expect(jar.store('https://api.example.test/', [cookie('a', { domain: 'other.test' })], NOW)).toEqual([
      { stored: false, reason: 'domain-mismatch' },
    ]);
    expect(jar.store('https://api.example.test/', [cookie('b', { domain: 'api.example.test.evil' })], NOW)).toEqual([
      { stored: false, reason: 'domain-mismatch' },
    ]);
    expect(jar.list(NOW)).toEqual([]);
  });

  it('refuses a single-label or IP Domain unless it is the request host, and then stores it host-only', () => {
    const jar = new CookieJar();
    expect(jar.store('https://api.example.test/', [cookie('tld', { domain: 'test' })], NOW)).toEqual([
      { stored: false, reason: 'domain-not-allowed' },
    ]);
    expect(jar.store('http://10.0.0.5/', [cookie('ip', { domain: '10.0.0.6' })], NOW)).toEqual([
      { stored: false, reason: 'domain-not-allowed' },
    ]);
    expect(jar.store('http://10.0.0.5/', [cookie('same-ip', { domain: '10.0.0.5' })], NOW)).toEqual([{ stored: true }]);
    expect(jar.store('http://localhost/', [cookie('local', { domain: 'localhost' })], NOW)).toEqual([{ stored: true }]);
    expect(jar.list(NOW).map((stored) => [stored.name, stored.domain, stored.hostOnly])).toEqual([
      ['same-ip', '10.0.0.5', true],
      ['local', 'localhost', true],
    ]);
  });
});

describe('CookieJar — paths and order', () => {
  it('defaults a missing or relative Path and matches by path prefix', () => {
    const jar = new CookieJar();
    jar.store('https://api.test/api/v3/login', [cookie('default'), cookie('relative', { path: 'x' })], NOW);
    expect(jar.list(NOW).map((stored) => stored.path)).toEqual(['/api/v3', '/api/v3']);
    expect(names(jar.cookiesFor('https://api.test/api/v3', NOW))).toEqual(['default', 'relative']);
    expect(names(jar.cookiesFor('https://api.test/api/v3/pets', NOW))).toEqual(['default', 'relative']);
    expect(jar.cookiesFor('https://api.test/api/v4', NOW)).toEqual([]);
    expect(jar.cookiesFor('https://api.test/api/v3x', NOW)).toEqual([]);
  });

  it('sends longer paths first, then the earlier created (RFC 6265 §5.4)', () => {
    const jar = new CookieJar();
    jar.store('https://api.test/', [cookie('root-old', { path: '/' })], NOW);
    jar.store('https://api.test/', [cookie('root-new', { path: '/' })], NOW + 5);
    jar.store('https://api.test/', [cookie('deep', { path: '/api' })], NOW + 9);
    expect(names(jar.cookiesFor('https://api.test/api/x', NOW + 10))).toEqual(['deep', 'root-old', 'root-new']);
  });

  it('lists by domain, then name', () => {
    const jar = new CookieJar();
    jar.store('https://b.test/', [cookie('z', { path: '/' }), cookie('a', { path: '/' })], NOW);
    jar.store('https://a.test/', [cookie('m', { path: '/' })], NOW);
    expect(jar.list(NOW).map((stored) => `${stored.domain}/${stored.name}`)).toEqual(['a.test/m', 'b.test/a', 'b.test/z']);
  });
});

describe('CookieJar — replacing, expiry and deletion', () => {
  it('replaces a cookie of the same name, domain and path, keeping when it was first stored', () => {
    const jar = new CookieJar();
    jar.store('https://api.test/', [cookie('sid', { value: '1', path: '/' })], NOW);
    jar.store('https://api.test/', [cookie('sid', { value: '2', path: '/' })], NOW + 1000);
    expect(jar.list(NOW + 1000)).toEqual([expect.objectContaining({ name: 'sid', value: '2', createdAt: NOW })]);
  });

  it('deletes a stored cookie on Max-Age=0, and stores nothing', () => {
    const jar = new CookieJar();
    jar.store('https://api.test/', [cookie('sid', { path: '/' })], NOW);
    expect(jar.store('https://api.test/', [cookie('sid', { path: '/', maxAge: 0 })], NOW + 1)).toEqual([
      { stored: false, reason: 'deleted' },
    ]);
    expect(jar.list(NOW + 1)).toEqual([]);
  });

  it('deletes a stored cookie on an Expires in the past', () => {
    const jar = new CookieJar();
    jar.store('https://api.test/', [cookie('sid', { path: '/' })], NOW);
    expect(
      jar.store('https://api.test/', [cookie('sid', { path: '/', expires: '2020-01-01T00:00:00.000Z' })], NOW),
    ).toEqual([{ stored: false, reason: 'deleted' }]);
    expect(jar.list(NOW)).toEqual([]);
  });

  it('computes expiry from Max-Age before Expires', () => {
    const jar = new CookieJar();
    jar.store('https://api.test/', [cookie('sid', { path: '/', maxAge: 60, expires: '2020-01-01T00:00:00.000Z' })], NOW);
    expect(jar.list(NOW)[0]?.expiresAt).toBe(NOW + 60_000);
  });

  it('drops expired cookies whenever it is read', () => {
    const jar = new CookieJar();
    jar.store('https://api.test/', [cookie('short', { path: '/', maxAge: 10 })], NOW);
    expect(jar.cookiesFor('https://api.test/', NOW + 10_001)).toEqual([]);
    expect(jar.list(NOW + 10_001)).toEqual([]);
    expect(jar.list(NOW)).toEqual([]);
  });

  it('saves only cookies with an expiry', () => {
    const jar = new CookieJar();
    jar.store('https://api.test/', [cookie('session', { path: '/' }), cookie('kept', { path: '/', maxAge: 3600 })], NOW);
    expect(jar.persistent(NOW)).toEqual([expect.objectContaining({ name: 'kept', expiresAt: NOW + 3_600_000 })]);
  });
});

describe('CookieJar — Secure', () => {
  it('refuses a Secure cookie from plain http, and never sends one over it', () => {
    const jar = new CookieJar();
    expect(jar.store('http://api.test/', [cookie('s', { secure: true, path: '/' })], NOW)).toEqual([
      { stored: false, reason: 'secure-over-http' },
    ]);
    jar.store('https://api.test/', [cookie('s', { secure: true, path: '/' })], NOW);
    expect(jar.cookiesFor('http://api.test/', NOW)).toEqual([]);
    expect(names(jar.cookiesFor('https://api.test/', NOW))).toEqual(['s']);
  });

  it('lets no plain http response overwrite a Secure cookie', () => {
    const jar = new CookieJar();
    jar.store('https://api.test/', [cookie('s', { value: 'safe', secure: true, path: '/' })], NOW);
    expect(jar.store('http://api.test/', [cookie('s', { value: 'forged', path: '/' })], NOW)).toEqual([
      { stored: false, reason: 'secure-over-http' },
    ]);
    expect(jar.list(NOW)[0]?.value).toBe('safe');
  });
});

describe('CookieJar — limits', () => {
  it('refuses a name plus value over 4096 bytes', () => {
    const jar = new CookieJar();
    expect(jar.store('https://api.test/', [cookie('big', { value: 'x'.repeat(4094) })], NOW)).toEqual([
      { stored: false, reason: 'too-large' },
    ]);
    expect(jar.store('https://api.test/', [cookie('fit', { value: 'x'.repeat(4093) })], NOW)).toEqual([
      { stored: true },
    ]);
  });

  it('keeps at most 50 per domain, evicting the oldest session cookie', () => {
    const jar = new CookieJar();
    for (let index = 0; index <= MAX_COOKIES_PER_DOMAIN; index += 1) {
      jar.store('https://api.test/', [cookie(`c${String(index)}`, { path: '/' })], NOW + index);
    }
    const kept = names(jar.list(NOW + 100));
    expect(kept).toHaveLength(MAX_COOKIES_PER_DOMAIN);
    expect(kept).not.toContain('c0');
    expect(kept).toContain('c50');
  });

  it('evicts the cookie expiring soonest before any session cookie', () => {
    const jar = new CookieJar();
    jar.store('https://api.test/', [cookie('short', { path: '/', maxAge: 60 })], NOW + 1000);
    for (let index = 0; index < MAX_COOKIES_PER_DOMAIN; index += 1) {
      jar.store('https://api.test/', [cookie(`s${String(index)}`, { path: '/' })], NOW + index);
    }
    const kept = names(jar.list(NOW + 1000));
    expect(kept).toHaveLength(MAX_COOKIES_PER_DOMAIN);
    expect(kept).not.toContain('short');
  });

  it('keeps at most 3000 in all', () => {
    const jar = new CookieJar();
    let stored = 0;
    for (let domain = 0; stored <= MAX_COOKIES; domain += 1) {
      for (let index = 0; index < MAX_COOKIES_PER_DOMAIN && stored <= MAX_COOKIES; index += 1) {
        jar.store(`https://h${String(domain)}.test/`, [cookie(`c${String(index)}`, { path: '/' })], NOW + stored);
        stored += 1;
      }
    }
    expect(jar.list(NOW + stored)).toHaveLength(MAX_COOKIES);
  });
});

describe('CookieJar — verdicts and edits', () => {
  it('gives one verdict per cookie, in order', () => {
    const jar = new CookieJar();
    expect(
      jar.store(
        'https://api.test/',
        [cookie('ok'), { name: 'junk line', value: '', malformed: true }, cookie(''), cookie('far', { domain: 'x.test' })],
        NOW,
      ),
    ).toEqual([
      { stored: true },
      { stored: false, reason: 'malformed' },
      { stored: false, reason: 'malformed' },
      { stored: false, reason: 'domain-mismatch' },
    ]);
  });

  it('refuses everything for a URL it cannot parse', () => {
    expect(new CookieJar().store('not a url', [cookie('a')], NOW)).toEqual([{ stored: false, reason: 'malformed' }]);
    expect(new CookieJar().cookiesFor('not a url', NOW)).toEqual([]);
  });

  it('sets, removes, removes a domain and clears', () => {
    const base: StoredCookie = {
      name: 'a',
      value: '1',
      domain: 'api.test',
      hostOnly: true,
      path: '/',
      secure: false,
      httpOnly: false,
      createdAt: NOW,
    };
    const jar = new CookieJar([base]);
    jar.set({ ...base, name: 'b' });
    jar.set({ ...base, name: 'c', domain: 'other.test' });
    expect(names(jar.list(NOW))).toEqual(['a', 'b', 'c']);
    expect(jar.remove({ name: 'a', domain: 'api.test', path: '/' })).toBe(true);
    expect(jar.remove({ name: 'a', domain: 'api.test', path: '/' })).toBe(false);
    expect(jar.removeDomain('.API.test')).toBe(1);
    expect(names(jar.list(NOW))).toEqual(['c']);
    jar.clear();
    expect(jar.list(NOW)).toEqual([]);
  });
});

describe('mergeCookieHeader', () => {
  const stored = (name: string, value: string): StoredCookie => ({
    name,
    value,
    domain: 'api.test',
    hostOnly: true,
    path: '/',
    secure: false,
    httpOnly: false,
    createdAt: NOW,
  });

  it('puts hand-set pairs first, and they win on the same name', () => {
    expect(mergeCookieHeader([stored('sid', 'jar'), stored('lang', 'en')], 'sid=mine; extra=1')).toBe(
      'sid=mine; extra=1; lang=en',
    );
  });

  it('keeps two jar cookies of one name, in the order given', () => {
    expect(mergeCookieHeader([stored('sid', 'deep'), stored('sid', 'root')], undefined)).toBe('sid=deep; sid=root');
  });

  it('is undefined when there is nothing to send', () => {
    expect(mergeCookieHeader([], undefined)).toBeUndefined();
    expect(mergeCookieHeader([], '  ')).toBeUndefined();
  });
});

describe('jarCookieHost', () => {
  it('reads and stores at the clock it is given', () => {
    const jar = new CookieJar();
    let clock = NOW;
    const host = jarCookieHost(jar, () => clock);
    expect(host.remember('https://api.test/', [cookie('sid', { path: '/', maxAge: 1 })])).toEqual([{ stored: true }]);
    expect(names([...host.cookiesFor('https://api.test/')])).toEqual(['sid']);
    clock = NOW + 1000;
    expect(host.cookiesFor('https://api.test/')).toEqual([]);
  });
});
```

  In `packages/engine/test/unit/rest/cookies.test.ts`, change the import block so `cookiesToSend` comes from the jar module:

```ts
import { cookieHeader, defaultPath, domainMatches, isExpired, pathMatches } from '../../../src/rest/cookies.js';
import { cookiesToSend } from '../../../src/rest/cookie-jar.js';
import type { Cookie } from '../../../src/rest/response.js';
```

- [ ] **Step 2: Run to see it fail.** `pnpm vitest run packages/engine/test/unit/rest/cookie-jar.test.ts packages/engine/test/unit/rest/cookies.test.ts` → FAIL (`cookie-jar.js` does not exist).

- [ ] **Step 3: Add the types to `http/cookies.ts`.** After the `Cookie` interface (it ends `readonly malformed?: boolean;\n}`), insert:

```ts
/**
 * One cookie the jar holds (cookie jar spec §1.1). Its identity is `(name, domain, path)`; the
 * response-side {@link Cookie} becomes one only when the jar stores it, because only then is the
 * request URL known.
 */
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

/** What names one stored cookie. */
export interface CookieKey {
  readonly name: string;
  readonly domain: string;
  readonly path: string;
}

/** Why the jar did not store a cookie a response set. */
export type CookieRejection =
  | 'deleted'
  | 'domain-mismatch'
  | 'domain-not-allowed'
  | 'secure-over-http'
  | 'too-large'
  | 'malformed';

/** The jar's verdict on one cookie a response set. */
export type CookieVerdict = { readonly stored: true } | { readonly stored: false; readonly reason: CookieRejection };

/**
 * What a host lends a send for its cookies (cookie jar spec §1.4): every REST send reports what each
 * response set, redirect hops included, and a request whose `sendCookies` is on carries what the jar
 * matches for each hop's URL. Here, in core, so `run/host.ts` can name it without importing `rest/`.
 */
export interface CookieJarHost {
  /** The jar cookies a request to `url` would carry, in RFC 6265 §5.4 order. */
  cookiesFor(url: string): readonly StoredCookie[];
  /** Stores what a response to `url` set; one verdict per cookie, in order. */
  remember(url: string, cookies: readonly Cookie[]): readonly CookieVerdict[];
}
```

  Also replace the last sentence of the file's header comment, ``re-exports both names; the cookie jar itself stays in `rest/cookies.ts`.``, with ``re-exports both names. The jar's types live here for the same reason; the jar itself is `rest/cookie-jar.ts`.``

- [ ] **Step 4: Create `packages/engine/src/rest/cookie-jar.ts`.**

```ts
/**
 * The cookie jar (cookie jar and current values spec §1): what REST responses set, kept per
 * workspace in the app and per run on the command line, and sent back by requests whose *Send
 * cookies* setting is on.
 *
 * Storing follows RFC 6265 §5.3, and RFC 6265bis §5.6 for Secure. A cookie's identity is its name,
 * domain and path. A newer cookie replaces an older one but keeps its creation time. A cookie that
 * is already expired deletes the stored one instead. There is no public-suffix list: see
 * `docs/security.md`, "The cookie jar".
 */
import type {
  Cookie,
  CookieJarHost,
  CookieKey,
  CookieRejection,
  CookieVerdict,
  StoredCookie,
} from '../http/cookies.js';
import { defaultPath, domainMatches, pathMatches } from './cookies.js';

export type { CookieJarHost, CookieKey, CookieRejection, CookieVerdict, StoredCookie } from '../http/cookies.js';

/** At most this many cookies per domain (spec §1.2). */
export const MAX_COOKIES_PER_DOMAIN = 50;
/** At most this many cookies in one jar. */
export const MAX_COOKIES = 3000;
/** A name plus value over this many UTF-8 bytes is not stored. */
export const MAX_COOKIE_BYTES = 4096;

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const encoder = new TextEncoder();

function isIpAddress(host: string): boolean {
  return IPV4.test(host) || host.includes(':') || host.startsWith('[');
}

function idOf(key: CookieKey): string {
  return `${key.domain}\n${key.path}\n${key.name}`;
}

function rejected(reason: CookieRejection): CookieVerdict {
  return { stored: false, reason };
}

/** When `cookie` expires, from Max-Age first and then Expires (§5.3 step 3); undefined for a session cookie. */
function expiresAtOf(cookie: Cookie, now: number): number | undefined {
  if (cookie.maxAge !== undefined) {
    return now + cookie.maxAge * 1000;
  }
  if (cookie.expires === undefined) {
    return undefined;
  }
  const at = Date.parse(cookie.expires);
  return Number.isNaN(at) ? undefined : at;
}

/** The domain a cookie from `host` is stored under, or why it is refused (spec §1.3). */
function scopeOf(
  cookie: Cookie,
  host: string,
): { readonly domain: string; readonly hostOnly: boolean } | CookieRejection {
  const declared = (cookie.domain ?? '').replace(/^\./, '').toLowerCase();
  if (declared === '') {
    return { domain: host, hostOnly: true };
  }
  const restricted = isIpAddress(declared) || !declared.includes('.');
  if (declared === host) {
    // An IP or a single label is honoured only as the host itself, and then only host-only.
    return { domain: host, hostOnly: restricted };
  }
  if (restricted) {
    return 'domain-not-allowed';
  }
  return domainMatches(host, declared) ? { domain: declared, hostOnly: false } : 'domain-mismatch';
}

/** RFC 6265 §5.4 step 2: longer paths first, then the earlier created. */
function sendOrder(a: StoredCookie, b: StoredCookie): number {
  return b.path.length - a.path.length || a.createdAt - b.createdAt;
}

/** Which cookie a full jar lets go first: the soonest to expire (a session cookie last), then the oldest. */
function evictionOrder(a: StoredCookie, b: StoredCookie): number {
  const aExpires = a.expiresAt ?? Number.POSITIVE_INFINITY;
  const bExpires = b.expiresAt ?? Number.POSITIVE_INFINITY;
  if (aExpires !== bExpires) {
    return aExpires < bExpires ? -1 : 1;
  }
  return a.createdAt - b.createdAt;
}

function listOrder(a: StoredCookie, b: StoredCookie): number {
  return a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path);
}

export class CookieJar {
  private readonly cookies = new Map<string, StoredCookie>();

  constructor(initial: readonly StoredCookie[] = []) {
    for (const cookie of initial) {
      this.cookies.set(idOf(cookie), cookie);
    }
  }

  /** Stores what a response to `url` set, at `now`: one verdict per cookie, in order. */
  store(url: string, cookies: readonly Cookie[], now: number): CookieVerdict[] {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return cookies.map(() => rejected('malformed'));
    }
    return cookies.map((cookie) => this.storeOne(cookie, target, now));
  }

  /** The cookies a request to `url` carries at `now`, in RFC 6265 §5.4 order. */
  cookiesFor(url: string, now: number): StoredCookie[] {
    this.dropExpired(now);
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return [];
    }
    const host = target.hostname.toLowerCase();
    const secureContext = target.protocol === 'https:';
    const path = target.pathname === '' ? '/' : target.pathname;
    return [...this.cookies.values()]
      .filter(
        (cookie) =>
          (cookie.hostOnly ? host === cookie.domain : domainMatches(host, cookie.domain)) &&
          pathMatches(path, cookie.path) &&
          (!cookie.secure || secureContext),
      )
      .sort(sendOrder);
  }

  /** Every unexpired cookie, by domain, then name, then path. */
  list(now: number): StoredCookie[] {
    this.dropExpired(now);
    return [...this.cookies.values()].sort(listOrder);
  }

  /** Stores `cookie` as given, replacing one of the same identity. The manager's edit. */
  set(cookie: StoredCookie): void {
    this.cookies.set(idOf(cookie), cookie);
  }

  remove(key: CookieKey): boolean {
    return this.cookies.delete(idOf(key));
  }

  /** Removes every cookie stored under `domain` (lowercased, leading dot ignored); how many went. */
  removeDomain(domain: string): number {
    const target = domain.replace(/^\./, '').toLowerCase();
    let removed = 0;
    for (const [id, cookie] of this.cookies) {
      if (cookie.domain === target) {
        this.cookies.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.cookies.clear();
  }

  /** The cookies worth saving: unexpired, with an expiry. */
  persistent(now: number): StoredCookie[] {
    return this.list(now).filter((cookie) => cookie.expiresAt !== undefined);
  }

  private storeOne(cookie: Cookie, target: URL, now: number): CookieVerdict {
    if (cookie.malformed === true || cookie.name === '') {
      return rejected('malformed');
    }
    if (encoder.encode(cookie.name).length + encoder.encode(cookie.value).length > MAX_COOKIE_BYTES) {
      return rejected('too-large');
    }
    const secureContext = target.protocol === 'https:';
    if (cookie.secure === true && !secureContext) {
      return rejected('secure-over-http');
    }
    const scope = scopeOf(cookie, target.hostname.toLowerCase());
    if (typeof scope === 'string') {
      return rejected(scope);
    }
    const declaredPath = cookie.path;
    const path =
      declaredPath !== undefined && declaredPath.startsWith('/') ? declaredPath : defaultPath(target.pathname);
    const id = idOf({ name: cookie.name, domain: scope.domain, path });
    const existing = this.cookies.get(id);
    if (existing?.secure === true && !secureContext) {
      return rejected('secure-over-http');
    }
    const expiresAt = expiresAtOf(cookie, now);
    if (expiresAt !== undefined && expiresAt <= now) {
      this.cookies.delete(id);
      return rejected('deleted');
    }
    this.cookies.set(id, {
      name: cookie.name,
      value: cookie.value,
      domain: scope.domain,
      hostOnly: scope.hostOnly,
      path,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      secure: cookie.secure === true,
      httpOnly: cookie.httpOnly === true,
      ...(cookie.sameSite !== undefined ? { sameSite: cookie.sameSite } : {}),
      createdAt: existing?.createdAt ?? now,
    });
    this.enforceLimits(scope.domain, now);
    return { stored: true };
  }

  private dropExpired(now: number): void {
    for (const [id, cookie] of this.cookies) {
      if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) {
        this.cookies.delete(id);
      }
    }
  }

  private enforceLimits(domain: string, now: number): void {
    this.dropExpired(now);
    const inDomain = [...this.cookies.values()].filter((cookie) => cookie.domain === domain);
    this.evict(inDomain, inDomain.length - MAX_COOKIES_PER_DOMAIN);
    this.evict([...this.cookies.values()], this.cookies.size - MAX_COOKIES);
  }

  private evict(candidates: readonly StoredCookie[], count: number): void {
    if (count <= 0) {
      return;
    }
    for (const cookie of [...candidates].sort(evictionOrder).slice(0, count)) {
      this.cookies.delete(idOf(cookie));
    }
  }
}

/** A {@link CookieJarHost} over `jar`, reading the time from `now`. */
export function jarCookieHost(jar: CookieJar, now: () => number = () => Date.now()): CookieJarHost {
  return {
    cookiesFor: (url) => jar.cookiesFor(url, now()),
    remember: (url, cookies) => jar.store(url, cookies, now()),
  };
}

/**
 * The `Cookie` header a request carries: the pairs it sets by hand, then the jar's, in the order
 * given. A jar cookie is left out when a hand-set pair has its name. Unlike `cookieHeader`, two jar
 * cookies of one name on different paths both go, most specific first, as RFC 6265 §5.4 sends them.
 */
export function mergeCookieHeader(jarCookies: readonly StoredCookie[], handSet: string | undefined): string | undefined {
  const hand = (handSet ?? '')
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair !== '');
  const handNames = new Set(
    hand.map((pair) => {
      const equals = pair.indexOf('=');
      return (equals === -1 ? pair : pair.slice(0, equals)).trim();
    }),
  );
  const pairs = [
    ...hand,
    ...jarCookies.filter((cookie) => !handNames.has(cookie.name)).map((cookie) => `${cookie.name}=${cookie.value}`),
  ];
  return pairs.length === 0 ? undefined : pairs.join('; ');
}

/** Options for {@link cookiesToSend}. */
export interface CookieMatchOptions {
  /** When the cookies were received, for a `Max-Age` that is relative to that moment. */
  readonly setAt?: Date;
}

/**
 * The cookies of `cookies` that a request to `url` should carry at `now`, in the order given. Kept
 * for the engine's public API: each cookie is stored, as received from `url`, in a throwaway jar and
 * kept when that jar would send it back to `url`.
 */
export function cookiesToSend(
  cookies: readonly Cookie[],
  url: string,
  now: Date = new Date(),
  options: CookieMatchOptions = {},
): Cookie[] {
  const storedAt = (options.setAt ?? now).getTime();
  return cookies.filter((cookie) => {
    const jar = new CookieJar();
    jar.store(url, [cookie], storedAt);
    return jar.cookiesFor(url, now.getTime()).length > 0;
  });
}
```

- [ ] **Step 5: Trim `rest/cookies.ts`.** Replace the header comment (lines 1–11) with:

```ts
/**
 * RFC 6265 matching for the cookie jar (`rest/cookie-jar.ts`): domain-match and path-match (§5.1.3,
 * §5.1.4), expiry (§5.3), and the `Cookie` header (§5.4).
 *
 * Every REST send stores what its responses set in a jar: the open workspace's in the app, the run's
 * on the command line. A request sends the jar's matching cookies only when its *Send cookies*
 * setting is on, which is off by default, so a saved request stays reproducible unless it opts in.
 * The app saves only cookies with an expiry, encrypted; session cookies never reach disk.
 */
```

  Then delete the `CookieMatchOptions` interface and the `cookiesToSend` function with its doc comment (they now live in `cookie-jar.ts`). `domainMatches`, `defaultPath`, `pathMatches`, `isExpired` and `cookieHeader` stay as they are.

- [ ] **Step 6: Export.** In `packages/engine/src/index.ts`, replace lines 535–536:

```ts
export { cookieHeader, cookiesToSend, defaultPath, domainMatches, isExpired, pathMatches } from './rest/cookies.js';
export type { CookieMatchOptions } from './rest/cookies.js';
```

  with:

```ts
export { cookieHeader, defaultPath, domainMatches, isExpired, pathMatches } from './rest/cookies.js';
export {
  CookieJar,
  cookiesToSend,
  jarCookieHost,
  MAX_COOKIE_BYTES,
  MAX_COOKIES,
  MAX_COOKIES_PER_DOMAIN,
  mergeCookieHeader,
} from './rest/cookie-jar.js';
export type {
  CookieJarHost,
  CookieKey,
  CookieMatchOptions,
  CookieRejection,
  CookieVerdict,
  StoredCookie,
} from './rest/cookie-jar.js';
```

- [ ] **Step 7: Run to see it pass.** `pnpm vitest run packages/engine/test/unit/rest/cookie-jar.test.ts packages/engine/test/unit/rest/cookies.test.ts` → PASS. Then `node scripts/engine-import-graph.mjs --check` → no violation (`rest/` imports core `http/`, never the reverse).

- [ ] **Step 8: Gate and commit.**

```bash
WIREBENCH_SKIP_PERF=1 pnpm check
git add packages/engine/src/http/cookies.ts packages/engine/src/rest/cookie-jar.ts packages/engine/src/rest/cookies.ts packages/engine/src/index.ts packages/engine/test/unit/rest/cookie-jar.test.ts packages/engine/test/unit/rest/cookies.test.ts
git commit -m "feat(engine): a cookie jar with RFC 6265 storing and matching (#44)"
```


### Task 2: The send seam: per-hop cookies through `SendHost.cookies`

**Files:**
- Modify: `packages/engine/src/http/types.ts` (after `readonly stream?: HttpStreamHook;` and after the `HttpStreamHook` interface)
- Modify: `packages/engine/src/http/client.ts` (`sendHttp`, ~lines 420–470 and the final `return`)
- Modify: `packages/engine/src/run/host.ts` (import line 5; the `cookies` member, ~lines 79–84)
- Modify: `packages/engine/src/rest/send.ts` (imports; `RestSendInput`; `RestExchange`; `sendRest`)
- Modify: `packages/engine/src/rest/run.ts` (`resolveRest` ~line 120; `connectAndSend` ~lines 373–393)
- Modify: `packages/engine/test/helpers/test-rest-server.ts` (route list comment ~line 149; routes ~line 419)
- Modify: `apps/desktop/src/main/send/host.ts` (drop the old per-request `cookies` member, lines 106–111)
- Test: `packages/engine/test/integration/run/rest-exchange.test.ts`; `apps/desktop/test/send-host.test.ts` (drop "keeps cookies per request")

**Interfaces:**
- Consumes: `CookieJarHost`, `CookieVerdict`, `mergeCookieHeader`, `CookieJar`, `jarCookieHost` (Task 1).
- Produces:
  - `interface HttpCookieHook { header(url: string, handSet: string | undefined): string | undefined; received(url: string, rawHeaders: readonly (readonly [string, string])[]): void }` and `HttpRequest.cookies?: HttpCookieHook` (`http/types.ts`)
  - `SendHost.cookies?: CookieJarHost` (`run/host.ts`)
  - `RestSendInput.jar?: { readonly host: CookieJarHost; readonly send: boolean }`; `RestExchange.cookieVerdicts?: readonly CookieVerdict[]` (`rest/send.ts`)

- [ ] **Step 1: Add a redirecting route to the test server.** In `packages/engine/test/helpers/test-rest-server.ts`, add to the route list comment after `` * - `/cookies/read` — the `Cookie` header it received, as JSON``:

```ts
 * - `/cookies/hop` — a 302 to `/cookies/read` that sets `hop=1; Path=/` on the way
```

  and after the `/cookies/read` route:

```ts
      if (path === '/cookies/hop') {
        response.writeHead(302, { location: `${selfOrigin}/cookies/read`, 'set-cookie': 'hop=1; Path=/' });
        response.end();
        return;
      }
```

- [ ] **Step 2: Write the failing tests.** In `packages/engine/test/integration/run/rest-exchange.test.ts`:
  - Change the imports to:

```ts
import {
  CookieJar,
  createApi,
  createProject,
  createRestRequest,
  createWebhookCollection,
  DEFAULT_PREFERENCES,
  jarCookieHost,
  restItemFor,
} from '../../../src/index.js';
import type { CookieJarHost, Project, RestRequestDef } from '../../../src/index.js';
```

  - Replace the whole test `it('sends the stored cookies only when the request asks, and remembers new ones', …)` with:

```ts
  describe('the cookie jar', () => {
    const jarHost = (): { jar: CookieJar; cookies: CookieJarHost } => {
      const jar = new CookieJar();
      return { jar, cookies: jarCookieHost(jar) };
    };

    it('stores what a response sets whatever the setting, and sends it only when the request asks', async () => {
      const { jar, cookies } = jarHost();
      const set = await open(restItem('/cookies/set'), {}, { cookies }).result;
      expect(set.exchange?.kind === 'rest' && set.exchange.rest.cookieVerdicts).toEqual([
        { stored: true },
        { stored: true },
      ]);
      expect(jar.list(Date.now()).map((cookie) => cookie.name)).toEqual(['session', 'tracking']);

      const off = await open(restItem('/cookies/read'), {}, { cookies }).result;
      expect(JSON.parse(off.subject.bodyText)).toEqual({ cookie: null });
      // `tracking` is scoped to `/deep`, so only `session` matches `/cookies/read`.
      const on = await open(restItem('/cookies/read', { sendCookies: true }), {}, { cookies }).result;
      expect(JSON.parse(on.subject.bodyText)).toEqual({ cookie: 'session=abc' });
    });

    it('lets a hand-set Cookie header win on the same name', async () => {
      const { cookies } = jarHost();
      await open(restItem('/cookies/set'), {}, { cookies }).result;
      const p = project(
        server.url,
        createRestRequest('Req', {
          id: 'r1',
          url: '/cookies/read',
          settings: { sendCookies: true },
          headers: [{ name: 'Cookie', value: 'session=mine; extra=1', enabled: true }],
        }),
      );
      const sent = await open({ p, item: selectRequests(p, ['Api/Req']).selected[0]! }, {}, { cookies }).result;
      expect(JSON.parse(sent.subject.bodyText)).toEqual({ cookie: 'session=mine; extra=1' });
    });

    it('stores each redirect hop against its own URL, and reads the jar again for the next', async () => {
      const { jar, cookies } = jarHost();
      const sent = await open(
        restItem('/cookies/hop', { sendCookies: true, followRedirects: true }),
        {},
        { cookies },
      ).result;
      expect(JSON.parse(sent.subject.bodyText)).toEqual({ cookie: 'hop=1' });
      expect(jar.list(Date.now())).toEqual([
        expect.objectContaining({ name: 'hop', domain: new URL(server.url).hostname, hostOnly: true, path: '/' }),
      ]);
    });

    it('stores and sends nothing when the host lends no jar', async () => {
      const sent = await open(restItem('/cookies/set')).result;
      expect(sent.exchange?.kind === 'rest' && sent.exchange.rest.cookieVerdicts).toBeUndefined();
    });
  });
```

- [ ] **Step 3: Run to see it fail.** `pnpm vitest run packages/engine/test/integration/run/rest-exchange.test.ts` → FAIL. It does not compile yet: `SendHost.cookies` still has the old shape, and `cookieVerdicts` does not exist.

- [ ] **Step 4: The HTTP client hook.** In `packages/engine/src/http/types.ts`, after `readonly stream?: HttpStreamHook;` (inside `HttpRequest`), add:

```ts
  /**
   * The cookie jar, hop by hop (cookie jar spec §1.4). Every attempt's `Cookie` header is what
   * `header` answers for that attempt's URL, given the hand-set one; every response, a redirect's
   * included, is reported to `received` with its own URL. Absent: headers go out as given.
   */
  readonly cookies?: HttpCookieHook;
```

  and after the `HttpStreamHook` interface:

```ts
/** How a send carries and stores cookies per hop; see {@link HttpRequest.cookies}. */
export interface HttpCookieHook {
  /** The `Cookie` header for a request to `url`; `handSet` is the one the request sets itself, if any. */
  header(url: string, handSet: string | undefined): string | undefined;
  /** What a response to `url` set, as its raw headers. */
  received(url: string, rawHeaders: readonly (readonly [string, string])[]): void;
}
```

  In `packages/engine/src/http/client.ts`, add `HttpCookieHook` to the type import from `'./types.js'`. After `scopeCredentialsToOrigin`, add:

```ts
/** `headers` with its `Cookie` header replaced by what `hook` sends to `url`, given the hand-set one. */
function withJarCookies(headers: Record<string, string>, hook: HttpCookieHook, url: URL): Record<string, string> {
  let handSet: string | undefined;
  const rest: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'cookie') {
      handSet = value;
    } else {
      rest[name] = value;
    }
  }
  const cookie = hook.header(url.toString(), handSet);
  return cookie === undefined ? rest : { ...rest, Cookie: cookie };
}
```

  In `sendHttp`, replace:

```ts
    let currentHeaders: Record<string, string> = { ...req.headers };
    let result: PhysicalResult | undefined;

    for (let attempt = 0; attempt <= maxRedirects; attempt++) {
      // Tells the tracker which origin the TLS events it is about to see belong to.
      tracker.setOrigin(currentUrl.origin);
      const finalHeaders = buildFinalHeaders(
        { ...req, headers: currentHeaders, method: currentMethod },
        currentUrl,
        currentBody,
      );
      lastAttempt = failedRequestFor(currentUrl.toString(), currentMethod, finalHeaders, currentBody);
      const rawRequest = buildRawRequest(
        { ...req, url: currentUrl.toString(), method: currentMethod, headers: currentHeaders },
        finalHeaders,
        currentBody,
      );
```

  with:

```ts
    let currentHeaders: Record<string, string> = { ...req.headers };
    // What the last attempt sent: with a cookie hook, its `Cookie` header is the jar's.
    let sentHeaders: Readonly<Record<string, string>> = req.headers;
    let result: PhysicalResult | undefined;

    for (let attempt = 0; attempt <= maxRedirects; attempt++) {
      // Tells the tracker which origin the TLS events it is about to see belong to.
      tracker.setOrigin(currentUrl.origin);
      // The jar is matched afresh for every hop's URL (cookie jar spec §1.4). `currentHeaders` holds
      // only the hand-set `Cookie`, which a cross-origin hop has already dropped.
      const attemptHeaders =
        req.cookies === undefined ? currentHeaders : withJarCookies(currentHeaders, req.cookies, currentUrl);
      sentHeaders = attemptHeaders;
      const finalHeaders = buildFinalHeaders(
        { ...req, headers: attemptHeaders, method: currentMethod },
        currentUrl,
        currentBody,
      );
      lastAttempt = failedRequestFor(currentUrl.toString(), currentMethod, finalHeaders, currentBody);
      const rawRequest = buildRawRequest(
        { ...req, url: currentUrl.toString(), method: currentMethod, headers: attemptHeaders },
        finalHeaders,
        currentBody,
      );
```

  In the `undiciRequest(currentUrl, { … })` options, change `headers: currentHeaders,` to `headers: attemptHeaders,`. After `const { headers, rawHeaders } = joinHeaders(response.headers);` add:

```ts
      // Every hop's Set-Cookie is stored against that hop's URL, before a redirect is followed.
      req.cookies?.received(currentUrl.toString(), rawHeaders);
```

  In the final `return`, replace `request: { url: result.finalUrl, method: result.finalMethod, headers: req.headers },` with:

```ts
      request: {
        url: result.finalUrl,
        method: result.finalMethod,
        headers: req.cookies === undefined ? req.headers : sentHeaders,
      },
```

- [ ] **Step 5: `SendHost.cookies`.** In `packages/engine/src/run/host.ts`, replace `import type { Cookie } from '../http/cookies.js';` with `import type { CookieJarHost } from '../http/cookies.js';`, and replace the whole `readonly cookies?: { … };` member (its doc comment and both methods) with:

```ts
  /**
   * The cookie jar (cookie jar spec §1.4): every REST send stores what each response sets, redirect
   * hops included, and a request whose `sendCookies` setting is on carries what matches each hop's
   * URL. Absent: nothing is stored or sent.
   */
  readonly cookies?: CookieJarHost;
```

- [ ] **Step 6: `sendRest` drives the hook.** In `packages/engine/src/rest/send.ts`:
  - Imports: add `HttpCookieHook` to the type import from `'../http/types.js'`, and add:

```ts
import type { CookieJarHost, CookieVerdict } from '../http/cookies.js';
import { mergeCookieHeader } from './cookie-jar.js';
```

  - In `RestSendInput`, replace the `cookies` member's doc comment with ``/** Cookies to send back, already matched against the URL. Kept for the engine's API; a run sends through `jar`. */`` and add after it:

```ts
  /**
   * The cookie jar this send stores into and, when `send` is set, reads from (cookie jar spec
   * §1.4). Each hop of a redirect is matched and stored against its own URL. A hand-set `Cookie`
   * header goes first and wins on the same name.
   */
  readonly jar?: { readonly host: CookieJarHost; readonly send: boolean };
```

  - In `RestExchange`, after `readonly cookies: readonly Cookie[];` add:

```ts
  /** The jar's verdict on each of `cookies`, in order; present when the send had a jar. */
  readonly cookieVerdicts?: readonly CookieVerdict[];
```

  - In `sendRest`, immediately before `const httpRequest: HttpRequest = {`, add:

```ts
  // The jar stores every hop's cookies whatever the setting; it is read only when `send` is on.
  const jar = input.jar;
  const received: { verdicts?: readonly CookieVerdict[] } = {};
  const cookieHook: HttpCookieHook | undefined =
    jar === undefined
      ? undefined
      : {
          header: (url, handSet) => (jar.send ? mergeCookieHeader(jar.host.cookiesFor(url), handSet) : handSet),
          received: (url, rawHeaders) => {
            received.verdicts = jar.host.remember(url, parseSetCookie(rawHeaders));
          },
        };
```

  - In the `httpRequest` literal, after the `...(sseState !== undefined && onStream !== undefined ? { stream: sseState.hook(onStream) } : {}),` line, add `...(cookieHook !== undefined ? { cookies: cookieHook } : {}),`.
  - Replace the final `return { … }` of `sendRest` with:

```ts
  return {
    ...decodeRestResponse(authenticated.http, methodFor(request.method), sseState),
    ...(authenticated.auth !== undefined ? { auth: authenticated.auth } : {}),
    // The last hop reported is the final response, whose cookies `cookies` lists.
    ...(received.verdicts !== undefined ? { cookieVerdicts: received.verdicts } : {}),
    durationMs: authenticated.durationMs,
  };
```

- [ ] **Step 7: `rest/run.ts` lends the jar.** In `resolveRest`, delete the line `const cookies = request.settings.sendCookies === true ? context.host.cookies?.cookiesFor(selected) : undefined;` and the `...(cookies !== undefined ? { cookies } : {}),` line of the `toRestSendInput({ … })` call. In `connectAndSend`, replace:

```ts
    exchange = await sendRest({
      ...connected,
      signal: controller.signal,
```

  with:

```ts
    exchange = await sendRest({
      ...connected,
      signal: controller.signal,
      // Not part of `connected`, which History and the log keep: the jar is the host's, per send.
      ...(context.host.cookies !== undefined
        ? { jar: { host: context.host.cookies, send: selected.request.settings.sendCookies === true } }
        : {}),
```

  and delete these two lines after `dropRefusedToken(…)`:

```ts
  // As the app does after every send: what the response set replaces what was stored, and none forgets it.
  context.host.cookies?.remember(selected, exchange.cookies);
```

- [ ] **Step 8: The desktop drops the per-request member.** The engine no longer accepts it, so `apps/desktop` would stop compiling. In `apps/desktop/src/main/send/host.ts`, delete the `cookies: { cookiesFor: …, remember: … },` member of the object `desktopSendHost` returns (Task 5 lends the workspace jar instead). In `apps/desktop/test/send-host.test.ts`, delete the test `it('keeps cookies per request', …)`.

- [ ] **Step 9: Run to see it pass.**

```bash
pnpm vitest run packages/engine/test/integration/run/rest-exchange.test.ts packages/engine/test/unit/rest apps/desktop/test/send-host.test.ts
```

  Expected: PASS. Then `pnpm typecheck` passes: `ProjectHost.restCookiesFor`/`rememberRestCookies` still exist but nothing calls them; Task 5 removes them.

- [ ] **Step 10: Gate and commit.**

```bash
WIREBENCH_SKIP_PERF=1 pnpm check
git add packages/engine/src/http/types.ts packages/engine/src/http/client.ts packages/engine/src/run/host.ts packages/engine/src/rest/send.ts packages/engine/src/rest/run.ts packages/engine/test/helpers/test-rest-server.ts packages/engine/test/integration/run/rest-exchange.test.ts apps/desktop/src/main/send/host.ts apps/desktop/test/send-host.test.ts
git commit -m "feat(engine): REST sends store into and read from the host's cookie jar, per redirect hop (#44)"
```

### Task 3: A jar per run, per call and per MCP server

**Files:**
- Modify: `packages/cli/src/send-host.ts`
- Modify: `packages/cli/src/ops/context.ts` (`OpsBase`)
- Modify: `packages/cli/src/commands/ops.ts` (`opsBaseFor`)
- Modify: `packages/cli/src/ops/send.ts` (`sendAndRecord`, the `cliSendHost({ … })` call ~line 212)
- Modify: `packages/cli/src/commands/run.ts` (the `cliSendHost({ … })` call ~line 230)
- Test: `packages/cli/test/unit/send-host.test.ts`; `packages/cli/test/unit/ops-base.test.ts` (create); `packages/cli/test/integration/cookie-jar.test.ts` (create)

**Interfaces:**
- Consumes: `CookieJar`, `jarCookieHost`, `CookieJarHost` (Task 1); `SendHost.cookies` (Task 2).
- Produces: `cliSendHost(args: { getSecret; env; onSecretValue; cookies?: CookieJarHost }): SendHost`; `OpsBase.cookies?: CookieJarHost`.

- [ ] **Step 1: Write the failing tests.** Replace `packages/cli/test/unit/send-host.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import { CookieJar, jarCookieHost } from '@wirebench/engine';
import { cliSendHost } from '../../src/send-host.js';

const base = { getSecret: () => Promise.resolve(undefined), onSecretValue: () => undefined };

describe('cliSendHost', () => {
  it('chooses the proxy from the environment, asynchronously, and lends nothing else', async () => {
    const host = cliSendHost({ ...base, env: { HTTPS_PROXY: 'http://p:8080' } });
    expect(await host.proxyFor?.('https://api.test/x')).toEqual({ url: 'http://p:8080/' });
    expect(host.tokens).toBeUndefined();
    expect(host.preferences).toBeUndefined();
    expect(host.tls).toBeUndefined();
    expect(host.cookies).toBeUndefined();
  });

  it('lends the cookie jar it is given', () => {
    const cookies = jarCookieHost(new CookieJar());
    expect(cliSendHost({ ...base, env: {}, cookies }).cookies).toBe(cookies);
  });
});
```

  Create `packages/cli/test/unit/ops-base.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { opsBaseFor } from '../../src/commands/ops.js';
import { OPEN_GATES } from '../../src/ops/context.js';

const io = { stderr: { write: () => true }, env: {} } as unknown as Parameters<typeof opsBaseFor>[1];

describe('opsBaseFor', () => {
  it('gives each process its own cookie jar, shared by every op it runs', () => {
    const base = opsBaseFor({ project: '.', gates: OPEN_GATES, origin: 'mcp' }, io);
    base.cookies?.remember('https://api.test/login', [{ name: 'sid', value: '1', path: '/' }]);
    expect(base.cookies?.cookiesFor('https://api.test/me').map((cookie) => cookie.name)).toEqual(['sid']);

    const other = opsBaseFor({ project: '.', gates: OPEN_GATES, origin: 'cli' }, io);
    expect(other.cookies?.cookiesFor('https://api.test/me')).toEqual([]);
  });
});
```

  Create `packages/cli/test/integration/cookie-jar.test.ts`:

```ts
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApi, createProject, createRestRequest, saveProject } from '@wirebench/engine';
import { runCli } from './helpers.js';

let dir: string;
let close: () => Promise<void>;
/** The `Cookie` header of every request but the login, in order. */
const seen: (string | null)[] = [];

beforeAll(async () => {
  const server = createServer((req, res) => {
    if (req.url === '/login') {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=run-cookie; Path=/' });
      res.end('{}');
      return;
    }
    seen.push(req.headers.cookie ?? null);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  close = () => new Promise((resolve) => server.close(() => resolve()));
  dir = await mkdtemp(join(tmpdir(), 'wb-cli-jar-'));
  await saveProject(
    {
      ...createProject('Jar', { id: 'p-jar' }),
      apis: [
        {
          ...createApi('Api', { id: 'api-1', slug: 'api', baseUrl: base }),
          requests: [
            createRestRequest('Login', { id: 'r1', slug: 'login', order: 0, url: '/login' }),
            createRestRequest('Me', { id: 'r2', slug: 'me', order: 1, url: '/me', settings: { sendCookies: true } }),
            createRestRequest('Anon', { id: 'r3', slug: 'anon', order: 2, url: '/anon' }),
          ],
        },
      ],
    },
    dir,
  );
});
afterAll(async () => {
  await close();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  seen.length = 0;
});

describe('wirebench run keeps one cookie jar per run (cookie jar spec §4)', () => {
  it('carries a cookie an earlier request received, only where Send cookies is on', async () => {
    const { code } = await runCli(['run', dir, 'Api/Login', 'Api/Me', 'Api/Anon'], {});
    expect(code).toBe(0);
    expect(seen).toEqual(['sid=run-cookie', null]);
  });

  it('keeps nothing from one run to the next', async () => {
    const { code } = await runCli(['run', dir, 'Api/Me'], {});
    expect(code).toBe(0);
    expect(seen).toEqual([null]);
  });
});
```

- [ ] **Step 2: Run to see it fail.** `pnpm vitest run packages/cli/test/unit/send-host.test.ts packages/cli/test/unit/ops-base.test.ts packages/cli/test/integration/cookie-jar.test.ts`. Expected: FAIL. `cookies` is not a `cliSendHost` argument or an `OpsBase` member, and the run sends no cookie.

- [ ] **Step 3: Implement.** Replace `packages/cli/src/send-host.ts` with:

```ts
/**
 * What the command line lends a send (spec §3.1): the environment's secrets and proxy, and the cookie
 * jar of the run, call or MCP server the send belongs to (cookie jar spec §4). Nothing persists.
 */
import type { CookieJarHost, GetSecret, SendHost } from '@wirebench/engine';
import { proxyFromEnv } from './proxy-env.js';

export function cliSendHost(args: {
  readonly getSecret: GetSecret;
  readonly env: NodeJS.ProcessEnv;
  readonly onSecretValue: (value: string) => void;
  /** The in-memory jar REST sends store into and, with Send cookies on, read from. */
  readonly cookies?: CookieJarHost;
}): SendHost {
  const proxyFor = proxyFromEnv(args.env);
  return {
    getSecret: args.getSecret,
    proxyFor: (url) => Promise.resolve(proxyFor(url)),
    onSecretValue: args.onSecretValue,
    ...(args.cookies !== undefined ? { cookies: args.cookies } : {}),
  };
}
```

  In `packages/cli/src/ops/context.ts`, add `import type { CookieJarHost } from '@wirebench/engine';` and, in `OpsBase` after `warn`:

```ts
  /**
   * The cookie jar this process's REST sends share (cookie jar spec §4): one per `wirebench call`,
   * one per MCP server for its lifetime. In memory only. Absent: no jar.
   */
  readonly cookies?: CookieJarHost;
```

  In `packages/cli/src/commands/ops.ts`, add `import { CookieJar, jarCookieHost } from '@wirebench/engine';`. In the object `opsBaseFor` returns, after `warn: …`, add:

```ts
    // One jar per process: a `call` sends once, an MCP server shares it across its tools.
    cookies: jarCookieHost(new CookieJar()),
```

  In `packages/cli/src/ops/send.ts`, inside `sendAndRecord`'s `cliSendHost({ … })` call, after `onSecretValue: (secret) => tokens.add(secret),` add:

```ts
      ...(context.cookies !== undefined ? { cookies: context.cookies } : {}),
```

  In `packages/cli/src/commands/run.ts`, add `CookieJar` and `jarCookieHost` to the value import from `'@wirebench/engine'`. Inside the run's `cliSendHost({ … })` call, after `onSecretValue: (value) => tokens.add(value),` add:

```ts
      // One jar for the whole run: every request, sequence step and iteration shares it.
      cookies: jarCookieHost(new CookieJar()),
```

- [ ] **Step 4: Run to see it pass.** Same command as Step 2 → PASS (the integration project builds the CLI first through its global setup).

- [ ] **Step 5: Gate and commit.**

```bash
WIREBENCH_SKIP_PERF=1 pnpm check
git add packages/cli/src/send-host.ts packages/cli/src/ops/context.ts packages/cli/src/commands/ops.ts packages/cli/src/ops/send.ts packages/cli/src/commands/run.ts packages/cli/test/unit/send-host.test.ts packages/cli/test/unit/ops-base.test.ts packages/cli/test/integration/cookie-jar.test.ts
git commit -m "feat(cli): one in-memory cookie jar per run, call and MCP server (#44)"
```


### Task 4: The desktop cookie store

**Files:**
- Create: `apps/desktop/src/main/cookie-store.ts`
- Test: `apps/desktop/test/cookie-store.test.ts` (create)

**Interfaces:**
- Consumes: `CookieJar`, `CookieJarHost`, `CookieKey`, `StoredCookie` (Task 1); `CryptoBackend` (`main/secrets.ts`).
- Produces:
  - `COOKIES_DIR = 'cookies'` and `COOKIE_FILE_VERSION = 1`
  - `interface CookieJarState { readonly cookies: StoredCookie[]; readonly persisted: boolean }`
  - `interface CookieStoreOptions { userDataDir: string; crypto: CryptoBackend; onChanged?: (state: CookieJarState) => void; debounceMs?: number; now?: () => number; warn?: (message: string) => void }`
  - `class CookieStore`:
    - `constructor(options: CookieStoreOptions)`
    - `switchTo(workspaceId: string | null): Promise<void>`
    - `host(): CookieJarHost`
    - `state(): CookieJarState`
    - `set(cookie: StoredCookie, replaces?: CookieKey): CookieJarState`
    - `remove(key: CookieKey): CookieJarState`
    - `removeDomain(domain: string): CookieJarState`
    - `clear(): CookieJarState`
    - `flush(): Promise<void>`
    - `deleteWorkspace(workspaceId: string): Promise<void>`

- [ ] **Step 1: Write the failing tests.** Create `apps/desktop/test/cookie-store.test.ts`:

```ts
// @vitest-environment node
/**
 * The workspace cookie jars (cookie jar spec §2.1). What matters most is what reaches disk: only
 * cookies with an expiry, only encrypted, never without secure storage, and never over a file a
 * newer build wrote.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cookie } from '@wirebench/engine';
import { COOKIES_DIR, CookieStore, type CookieJarState, type CookieStoreOptions } from '../src/main/cookie-store.js';
import type { CryptoBackend } from '../src/main/secrets.js';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const VALUE = 'cookie-value-that-must-not-leak';
const LOGIN: Cookie[] = [
  { name: 'sid', value: VALUE, path: '/', maxAge: 3600 },
  { name: 'tmp', value: 'session-only', path: '/' },
];

/** Encrypts by prefixing, so a test can read what was "encrypted" and spot a file it did not write. */
function fakeCrypto(available = true): CryptoBackend {
  return {
    available,
    encrypt: (text) => Buffer.from(`enc:${text}`, 'utf8'),
    decrypt: (buffer) => {
      const text = buffer.toString('utf8');
      if (!text.startsWith('enc:')) {
        throw new Error('not ours');
      }
      return text.slice('enc:'.length);
    },
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-cookie-store-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function store(extra: Partial<CookieStoreOptions> = {}): CookieStore {
  return new CookieStore({ userDataDir: dir, crypto: fakeCrypto(), now: () => NOW, debounceMs: 60_000, ...extra });
}

function fileOf(id: string): string {
  return join(dir, COOKIES_DIR, `${id}.json`);
}

function names(state: CookieJarState): string[] {
  return state.cookies.map((cookie) => cookie.name);
}

describe('CookieStore — what reaches disk', () => {
  it('saves only cookies with an expiry, encrypted, and reads them back', async () => {
    const first = store();
    await first.switchTo('w1');
    first.host().remember('https://api.test/login', LOGIN);
    await first.flush();

    const raw = readFileSync(fileOf('w1'), 'utf8');
    expect(raw).not.toContain(VALUE);
    const file = JSON.parse(raw) as { version: number; data: string };
    expect(file.version).toBe(1);
    const saved = JSON.parse(Buffer.from(file.data, 'base64').toString('utf8').slice('enc:'.length)) as Cookie[];
    expect(saved.map((cookie) => cookie.name)).toEqual(['sid']);

    const second = store();
    await second.switchTo('w1');
    expect(second.state()).toEqual({
      cookies: [expect.objectContaining({ name: 'sid', value: VALUE, expiresAt: NOW + 3_600_000 })],
      persisted: true,
    });
  });

  it('writes nothing for a change to session cookies alone', async () => {
    const s = store();
    await s.switchTo('w1');
    s.host().remember('https://api.test/', [{ name: 'tmp', value: '1', path: '/' }]);
    await s.flush();
    expect(existsSync(fileOf('w1'))).toBe(false);
  });

  it('writes nothing without secure storage, and says so', async () => {
    const s = store({ crypto: fakeCrypto(false) });
    await s.switchTo('w1');
    s.host().remember('https://api.test/login', LOGIN);
    await s.flush();
    expect(existsSync(fileOf('w1'))).toBe(false);
    expect(s.state().persisted).toBe(false);
    expect(names(s.state())).toEqual(['sid', 'tmp']);
  });

  it('refuses a file a newer build wrote: session only, a warning, and the file left alone', async () => {
    mkdirSync(join(dir, COOKIES_DIR), { recursive: true });
    const newer = JSON.stringify({ version: 2, data: 'opaque' });
    writeFileSync(fileOf('w1'), newer);
    const warn = vi.fn();
    const s = store({ warn });
    await s.switchTo('w1');
    expect(s.state()).toEqual({ cookies: [], persisted: false });
    expect(warn).toHaveBeenCalledOnce();
    s.host().remember('https://api.test/login', LOGIN);
    await s.flush();
    expect(readFileSync(fileOf('w1'), 'utf8')).toBe(newer);
  });

  it.each([
    ['not JSON', 'not json'],
    ['not decryptable', JSON.stringify({ version: 1, data: Buffer.from('garbage').toString('base64') })],
    ['not a cookie list', JSON.stringify({ version: 1, data: Buffer.from('enc:{"a":1}').toString('base64') })],
  ])('sets a file that is %s aside as .corrupt and starts empty', async (_label, text) => {
    mkdirSync(join(dir, COOKIES_DIR), { recursive: true });
    writeFileSync(fileOf('w1'), text);
    const s = store({ warn: vi.fn() });
    await s.switchTo('w1');
    expect(s.state()).toEqual({ cookies: [], persisted: true });
    expect(existsSync(fileOf('w1'))).toBe(false);
    expect(readFileSync(`${fileOf('w1')}.corrupt`, 'utf8')).toBe(text);
  });

  it('drops cookies that expired while the file sat on disk', async () => {
    const first = store();
    await first.switchTo('w1');
    first.host().remember('https://api.test/', [{ name: 'short', value: '1', path: '/', maxAge: 60 }]);
    await first.flush();
    const later = store({ now: () => NOW + 61_000 });
    await later.switchTo('w1');
    expect(later.state().cookies).toEqual([]);
  });
});

describe('CookieStore — when it writes', () => {
  it('debounces a write, and a flush (as on quit) writes at once', async () => {
    const s = store();
    await s.switchTo('w1');
    s.host().remember('https://api.test/login', LOGIN);
    expect(existsSync(fileOf('w1'))).toBe(false);
    await s.flush();
    expect(existsSync(fileOf('w1'))).toBe(true);
  });

  it('writes on its own once the debounce ends', async () => {
    const s = store({ debounceMs: 10 });
    await s.switchTo('w1');
    s.host().remember('https://api.test/login', LOGIN);
    await vi.waitFor(() => {
      expect(existsSync(fileOf('w1'))).toBe(true);
    });
  });

  it('keeps one jar per workspace, and flushes the one it leaves', async () => {
    const s = store();
    await s.switchTo('w1');
    s.host().remember('https://api.test/login', LOGIN);
    await s.switchTo('w2');
    expect(existsSync(fileOf('w1'))).toBe(true);
    expect(s.state().cookies).toEqual([]);
    await s.switchTo('w1');
    // The session cookie stayed in memory: switching back restores the whole jar.
    expect(names(s.state())).toEqual(['sid', 'tmp']);
  });

  it('keeps the jar of no workspace in memory only', async () => {
    const s = store();
    await s.switchTo(null);
    s.host().remember('https://api.test/login', LOGIN);
    await s.flush();
    expect(existsSync(join(dir, COOKIES_DIR))).toBe(false);
    expect(s.state().persisted).toBe(false);
  });

  it('deletes a workspace file and jar with the workspace', async () => {
    const s = store();
    await s.switchTo('w1');
    s.host().remember('https://api.test/login', LOGIN);
    await s.flush();
    await s.deleteWorkspace('w1');
    expect(existsSync(fileOf('w1'))).toBe(false);
    expect(s.state()).toEqual({ cookies: [], persisted: false });
  });
});

describe('CookieStore — edits', () => {
  it('answers every edit with the whole jar, and announces each change', async () => {
    const changes: CookieJarState[] = [];
    const s = store({ onChanged: (state) => changes.push(state) });
    await s.switchTo('w1');
    s.host().remember('https://api.test/login', LOGIN);
    const sid = s.state().cookies[0]!;

    const moved = s.set({ ...sid, path: '/v2' }, { name: 'sid', domain: 'api.test', path: '/' });
    expect(moved.cookies.map((cookie) => `${cookie.name}@${cookie.path}`)).toEqual(['sid@/v2', 'tmp@/']);
    expect(names(s.remove({ name: 'tmp', domain: 'api.test', path: '/' }))).toEqual(['sid']);
    s.host().remember('https://other.test/', [{ name: 'o', value: '1', path: '/' }]);
    expect(s.removeDomain('other.test').cookies.map((cookie) => cookie.domain)).toEqual(['api.test']);
    expect(s.clear()).toEqual({ cookies: [], persisted: true });

    expect(changes.length).toBeGreaterThanOrEqual(6);
    expect(changes.at(-1)).toEqual({ cookies: [], persisted: true });
  });
});
```

- [ ] **Step 2: Run to see it fail.** `pnpm vitest run apps/desktop/test/cookie-store.test.ts` → FAIL (`cookie-store.js` does not exist).

- [ ] **Step 3: Implement.** Create `apps/desktop/src/main/cookie-store.ts`:

```ts
/**
 * The workspace cookie jars (cookie jar spec §2): one engine `CookieJar` per workspace id, the open
 * workspace's backing every desktop send.
 *
 * Only cookies with an expiry are saved, encrypted as one blob through the OS keychain
 * (`safeStorage`, the backend `secrets.ts` uses), to `<userData>/cookies/<workspaceId>.json`.
 * Session cookies never reach disk. With no secure storage nothing does: cookies are never written
 * in plain text. Writes are atomic and debounced, and are flushed on a workspace switch and on quit.
 * A file from a newer build is left alone, and an unreadable one is set aside as `.corrupt`.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CookieJar } from '@wirebench/engine';
import type { CookieJarHost, CookieKey, StoredCookie } from '@wirebench/engine';
import type { CryptoBackend } from './secrets.js';

/** The folder under `userData` the cookie files live in. */
export const COOKIES_DIR = 'cookies';
/** The cookie file format this build writes and reads. */
export const COOKIE_FILE_VERSION = 1;
const DEFAULT_DEBOUNCE_MS = 1000;
/** The jar sends use while no workspace is open: session only, never saved. */
const NO_WORKSPACE = '';
/** A workspace id becomes a file name here; anything else stays session only. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** What `cookies.*` answers and `cookies.changed` carries (spec §2.2). */
export interface CookieJarState {
  readonly cookies: StoredCookie[];
  /** False when nothing is saved: no secure storage, no workspace, or a file this build may not read. */
  readonly persisted: boolean;
}

export interface CookieStoreOptions {
  /** Electron's `userData`: the files go under `cookies/`. */
  readonly userDataDir: string;
  readonly crypto: CryptoBackend;
  /** Called with the open workspace's jar after every change to it. */
  readonly onChanged?: (state: CookieJarState) => void;
  /** Test-only; 1 s by default. */
  readonly debounceMs?: number;
  /** Test-only clock, in epoch ms. */
  readonly now?: () => number;
  readonly warn?: (message: string) => void;
}

interface Entry {
  readonly jar: CookieJar;
  /** False for the no-workspace jar and for a file this build may not read: nothing is written. */
  readonly persistable: boolean;
  /** The JSON of the persistent cookies as last written or read, so a session-only change writes nothing. */
  saved: string;
  timer?: ReturnType<typeof setTimeout>;
}

function sessionOnly(): Entry {
  return { jar: new CookieJar(), persistable: false, saved: '[]' };
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';
}

function isStoredCookie(value: unknown): value is StoredCookie {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const cookie = value as Record<string, unknown>;
  const sameSite = cookie['sameSite'];
  const expiresAt = cookie['expiresAt'];
  return (
    typeof cookie['name'] === 'string' &&
    typeof cookie['value'] === 'string' &&
    typeof cookie['domain'] === 'string' &&
    typeof cookie['hostOnly'] === 'boolean' &&
    typeof cookie['path'] === 'string' &&
    typeof cookie['secure'] === 'boolean' &&
    typeof cookie['httpOnly'] === 'boolean' &&
    typeof cookie['createdAt'] === 'number' &&
    (expiresAt === undefined || typeof expiresAt === 'number') &&
    (sameSite === undefined || sameSite === 'Strict' || sameSite === 'Lax' || sameSite === 'None')
  );
}

/** The decrypted list, or a throw when it is not one. */
function parseCookies(text: string): StoredCookie[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value)) {
    throw new Error('not a cookie list');
  }
  const list: unknown[] = value;
  if (!list.every(isStoredCookie)) {
    throw new Error('not a cookie list');
  }
  return list;
}

/** Temp file then rename, as `global-properties.ts` writes. */
async function writeAtomic(path: string, data: string): Promise<void> {
  const temp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(temp, data, 'utf8');
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export class CookieStore {
  private readonly entries = new Map<string, Entry>();
  private currentId = NO_WORKSPACE;
  /** Switches run one after another, so a load never races the flush before it. */
  private switching: Promise<void> = Promise.resolve();

  constructor(private readonly options: CookieStoreOptions) {
    this.entries.set(NO_WORKSPACE, sessionOnly());
  }

  /**
   * Makes `workspaceId`'s jar the one sends use (`null`: no workspace), reading its file the first
   * time and flushing the jar it leaves. A workspace's jar stays in memory across switches.
   */
  switchTo(workspaceId: string | null): Promise<void> {
    const next = this.switching.then(async () => {
      const id = workspaceId ?? NO_WORKSPACE;
      if (id === this.currentId) {
        return;
      }
      await this.flushEntry(this.currentId);
      if (!this.entries.has(id)) {
        this.entries.set(id, await this.load(id));
      }
      this.currentId = id;
      this.announce();
    });
    this.switching = next.catch(() => undefined);
    return next;
  }

  /** What `SendHost.cookies` is: the jar of whichever workspace is open when a send reads or stores. */
  host(): CookieJarHost {
    return {
      cookiesFor: (url) => this.current().jar.cookiesFor(url, this.now()),
      remember: (url, cookies) => {
        const id = this.currentId;
        const verdicts = this.current().jar.store(url, cookies, this.now());
        if (cookies.length > 0) {
          this.changed(id);
        }
        return verdicts;
      },
    };
  }

  state(): CookieJarState {
    const entry = this.current();
    return {
      cookies: entry.jar.list(this.now()),
      persisted: entry.persistable && this.options.crypto.available,
    };
  }

  /** Stores `cookie`, first removing `replaces` when its identity changed (spec §3). */
  set(cookie: StoredCookie, replaces?: CookieKey): CookieJarState {
    const { jar } = this.current();
    if (replaces !== undefined) {
      jar.remove(replaces);
    }
    jar.set(cookie);
    return this.changed(this.currentId);
  }

  remove(key: CookieKey): CookieJarState {
    this.current().jar.remove(key);
    return this.changed(this.currentId);
  }

  removeDomain(domain: string): CookieJarState {
    this.current().jar.removeDomain(domain);
    return this.changed(this.currentId);
  }

  clear(): CookieJarState {
    this.current().jar.clear();
    return this.changed(this.currentId);
  }

  /** Writes every pending change now. Called on quit. */
  async flush(): Promise<void> {
    await this.switching;
    for (const id of [...this.entries.keys()]) {
      await this.flushEntry(id);
    }
  }

  /** Forgets a deleted workspace's jar and deletes its file. */
  async deleteWorkspace(workspaceId: string): Promise<void> {
    await this.switching;
    const entry = this.entries.get(workspaceId);
    if (entry?.timer !== undefined) {
      clearTimeout(entry.timer);
    }
    this.entries.delete(workspaceId);
    if (workspaceId === this.currentId) {
      this.currentId = NO_WORKSPACE;
      this.announce();
    }
    if (SAFE_ID.test(workspaceId)) {
      await rm(this.fileOf(workspaceId), { force: true });
    }
  }

  private current(): Entry {
    const entry = this.entries.get(this.currentId);
    if (entry !== undefined) {
      return entry;
    }
    const fresh = sessionOnly();
    this.entries.set(this.currentId, fresh);
    return fresh;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private get dir(): string {
    return join(this.options.userDataDir, COOKIES_DIR);
  }

  private fileOf(workspaceId: string): string {
    return join(this.dir, `${workspaceId}.json`);
  }

  private warn(message: string): void {
    this.options.warn?.(message);
  }

  private announce(): CookieJarState {
    const state = this.state();
    this.options.onChanged?.(state);
    return state;
  }

  /** After any change to `id`'s jar: announce it if open, and schedule a write when what is saved changed. */
  private changed(id: string): CookieJarState {
    const entry = this.entries.get(id);
    if (entry !== undefined && entry.persistable && this.options.crypto.available) {
      if (JSON.stringify(entry.jar.persistent(this.now())) !== entry.saved) {
        if (entry.timer !== undefined) {
          clearTimeout(entry.timer);
        }
        entry.timer = setTimeout(() => {
          this.flushEntry(id).catch((error: unknown) => {
            this.warn(`Saving the cookies failed: ${error instanceof Error ? error.message : String(error)}`);
          });
        }, this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
      }
    }
    return id === this.currentId ? this.announce() : this.state();
  }

  private async flushEntry(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (entry === undefined) {
      return;
    }
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
      delete entry.timer;
    }
    if (!entry.persistable || !this.options.crypto.available) {
      return;
    }
    const json = JSON.stringify(entry.jar.persistent(this.now()));
    if (json === entry.saved) {
      return;
    }
    await mkdir(this.dir, { recursive: true });
    const data = this.options.crypto.encrypt(json).toString('base64');
    await writeAtomic(this.fileOf(id), JSON.stringify({ version: COOKIE_FILE_VERSION, data }));
    entry.saved = json;
  }

  private async load(id: string): Promise<Entry> {
    if (!SAFE_ID.test(id)) {
      return sessionOnly();
    }
    let text: string;
    try {
      text = await readFile(this.fileOf(id), 'utf8');
    } catch (error) {
      return isMissing(error) ? { jar: new CookieJar(), persistable: true, saved: '[]' } : await this.setAside(id);
    }
    let file: unknown;
    try {
      file = JSON.parse(text);
    } catch {
      return await this.setAside(id);
    }
    const { version, data } = (typeof file === 'object' && file !== null ? file : {}) as Record<string, unknown>;
    if (typeof version !== 'number' || typeof data !== 'string') {
      return await this.setAside(id);
    }
    if (version > COOKIE_FILE_VERSION) {
      this.warn(`The cookies of workspace ${id} were saved by a newer Wirebench; they are kept for this session only.`);
      return sessionOnly();
    }
    if (!this.options.crypto.available) {
      // The file may be perfectly good; without the keychain it can only be left alone.
      return sessionOnly();
    }
    let cookies: StoredCookie[];
    try {
      cookies = parseCookies(this.options.crypto.decrypt(Buffer.from(data, 'base64')));
    } catch {
      return await this.setAside(id);
    }
    const jar = new CookieJar(cookies);
    return { jar, persistable: true, saved: JSON.stringify(jar.persistent(this.now())) };
  }

  /** Renames an unreadable file to `<id>.json.corrupt` and starts that workspace empty. */
  private async setAside(id: string): Promise<Entry> {
    const file = this.fileOf(id);
    this.warn(`The cookies of workspace ${id} could not be read; the file was set aside as ${id}.json.corrupt.`);
    await rename(file, `${file}.corrupt`).catch(() => undefined);
    return { jar: new CookieJar(), persistable: true, saved: '[]' };
  }
}
```

- [ ] **Step 4: Run to see it pass.** `pnpm vitest run apps/desktop/test/cookie-store.test.ts` → PASS.

- [ ] **Step 5: Gate and commit.**

```bash
WIREBENCH_SKIP_PERF=1 pnpm check
git add apps/desktop/src/main/cookie-store.ts apps/desktop/test/cookie-store.test.ts
git commit -m "feat(desktop): a cookie jar per workspace, saved encrypted or not at all (#44)"
```

### Task 5: The desktop jar on the wire: IPC, sends and verdicts

**Files:**
- Modify: `apps/desktop/src/shared/wire-types.ts` (around `cookieWireSchema`, ~line 1978)
- Modify: `apps/desktop/src/shared/ipc.ts` (schema imports; channel group after `globals` ~line 865; event group after `globals` ~line 1138)
- Create: `apps/desktop/src/main/ipc/cookies.ts`
- Modify: `apps/desktop/src/main/engine-wire.ts` (`toRestExchangeSummary`, line 363)
- Modify: `apps/desktop/src/main/send/host.ts` (`DesktopSendDeps`, `desktopSendHost`, header comment)
- Modify: `apps/desktop/src/main/ipc/request.ts` (`RequestChannelProject` picks ~lines 122 and 129; `RequestChannelDeps`; `toSendDeps`)
- Modify: `apps/desktop/src/main/project-host.ts` (remove `Cookie` import line 122, `restCookies` ~lines 410–416, `restCookiesFor`/`rememberRestCookies` ~lines 1590–1605)
- Modify: `apps/desktop/src/main/project-router.ts` (remove lines 123–124 and 132–135)
- Modify: `apps/desktop/src/main/workspace-service.ts` (remove the two delegations ~lines 2980–3002; `WorkspaceHooks.onDeleted`; `delete`)
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/test/mocks/wirebench-api.ts`
- Test: `apps/desktop/test/ipc-cookies.test.ts` (create); `apps/desktop/test/engine-wire.test.ts`; `apps/desktop/test/send-host.test.ts`; `apps/desktop/test/workspace-service.test.ts`; `apps/desktop/test/project-host-env.test.ts` (remove one test)

**Interfaces:**
- Consumes: `CookieStore`, `CookieJarState` (Task 4); `RestExchange.cookieVerdicts` (Task 2).
- Produces:
  - Wire schemas: `cookieJarVerdictWireSchema`; `cookieWireSchema.jar?`; `storedCookieWireSchema` / `StoredCookieWire`; `cookieKeyWireSchema` / `CookieKeyWire`; `cookieJarStateWireSchema` / `CookieJarStateWire`; `cookiesSetRequestSchema`, `cookiesRemoveRequestSchema`, `cookiesRemoveDomainRequestSchema`
  - Channels `cookies.list` / `set` / `remove` / `removeDomain` / `clear`, and the event `cookies.changed`
  - `toStoredCookie(wire: StoredCookieWire): StoredCookie`; `registerCookiesChannels(store)` (`main/ipc/cookies.ts`)
  - `DesktopSendDeps.cookies?: CookieJarHost`; `RequestChannelDeps.cookies?: CookieJarHost`; `WorkspaceHooks.onDeleted?: (workspaceId: string) => void`

- [ ] **Step 1: Write the failing tests.**
  - Create `apps/desktop/test/ipc-cookies.test.ts`:

```ts
// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CookieStore } from '../src/main/cookie-store.js';
import { registerCookiesChannels } from '../src/main/ipc/cookies.js';
import { channels } from '../src/shared/ipc.js';
import type { CookieJarStateWire } from '../src/shared/wire-types.js';

const registeredHandlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      registeredHandlers.set(name, handler);
    },
  },
}));

const NOW = Date.parse('2026-10-03T12:00:00Z');
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-ipc-cookies-'));
  registeredHandlers.clear();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Result = { ok: boolean; value?: CookieJarStateWire };

function invoke(channelName: string, payload?: unknown): Promise<Result> {
  const handler = registeredHandlers.get(channelName);
  if (handler === undefined) {
    throw new Error(`${channelName} was never registered`);
  }
  return handler({ sender: {} }, payload) as Promise<Result>;
}

function names(result: Result): string[] {
  return (result.value?.cookies ?? []).map((cookie) => cookie.name);
}

function newStore(): CookieStore {
  const crypto = { available: false, encrypt: () => Buffer.from(''), decrypt: () => '' };
  return new CookieStore({ userDataDir: dir, crypto, now: () => NOW });
}

describe('registerCookiesChannels', () => {
  it('answers every channel with the whole jar', async () => {
    const store = newStore();
    registerCookiesChannels(store);
    store.host().remember('https://api.test/', [
      { name: 'a', value: '1', path: '/' },
      { name: 'b', value: '2', path: '/' },
    ]);

    const listed = await invoke(channels.cookies.list.name, undefined);
    expect(listed.ok).toBe(true);
    expect(names(listed)).toEqual(['a', 'b']);
    expect(listed.value?.persisted).toBe(false);

    const a = listed.value!.cookies[0]!;
    const renamed = await invoke(channels.cookies.set.name, {
      cookie: { ...a, name: 'renamed' },
      replaces: { name: 'a', domain: 'api.test', path: '/' },
    });
    expect(names(renamed)).toEqual(['b', 'renamed']);
    expect(names(await invoke(channels.cookies.remove.name, { key: { name: 'b', domain: 'api.test', path: '/' } }))).toEqual([
      'renamed',
    ]);
    expect(names(await invoke(channels.cookies.removeDomain.name, { domain: 'api.test' }))).toEqual([]);
    store.host().remember('https://api.test/', [{ name: 'c', value: '3', path: '/' }]);
    expect(names(await invoke(channels.cookies.clear.name, undefined))).toEqual([]);
  });

  it('refuses something that is not a cookie', async () => {
    registerCookiesChannels(newStore());
    expect((await invoke(channels.cookies.set.name, { cookie: { name: 'x' } })).ok).toBe(false);
  });
});
```

  - In `apps/desktop/test/engine-wire.test.ts`, add at the end:

```ts
describe('toRestExchangeSummary — the cookie jar verdicts', () => {
  function withCookies(extra: Record<string, unknown>): RestExchange {
    return {
      status: 200,
      statusText: 'OK',
      headers: {},
      rawHeaders: [],
      body: new Uint8Array(),
      rawBody: new Uint8Array(),
      rawRequest: Buffer.from('GET / HTTP/1.1\r\nHost: example.test\r\n\r\n', 'latin1'),
      rawResponse: Buffer.from('HTTP/1.1 200 OK\r\n\r\n', 'latin1'),
      truncated: false,
      httpVersion: '1.1',
      timings: {},
      redirects: [],
      request: { url: 'http://example.test/', method: 'GET', headers: {} },
      text: '',
      language: 'text',
      cookies: [
        { name: 'sid', value: '1' },
        { name: 'far', value: '2', domain: 'other.test' },
      ],
      methodChanged: false,
      ...extra,
    } as unknown as RestExchange;
  }

  it("marks each cookie with the jar's verdict", () => {
    const summary = toRestExchangeSummary(
      withCookies({ cookieVerdicts: [{ stored: true }, { stored: false, reason: 'domain-mismatch' }] }),
      's1',
      { method: 'GET' },
    );
    expect(summary.cookies.map((cookie) => cookie.jar)).toEqual([
      { stored: true },
      { stored: false, reason: 'domain-mismatch' },
    ]);
  });

  it('marks nothing when the send had no jar', () => {
    const summary = toRestExchangeSummary(withCookies({}), 's1', { method: 'GET' });
    expect(summary.cookies.map((cookie) => cookie.jar)).toEqual([undefined, undefined]);
  });
});
```

  - In `apps/desktop/test/send-host.test.ts`, add `CookieJar` and `jarCookieHost` to the `@wirebench/engine` import, and add after the test that checks the client identity:

```ts
  it('lends the workspace cookie jar', async () => {
    const cookies = jarCookieHost(new CookieJar());
    const host = await desktopSendHost(deps({ cookies }), send);
    expect(host.cookies).toBe(cookies);
  });
```

  - In `apps/desktop/test/workspace-service.test.ts`, after the test `'deletes through the injected trash and drops the workspace from the list'`, add:

```ts
  it('tells the hooks a workspace was deleted, so what main keeps for it goes too', async () => {
    const deleted: string[] = [];
    const service = newService({
      trash: (path) => {
        rmSync(path, { recursive: true, force: true });
        return Promise.resolve();
      },
      hooks: {
        onDeleted: (workspaceId) => {
          deleted.push(workspaceId);
        },
      },
    });
    const created = await service.create('Doomed');
    await service.delete(created.id);
    expect(deleted).toEqual([created.id]);
  }, 60_000);
```

  - In `apps/desktop/test/project-host-env.test.ts`, delete the test `it("hands back a request's stored cookies whatever its send-cookies setting", …)`.

- [ ] **Step 2: Run to see it fail.**

```bash
pnpm vitest run apps/desktop/test/ipc-cookies.test.ts apps/desktop/test/engine-wire.test.ts apps/desktop/test/send-host.test.ts apps/desktop/test/workspace-service.test.ts
```

  Expected: FAIL. `ipc/cookies.js` does not exist, `jar` is not on the cookie wire, `cookies` is not a send dependency, and `onDeleted` is never called.

- [ ] **Step 3: Wire schemas.** In `apps/desktop/src/shared/wire-types.ts`, replace:

```ts
/** One cookie a response set, as the Cookies tab shows it. */
export const cookieWireSchema = z.object({
```

  with:

```ts
/** The jar's verdict on one cookie a response set (cookie jar spec §3). */
export const cookieJarVerdictWireSchema = z.object({
  stored: z.boolean(),
  reason: z
    .enum(['deleted', 'domain-mismatch', 'domain-not-allowed', 'secure-over-http', 'too-large', 'malformed'])
    .optional(),
});
export type CookieJarVerdictWire = z.infer<typeof cookieJarVerdictWireSchema>;

/** One cookie a response set, as the Cookies tab shows it. */
export const cookieWireSchema = z.object({
```

  In `cookieWireSchema`, after `malformed: z.boolean().optional(),` add:

```ts
  /** What the cookie jar did with it; absent when the send had no jar. */
  jar: cookieJarVerdictWireSchema.optional(),
```

  After `export type CookieWire = z.infer<typeof cookieWireSchema>;` add:

```ts
/**
 * One cookie of the workspace jar (cookie jar spec §2.2), as the manager shows and edits it. A leaf
 * schema mirroring the engine's `StoredCookie`; nothing here imports the engine.
 */
export const storedCookieWireSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
  domain: z.string().min(1),
  hostOnly: z.boolean(),
  path: z.string().min(1),
  expiresAt: z.number().optional(),
  secure: z.boolean(),
  httpOnly: z.boolean(),
  sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
  createdAt: z.number(),
});
export type StoredCookieWire = z.infer<typeof storedCookieWireSchema>;

/** What names one jar cookie. */
export const cookieKeyWireSchema = z.object({ name: z.string(), domain: z.string(), path: z.string() });
export type CookieKeyWire = z.infer<typeof cookieKeyWireSchema>;

/** The whole jar of the open workspace; `persisted` is false when nothing is saved. */
export const cookieJarStateWireSchema = z.object({
  cookies: z.array(storedCookieWireSchema),
  persisted: z.boolean(),
});
export type CookieJarStateWire = z.infer<typeof cookieJarStateWireSchema>;

export const cookiesSetRequestSchema = z.object({
  cookie: storedCookieWireSchema,
  /** The cookie this one replaces, when its name, domain or path changed. */
  replaces: cookieKeyWireSchema.optional(),
});
export const cookiesRemoveRequestSchema = z.object({ key: cookieKeyWireSchema });
export const cookiesRemoveDomainRequestSchema = z.object({ domain: z.string().min(1) });
```

- [ ] **Step 4: Channels and event.** In `apps/desktop/src/shared/ipc.ts`, add `cookieJarStateWireSchema`, `cookiesRemoveDomainRequestSchema`, `cookiesRemoveRequestSchema` and `cookiesSetRequestSchema` to the import list from `'./wire-types.js'`. After the channels' `globals: { … },` group add:

```ts
  /** The open workspace's cookie jar (cookie jar spec §2.2). Every channel answers with the whole jar. */
  cookies: {
    list: defineChannel('cookies.list', z.undefined(), cookieJarStateWireSchema),
    set: defineChannel('cookies.set', cookiesSetRequestSchema, cookieJarStateWireSchema),
    remove: defineChannel('cookies.remove', cookiesRemoveRequestSchema, cookieJarStateWireSchema),
    removeDomain: defineChannel('cookies.removeDomain', cookiesRemoveDomainRequestSchema, cookieJarStateWireSchema),
    clear: defineChannel('cookies.clear', z.undefined(), cookieJarStateWireSchema),
  },
```

  After the events' `globals: { changed: … },` group add:

```ts
  cookies: {
    /** The open workspace's jar changed: a send stored cookies, the manager edited, or the workspace switched. */
    changed: defineEvent('cookies.changed', cookieJarStateWireSchema),
  },
```

- [ ] **Step 5: The handlers.** Create `apps/desktop/src/main/ipc/cookies.ts`:

```ts
import type { StoredCookie } from '@wirebench/engine';
import { channels } from '../../shared/ipc.js';
import type { StoredCookieWire } from '../../shared/wire-types.js';
import type { CookieStore } from '../cookie-store.js';
import { registerHandler } from './register.js';

/** A wire cookie as the engine's type: zod's optional keys may hold `undefined`, the engine's may not. */
export function toStoredCookie(wire: StoredCookieWire): StoredCookie {
  const { expiresAt, sameSite, ...rest } = wire;
  return {
    ...rest,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(sameSite !== undefined ? { sameSite } : {}),
  };
}

/**
 * Registers the `cookies.*` channels (cookie jar spec §2.2). Each answers with the whole jar, so the
 * renderer merges nothing; `cookies.changed` comes from the store itself, after every change.
 */
export function registerCookiesChannels(
  store: Pick<CookieStore, 'state' | 'set' | 'remove' | 'removeDomain' | 'clear'>,
): void {
  registerHandler(channels.cookies.list, () => Promise.resolve(store.state()));
  registerHandler(channels.cookies.set, (request) =>
    Promise.resolve(store.set(toStoredCookie(request.cookie), request.replaces)),
  );
  registerHandler(channels.cookies.remove, (request) => Promise.resolve(store.remove(request.key)));
  registerHandler(channels.cookies.removeDomain, (request) => Promise.resolve(store.removeDomain(request.domain)));
  registerHandler(channels.cookies.clear, () => Promise.resolve(store.clear()));
}
```

- [ ] **Step 6: The verdicts on the exchange wire.** In `apps/desktop/src/main/engine-wire.ts`, replace `cookies: exchange.cookies.map((cookie) => ({ ...cookie })),` with:

```ts
    cookies: exchange.cookies.map((cookie, index) => {
      const verdict = exchange.cookieVerdicts?.[index];
      return { ...cookie, ...(verdict !== undefined ? { jar: { ...verdict } } : {}) };
    }),
```

- [ ] **Step 7: The jar reaches every send.**
  - `apps/desktop/src/main/send/host.ts`:
    - Add `CookieJarHost` to the type import from `'@wirebench/engine'`.
    - In `DesktopSendDeps`, after `onExchange`, add:

```ts
  /** The open workspace's cookie jar (cookie jar spec §2); absent in tests that never send cookies. */
  readonly cookies?: CookieJarHost;
```

    - In the object `desktopSendHost` returns, after the `...(preferences !== undefined ? { preferences } : {}),` line, add `...(deps.cookies !== undefined ? { cookies: deps.cookies } : {}),`.
    - In the header comment, replace `the per-request` + newline + ` * cookies,` with `the workspace` + newline + ` * cookie jar,`.
  - `apps/desktop/src/main/ipc/request.ts`:
    - Remove `| 'rememberRestCookies'` and `| 'restCookiesFor'` from `RequestChannelProject`'s `Pick`, and `the stored cookies, ` from the comment above them.
    - Add `import type { CookieJarHost } from '@wirebench/engine';` (or extend the existing type import).
    - In `RequestChannelDeps`, after `showSecrets`, add:

```ts
  /** The open workspace's cookie jar, lent to every REST send (cookie jar spec §2). */
  readonly cookies?: CookieJarHost;
```

    - In `toSendDeps`, after the `showSecrets` line, add `...(deps.cookies !== undefined ? { cookies: deps.cookies } : {}),`.
  - `apps/desktop/src/main/project-host.ts`: delete `Cookie,` from the engine type import (line 122), the `restCookies` field with its doc comment (~lines 410–416), and the methods `restCookiesFor` and `rememberRestCookies` with their doc comments (~lines 1590–1605).
  - `apps/desktop/src/main/project-router.ts`: delete the `restCookiesFor(…)` declaration with its doc comment (lines 123–124) and the `rememberRestCookies(…)` declaration with its doc comment (lines 132–135).
  - `apps/desktop/src/main/workspace-service.ts`: delete the `restCookiesFor` and `rememberRestCookies` delegations with their `/** @inheritdoc */` lines.

- [ ] **Step 8: `onDeleted`.** In `apps/desktop/src/main/workspace-service.ts`, add to `WorkspaceHooks` after `onChanged`:

```ts
  /** A workspace was deleted: what main keeps for it outside its folder (its cookies, its current values) goes too. */
  readonly onDeleted?: (workspaceId: string) => void;
```

  In `delete(id)`, between `await this.state.forget(id);` and `return await this.list();`, add `this.deps.hooks?.onDeleted?.(id);`.

- [ ] **Step 9: `index.ts`.** In `apps/desktop/src/main/index.ts`:
  - Add the imports `import { CookieStore } from './cookie-store.js';` and `import { registerCookiesChannels } from './ipc/cookies.js';`.
  - After `const globalProperties = new GlobalProperties(app.getPath('userData'));` add:

```ts
/**
 * The workspace cookie jars (cookie jar spec §2): saved encrypted with the keychain, or not at all.
 * Every change to the open workspace's jar reaches the renderer as `cookies.changed`.
 */
const cookieStore = new CookieStore({
  userDataDir: app.getPath('userData'),
  crypto: safeStorageBackend(safeStorage),
  onChanged: (state) => {
    broadcast(events.cookies.changed, state);
  },
  warn: (message) => {
    console.warn(`[cookies] ${message}`);
  },
});
```

  - In the `WorkspaceService` hooks:
    - Inside `onChanged: (workspace) => { … }`, after `applyWindowTitle(workspace);`, add:

```ts
      void cookieStore.switchTo(workspace?.id ?? null).catch((error: unknown) => {
        console.warn('[cookies] switching jars failed', error instanceof Error ? error.message : String(error));
      });
```

    - Add a hook after `onChanged`:

```ts
    onDeleted: (workspaceId) => {
      void cookieStore.deleteWorkspace(workspaceId).catch(() => undefined);
    },
```

  - In `requestDeps`, after `showSecrets: showSecretsFlag,`, add `cookies: cookieStore.host(),`.
  - After `registerGlobalsChannels(globalProperties, …);`, add `registerCookiesChannels(cookieStore);`.
  - In the `before-quit` handler, change `await workspaceService.close();` to:

```ts
      await workspaceService.close();
      // Cookies with an expiry still waiting on the debounce are written before the app goes.
      await cookieStore.flush();
```

- [ ] **Step 10: Test API defaults.** In `apps/desktop/test/mocks/wirebench-api.ts`, add to `defaults`, after the `globals: { … },` entry:

```ts
    cookies: {
      list: vi.fn().mockResolvedValue({ ok: true, value: { cookies: [], persisted: true } }),
      set: fail('cookies.set'),
      remove: fail('cookies.remove'),
      removeDomain: fail('cookies.removeDomain'),
      clear: fail('cookies.clear'),
    },
```

- [ ] **Step 11: Run to see it pass.** Same command as Step 2, plus `apps/desktop/test/project-host-env.test.ts` and `apps/desktop/test/preload-api.test.ts` → PASS. `pnpm typecheck` passes.

- [ ] **Step 12: Gate and commit.**

```bash
WIREBENCH_SKIP_PERF=1 pnpm check
git add apps/desktop/src/shared/wire-types.ts apps/desktop/src/shared/ipc.ts apps/desktop/src/main/ipc/cookies.ts apps/desktop/src/main/engine-wire.ts apps/desktop/src/main/send/host.ts apps/desktop/src/main/ipc/request.ts apps/desktop/src/main/project-host.ts apps/desktop/src/main/project-router.ts apps/desktop/src/main/workspace-service.ts apps/desktop/src/main/index.ts apps/desktop/test/mocks/wirebench-api.ts apps/desktop/test/ipc-cookies.test.ts apps/desktop/test/engine-wire.test.ts apps/desktop/test/send-host.test.ts apps/desktop/test/workspace-service.test.ts apps/desktop/test/project-host-env.test.ts
git commit -m "feat(desktop): the workspace jar backs every send, with IPC and per-cookie verdicts (#44)"
```


### Task 6: The Cookies tab

**Files:**
- Create: `apps/desktop/src/renderer/state/cookies.ts`
- Create: `apps/desktop/src/renderer/features/cookies/cookie-actions.ts`, `cookie-dialog.tsx`, `cookie-manager.tsx`
- Modify: `apps/desktop/src/renderer/state/editors.ts` (`EditorTab.kind`, ~line 48)
- Modify: `apps/desktop/src/renderer/shell/editor-area.tsx` (the tab branch chain, ~line 576)
- Modify: `apps/desktop/src/shared/commands.ts`, `apps/desktop/src/shared/command-catalog.ts`, `apps/desktop/src/renderer/commands/register-view-commands.ts`
- Modify: `apps/desktop/src/renderer/features/environments/environments-view.tsx` (header, ~line 262)
- Test: `apps/desktop/test/renderer/cookie-manager.test.tsx` (create); `apps/desktop/test/renderer/commands.test.ts`; `apps/desktop/test/renderer/editor-area.test.tsx`; `apps/desktop/test/renderer/environments-view.test.tsx`

**Interfaces:**
- Consumes: channels `cookies.*` and event `cookies.changed`; `StoredCookieWire`, `CookieKeyWire`, `CookieJarStateWire` (Task 5).
- Produces:
  - `useCookiesStore` (`cookies`, `persisted`, `load`, `set(cookie, replaces?)`, `remove(key)`, `removeDomain(domain)`, `clear()`, `applyState(state)`) and `subscribeToCookies(): () => void`
  - `COOKIES_TAB_ID = 'cookies'`, `openCookiesTab(): void`
  - `CookieManager`; `CookieDialog`, `toLocalInput(ms)`, `fromLocalInput(text)`
  - `EditorTab.kind` gains `'cookies'`; command `view.showCookies`

- [ ] **Step 1: Write the failing tests.** Create `apps/desktop/test/renderer/cookie-manager.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { CookieManager } from '../../src/renderer/features/cookies/cookie-manager.js';
import { useCookiesStore } from '../../src/renderer/state/cookies.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import type { CookieJarStateWire, StoredCookieWire } from '../../src/shared/wire-types.js';

const NOW = Date.parse('2026-10-03T12:00:00Z');

function stored(name: string, domain: string, extra: Partial<StoredCookieWire> = {}): StoredCookieWire {
  return {
    name,
    value: `${name}-secret`,
    domain,
    hostOnly: false,
    path: '/',
    secure: false,
    httpOnly: false,
    createdAt: NOW,
    ...extra,
  };
}

const JAR: CookieJarStateWire = {
  cookies: [
    stored('sid', 'api.test', { hostOnly: true, secure: true, expiresAt: NOW + 3_600_000 }),
    stored('lang', 'api.test'),
    stored('o', 'other.test'),
  ],
  persisted: true,
};
const EMPTY: CookieJarStateWire = { cookies: [], persisted: true };

function answering(value: CookieJarStateWire) {
  return vi.fn().mockResolvedValue({ ok: true, value });
}

function mount(state: CookieJarStateWire = JAR, channels: Record<string, unknown> = {}, on?: unknown): void {
  installWirebenchApi({
    cookies: { list: answering(state), ...channels },
    ...(on !== undefined ? { on: on as never } : {}),
  });
  render(
    <TooltipPrimitive.Provider>
      <CookieManager />
    </TooltipPrimitive.Provider>,
  );
}

async function rows(count: number): Promise<HTMLElement[]> {
  await waitFor(() => {
    expect(screen.getAllByTestId('cookie-row')).toHaveLength(count);
  });
  return screen.getAllByTestId('cookie-row');
}

afterEach(() => {
  cleanup();
  useCookiesStore.setState({ cookies: [], persisted: true });
});

describe('CookieManager', () => {
  it('groups by domain, sorts by domain and then name, and tags a host-only cookie', async () => {
    mount();
    const [lang, sid, other] = await rows(3);
    expect(screen.getAllByTestId('cookie-domain-group').map((group) => group.textContent)).toEqual([
      expect.stringContaining('api.test'),
      expect.stringContaining('other.test'),
    ]);
    expect(lang?.textContent).toContain('lang');
    expect(sid?.textContent).toContain('sid');
    expect(other?.textContent).toContain('o');
    expect(within(sid!).getByTestId('cookie-host-only').textContent).toBe('host only');
    expect(within(lang!).queryByTestId('cookie-host-only')).toBeNull();
    expect(within(lang!).getByTestId('cookie-expires').textContent).toBe('Session');
    expect(within(sid!).getByTestId('cookie-expires').textContent).toBe(new Date(NOW + 3_600_000).toLocaleString());
  });

  it('masks values until Show values, and edits a value in place', async () => {
    const set = answering(JAR);
    mount(JAR, { set });
    await rows(3);
    expect(screen.queryByText('sid-secret')).toBeNull();
    expect(screen.queryAllByTestId('cookie-value')).toHaveLength(0);

    fireEvent.click(screen.getByTestId('cookie-show-values'));
    const value = screen.getByLabelText<HTMLInputElement>('Value of sid');
    expect(value.value).toBe('sid-secret');
    fireEvent.change(value, { target: { value: 'changed' } });
    fireEvent.keyDown(value, { key: 'Enter' });
    await waitFor(() => {
      expect(set).toHaveBeenCalledWith({ cookie: { ...JAR.cookies[0], value: 'changed' } });
    });
  });

  it('deletes a cookie, and every cookie of a domain', async () => {
    const remove = answering(JAR);
    const removeDomain = answering(JAR);
    mount(JAR, { remove, removeDomain });
    await rows(3);
    fireEvent.click(screen.getByRole('button', { name: 'Delete sid' }));
    await waitFor(() => {
      expect(remove).toHaveBeenCalledWith({ key: { name: 'sid', domain: 'api.test', path: '/' } });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete all for other.test' }));
    await waitFor(() => {
      expect(removeDomain).toHaveBeenCalledWith({ domain: 'other.test' });
    });
  });

  it('clears all only after a confirmation that names the count', async () => {
    const clear = answering(EMPTY);
    mount(JAR, { clear });
    await rows(3);
    fireEvent.click(screen.getByTestId('cookie-clear-all'));
    expect(screen.getByTestId('cookie-clear-confirm').textContent).toContain('all 3 cookies');
    expect(clear).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('cookie-clear-confirm-ok'));
    await waitFor(() => {
      expect(screen.getByTestId('cookie-empty')).toBeTruthy();
    });
    expect(clear).toHaveBeenCalledOnce();
  });

  it('says when cookies are kept for this session only, and what an empty jar means', async () => {
    mount({ cookies: [], persisted: false });
    await waitFor(() => {
      expect(screen.getByTestId('cookie-persistence-note').textContent).toBe(
        'Cookies are kept for this session only: this system has no secure storage.',
      );
    });
    expect(screen.getByTestId('cookie-empty').textContent).toBe(
      'No cookies yet. Responses store cookies here; a request sends them when its Send cookies setting is on.',
    );
  });

  it('follows cookies.changed, so a send updates the tab live', async () => {
    let listener: ((payload: unknown) => void) | undefined;
    const on = vi.fn((name: string, callback: (payload: unknown) => void) => {
      if (name === 'cookies.changed') {
        listener = callback;
      }
      return () => undefined;
    });
    mount(EMPTY, {}, on);
    await waitFor(() => {
      expect(listener).toBeDefined();
    });
    act(() => {
      listener?.(JAR);
    });
    expect(screen.getAllByTestId('cookie-row')).toHaveLength(3);
  });

  it('adds a cookie through the dialog', async () => {
    const set = answering(JAR);
    mount(EMPTY, { set });
    fireEvent.click(screen.getByTestId('cookie-add'));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'token' } });
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'abc' } });
    fireEvent.change(screen.getByLabelText('Domain'), { target: { value: '.API.test' } });
    fireEvent.click(screen.getByTestId('cookie-dialog-save'));
    await waitFor(() => {
      expect(set).toHaveBeenCalledOnce();
    });
    const request = set.mock.calls[0]?.[0] as { cookie: StoredCookieWire; replaces?: unknown };
    expect(request.cookie).toMatchObject({
      name: 'token',
      value: 'abc',
      domain: 'api.test',
      path: '/',
      hostOnly: true,
      secure: false,
      httpOnly: false,
    });
    expect(request.cookie.expiresAt).toBeUndefined();
    expect(request.replaces).toBeUndefined();
  });

  it('moves a cookie to another path through the dialog, replacing the old one', async () => {
    const set = answering(JAR);
    mount(JAR, { set });
    await rows(3);
    fireEvent.click(screen.getByRole('button', { name: 'Edit lang' }));
    fireEvent.change(screen.getByLabelText('Path'), { target: { value: '/v2' } });
    fireEvent.click(screen.getByTestId('cookie-dialog-save'));
    await waitFor(() => {
      expect(set).toHaveBeenCalledWith({
        cookie: { ...JAR.cookies[1], path: '/v2' },
        replaces: { name: 'lang', domain: 'api.test', path: '/' },
      });
    });
  });
});
```

  In `apps/desktop/test/renderer/commands.test.ts`, add at the end:

```ts
describe('view.showCookies', () => {
  beforeEach(() => {
    installWirebenchApi();
    resetCommands();
    registerShellCommands(vi.fn());
    useEditorsStore.setState({ tabs: [], activeId: undefined });
  });

  afterEach(() => {
    useEditorsStore.setState({ tabs: [], activeId: undefined });
  });

  it('opens the one Cookies tab of the window', async () => {
    await runCommand('view.showCookies', context);
    await runCommand('view.showCookies', context);
    expect(useEditorsStore.getState().tabs).toEqual([{ id: 'cookies', kind: 'cookies', title: 'Cookies' }]);
    expect(useEditorsStore.getState().activeId).toBe('cookies');
  });
});
```

  In `apps/desktop/test/renderer/editor-area.test.tsx`, add at the end:

```tsx
describe('EditorArea — the Cookies tab', () => {
  afterEach(() => {
    cleanup();
    useEditorsStore.setState({ tabs: [], activeId: undefined, formViewTypes: {} });
  });

  it('shows the cookie manager', async () => {
    installWirebenchApi();
    useEditorsStore.setState({ tabs: [], activeId: undefined, formViewTypes: {} });
    useEditorsStore.getState().open({ id: 'cookies', kind: 'cookies', title: 'Cookies' });
    render(<EditorArea />);
    expect(await screen.findByTestId('cookie-manager')).toBeTruthy();
  });
});
```

  In `apps/desktop/test/renderer/environments-view.test.tsx`, add inside `describe('EnvironmentsView', …)`:

```tsx
  it('opens the Cookies tab from its header', () => {
    setUp();
    fireEvent.click(screen.getByTestId('environments-cookies'));
    expect(useEditorsStore.getState().activeId).toBe('cookies');
  });
```

- [ ] **Step 2: Run to see it fail.**

```bash
pnpm vitest run apps/desktop/test/renderer/cookie-manager.test.tsx apps/desktop/test/renderer/commands.test.ts apps/desktop/test/renderer/editor-area.test.tsx apps/desktop/test/renderer/environments-view.test.tsx apps/desktop/test/renderer/command-catalog.test.ts
```

  Expected: FAIL (the modules, the tab kind and the command do not exist).

- [ ] **Step 3: The mirror.** Create `apps/desktop/src/renderer/state/cookies.ts`:

```ts
import { create } from 'zustand';
import type { CookieJarStateWire, CookieKeyWire, StoredCookieWire } from '../../shared/wire-types.js';
import { ipc } from './ipc-client.js';

/**
 * The renderer's mirror of the open workspace's cookie jar (cookie jar spec §3). Main is the only
 * writer: every action asks main and takes the whole jar it answers, and `cookies.changed` keeps the
 * mirror current while sends store cookies.
 */
export interface CookiesStore {
  readonly cookies: readonly StoredCookieWire[];
  /** False when nothing is saved: no secure storage on this system. */
  readonly persisted: boolean;
  readonly load: () => Promise<void>;
  /** Stores `cookie`; `replaces` names the cookie it was, when its name, domain or path changed. */
  readonly set: (cookie: StoredCookieWire, replaces?: CookieKeyWire) => Promise<void>;
  readonly remove: (key: CookieKeyWire) => Promise<void>;
  readonly removeDomain: (domain: string) => Promise<void>;
  readonly clear: () => Promise<void>;
  /** Replaces the mirror wholesale; used by the `cookies.changed` subscription. */
  readonly applyState: (state: CookieJarStateWire) => void;
}

export const useCookiesStore = create<CookiesStore>((set) => ({
  cookies: [],
  persisted: true,

  applyState: (state) => {
    set({ cookies: state.cookies, persisted: state.persisted });
  },

  load: async () => {
    const result = await ipc().cookies.list(undefined);
    if (result.ok) {
      set({ cookies: result.value.cookies, persisted: result.value.persisted });
    }
  },

  set: async (cookie, replaces) => {
    const result = await ipc().cookies.set({ cookie, ...(replaces !== undefined ? { replaces } : {}) });
    if (result.ok) {
      set({ cookies: result.value.cookies, persisted: result.value.persisted });
    }
  },

  remove: async (key) => {
    const result = await ipc().cookies.remove({ key });
    if (result.ok) {
      set({ cookies: result.value.cookies, persisted: result.value.persisted });
    }
  },

  removeDomain: async (domain) => {
    const result = await ipc().cookies.removeDomain({ domain });
    if (result.ok) {
      set({ cookies: result.value.cookies, persisted: result.value.persisted });
    }
  },

  clear: async () => {
    const result = await ipc().cookies.clear(undefined);
    if (result.ok) {
      set({ cookies: result.value.cookies, persisted: result.value.persisted });
    }
  },
}));

/** Pulls the jar and follows `cookies.changed`. Returns an unsubscribe, as `subscribeToGlobals` does. */
export function subscribeToCookies(): () => void {
  void useCookiesStore.getState().load();
  return window.wirebench.on('cookies.changed', ((payload: CookieJarStateWire) => {
    useCookiesStore.getState().applyState(payload);
  }) as (payload: unknown) => void);
}
```

- [ ] **Step 4: The tab kind and its opener.**
  - In `apps/desktop/src/renderer/state/editors.ts`, add `| 'cookies'` after `| 'sequence'` in `EditorTab.kind`. `state/workspace-tabs.ts` needs no change: its `persist` returns `undefined` for an unlisted kind, so the tab is not restored, like a diff.
  - Create `apps/desktop/src/renderer/features/cookies/cookie-actions.ts`:

```ts
import { useEditorsStore } from '../../state/editors.js';

/** The one Cookies tab of a window (cookie jar spec §3); opening it again focuses it. */
export const COOKIES_TAB_ID = 'cookies';

export function openCookiesTab(): void {
  useEditorsStore.getState().open({ id: COOKIES_TAB_ID, kind: 'cookies', title: 'Cookies' });
}
```

- [ ] **Step 5: The dialog.** Create `apps/desktop/src/renderer/features/cookies/cookie-dialog.tsx`:

```tsx
import { useId, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { KV_INPUT_CLASS } from '../../components/kv-table.js';
import type { CookieKeyWire, StoredCookieWire } from '../../../shared/wire-types.js';

/** An epoch-ms instant as a `datetime-local` value, in local time. */
export function toLocalInput(ms: number): string {
  const date = new Date(ms);
  const pad = (part: number): string => String(part).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A `datetime-local` value as epoch ms; `undefined` for an empty field (a session cookie) or nonsense. */
export function fromLocalInput(text: string): number | undefined {
  if (text.trim() === '') {
    return undefined;
  }
  const ms = new Date(text).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly type?: string;
  readonly placeholder?: string;
}) {
  const id = useId();
  return (
    <>
      <label htmlFor={id} className="text-fg-muted">
        {label}
      </label>
      <input
        id={id}
        type={type}
        data-testid={`cookie-field-${label.toLowerCase()}`}
        className={KV_INPUT_CLASS}
        value={value}
        placeholder={placeholder}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </>
  );
}

function Flag({
  label,
  checked,
  onChange,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-sm text-fg-default">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      {label}
    </label>
  );
}

export interface CookieDialogProps {
  readonly open: boolean;
  /** The cookie being edited; `undefined` adds one. */
  readonly cookie: StoredCookieWire | undefined;
  readonly onOpenChange: (open: boolean) => void;
  /** `replaces` names the edited cookie when its name, domain or path changed. */
  readonly onSave: (cookie: StoredCookieWire, replaces: CookieKeyWire | undefined) => void;
}

/** **Edit cookie** and **Add cookie** (cookie jar spec §3): everything but the value, which edits in place. */
export function CookieDialog({ open, cookie, onOpenChange, onSave }: CookieDialogProps) {
  const [name, setName] = useState(cookie?.name ?? '');
  const [value, setValue] = useState(cookie?.value ?? '');
  const [domain, setDomain] = useState(cookie?.domain ?? '');
  const [path, setPath] = useState(cookie?.path ?? '/');
  const [expires, setExpires] = useState(cookie?.expiresAt === undefined ? '' : toLocalInput(cookie.expiresAt));
  const [secure, setSecure] = useState(cookie?.secure ?? false);
  const [httpOnly, setHttpOnly] = useState(cookie?.httpOnly ?? false);
  const [hostOnly, setHostOnly] = useState(cookie?.hostOnly ?? true);
  const [error, setError] = useState<string | undefined>(undefined);

  const save = (): void => {
    const nextName = name.trim();
    const nextDomain = domain.trim().replace(/^\./, '').toLowerCase();
    const nextPath = path.trim() === '' ? '/' : path.trim();
    if (nextName === '' || nextDomain === '') {
      setError('A cookie needs a name and a domain.');
      return;
    }
    if (!nextPath.startsWith('/')) {
      setError('A path starts with /.');
      return;
    }
    const expiresAt = fromLocalInput(expires);
    if (expires.trim() !== '' && expiresAt === undefined) {
      setError('Expires is not a date and time.');
      return;
    }
    const next: StoredCookieWire = {
      name: nextName,
      value,
      domain: nextDomain,
      hostOnly,
      path: nextPath,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      secure,
      httpOnly,
      ...(cookie?.sameSite !== undefined ? { sameSite: cookie.sameSite } : {}),
      createdAt: cookie?.createdAt ?? Date.now(),
    };
    const replaces =
      cookie !== undefined &&
      (cookie.name !== next.name || cookie.domain !== next.domain || cookie.path !== next.path)
        ? { name: cookie.name, domain: cookie.domain, path: cookie.path }
        : undefined;
    onSave(next, replaces);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          aria-describedby={undefined}
          data-testid="cookie-dialog"
          className="fixed top-1/2 left-1/2 w-[28rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <Dialog.Title className="text-md font-medium text-fg-default">
            {cookie === undefined ? 'Add cookie' : 'Edit cookie'}
          </Dialog.Title>
          <div className="mt-3 grid grid-cols-[6rem_1fr] items-center gap-2 text-sm">
            <Field label="Name" value={name} onChange={setName} />
            <Field label="Value" value={value} onChange={setValue} />
            <Field label="Domain" value={domain} onChange={setDomain} placeholder="api.example.com" />
            <Field label="Path" value={path} onChange={setPath} />
            <Field label="Expires" type="datetime-local" value={expires} onChange={setExpires} />
          </div>
          <p className="mt-1 text-xs text-fg-subtle">Leave Expires empty for a session cookie, which is never saved.</p>
          <div className="mt-3 flex gap-4">
            <Flag label="Secure" checked={secure} onChange={setSecure} />
            <Flag label="HttpOnly" checked={httpOnly} onChange={setHttpOnly} />
            <Flag label="Host only" checked={hostOnly} onChange={setHostOnly} />
          </div>
          {error !== undefined && (
            <p role="alert" className="mt-2 text-xs text-status-danger">
              {error}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button>Cancel</Button>
            </Dialog.Close>
            <Button variant="primary" data-testid="cookie-dialog-save" onClick={save}>
              Save
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

- [ ] **Step 6: The manager.** Create `apps/desktop/src/renderer/features/cookies/cookie-manager.tsx`:

```tsx
/**
 * The Cookies tab (cookie jar spec §3): the open workspace's jar, grouped by domain. Values stay
 * masked until *Show values*, which this tab keeps only while it is open. A value is edited in place;
 * everything else goes through the Edit cookie dialog. Past 500 rows the table virtualises.
 */
import { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '../../components/button.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { IconButton } from '../../components/icon-button.js';
import { KV_INPUT_CLASS, useCommittedDraft } from '../../components/kv-table.js';
import { subscribeToCookies, useCookiesStore } from '../../state/cookies.js';
import type { StoredCookieWire } from '../../../shared/wire-types.js';
import { CookieDialog } from './cookie-dialog.js';

const VIRTUALISE_ABOVE = 500;
const ROW_HEIGHT = 32;
const MASK = '••••••';

/** "Session", or the expiry as a local date and time. */
export function formatExpires(cookie: StoredCookieWire): string {
  return cookie.expiresAt === undefined ? 'Session' : new Date(cookie.expiresAt).toLocaleString();
}

type Row =
  | { readonly kind: 'group'; readonly domain: string; readonly count: number }
  | { readonly kind: 'cookie'; readonly cookie: StoredCookieWire };

/** A heading per domain, then its cookies: by domain, then name, then path. */
function rowsOf(cookies: readonly StoredCookieWire[]): Row[] {
  const sorted = [...cookies].sort(
    (a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path),
  );
  const counts = new Map<string, number>();
  for (const cookie of sorted) {
    counts.set(cookie.domain, (counts.get(cookie.domain) ?? 0) + 1);
  }
  const rows: Row[] = [];
  let domain: string | undefined;
  for (const cookie of sorted) {
    if (cookie.domain !== domain) {
      domain = cookie.domain;
      rows.push({ kind: 'group', domain, count: counts.get(domain) ?? 0 });
    }
    rows.push({ kind: 'cookie', cookie });
  }
  return rows;
}

function rowKey(row: Row): string {
  return row.kind === 'group' ? `group:${row.domain}` : `${row.cookie.domain}\n${row.cookie.path}\n${row.cookie.name}`;
}

function CookieRow({
  cookie,
  showValues,
  onCommitValue,
  onEdit,
  onDelete,
}: {
  readonly cookie: StoredCookieWire;
  readonly showValues: boolean;
  readonly onCommitValue: (value: string) => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}) {
  const valueField = useCommittedDraft(cookie.value, onCommitValue);
  return (
    <tr data-testid="cookie-row" className="border-b border-hairline hover:bg-surface-hover" style={{ height: ROW_HEIGHT }}>
      <td className="px-2 py-1 font-mono break-words text-fg-default">
        {cookie.name}
        {cookie.hostOnly && (
          <span
            data-testid="cookie-host-only"
            className="ml-2 rounded bg-surface-raised px-1 font-sans text-xs text-fg-subtle"
          >
            host only
          </span>
        )}
      </td>
      <td className="px-2 py-1">
        {showValues ? (
          <input
            aria-label={`Value of ${cookie.name}`}
            data-testid="cookie-value"
            className={KV_INPUT_CLASS}
            {...valueField}
          />
        ) : (
          <span data-testid="cookie-value-masked" className="font-mono text-fg-muted">
            {MASK}
          </span>
        )}
      </td>
      <td className="px-2 py-1 font-mono break-words text-fg-muted">{cookie.path}</td>
      <td data-testid="cookie-expires" className="px-2 py-1 text-fg-muted">
        {formatExpires(cookie)}
      </td>
      <td className="px-2 py-1 text-center text-fg-muted">{cookie.secure ? 'Yes' : ''}</td>
      <td className="px-2 py-1 text-center text-fg-muted">{cookie.httpOnly ? 'Yes' : ''}</td>
      <td className="px-2 py-1">
        <div className="flex justify-end gap-1">
          <IconButton label={`Edit ${cookie.name}`} data-testid="cookie-edit" onClick={onEdit}>
            <Pencil size={13} aria-hidden="true" />
          </IconButton>
          <IconButton label={`Delete ${cookie.name}`} data-testid="cookie-delete" onClick={onDelete}>
            <Trash2 size={13} aria-hidden="true" />
          </IconButton>
        </div>
      </td>
    </tr>
  );
}

export function CookieManager() {
  const cookies = useCookiesStore((state) => state.cookies);
  const persisted = useCookiesStore((state) => state.persisted);
  const [showValues, setShowValues] = useState(false);
  const [editing, setEditing] = useState<{ readonly cookie: StoredCookieWire | undefined } | undefined>(undefined);
  const [confirmClear, setConfirmClear] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => subscribeToCookies(), []);

  const rows = rowsOf(cookies);
  const virtualised = rows.length > VIRTUALISE_ABOVE;
  const virtualizer = useVirtualizer({
    count: virtualised ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });
  const items = virtualizer.getVirtualItems();
  const visible = virtualised
    ? items.flatMap((item) => {
        const row = rows[item.index];
        return row === undefined ? [] : [row];
      })
    : rows;
  const paddingTop = virtualised ? (items[0]?.start ?? 0) : 0;
  const paddingBottom = virtualised ? virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0) : 0;

  const store = useCookiesStore.getState;

  return (
    <section data-testid="cookie-manager" aria-label="Cookies" className="flex h-full min-h-0 flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-md font-medium text-fg-default">Cookies</h2>
        <span className="text-sm text-fg-subtle">{`${String(cookies.length)} in this workspace`}</span>
        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-sm text-fg-muted">
            <input
              type="checkbox"
              data-testid="cookie-show-values"
              checked={showValues}
              onChange={(event) => {
                setShowValues(event.target.checked);
              }}
            />
            Show values
          </label>
          <Button
            data-testid="cookie-add"
            onClick={() => {
              setEditing({ cookie: undefined });
            }}
          >
            <Plus size={14} aria-hidden="true" />
            Add cookie
          </Button>
          <Button
            data-testid="cookie-clear-all"
            disabled={cookies.length === 0}
            onClick={() => {
              setConfirmClear(true);
            }}
          >
            Clear all
          </Button>
        </div>
      </div>

      {!persisted && (
        <p data-testid="cookie-persistence-note" role="note" className="text-sm text-status-warning">
          Cookies are kept for this session only: this system has no secure storage.
        </p>
      )}

      {cookies.length === 0 ? (
        <p data-testid="cookie-empty" className="text-sm text-fg-subtle">
          No cookies yet. Responses store cookies here; a request sends them when its Send cookies setting is on.
        </p>
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto rounded-md border border-hairline">
          <table aria-label="Cookies" className="w-full table-fixed border-collapse text-sm">
            <colgroup>
              <col className="w-[20%]" />
              <col />
              <col className="w-[14%]" />
              <col className="w-[18%]" />
              <col className="w-16" />
              <col className="w-16" />
              <col className="w-16" />
            </colgroup>
            <thead>
              <tr className="border-b border-hairline text-left text-xs tracking-wider text-fg-subtle uppercase">
                <th className="px-2 py-1.5 font-medium">Name</th>
                <th className="px-2 py-1.5 font-medium">Value</th>
                <th className="px-2 py-1.5 font-medium">Path</th>
                <th className="px-2 py-1.5 font-medium">Expires</th>
                <th className="px-2 py-1.5 font-medium">Secure</th>
                <th className="px-2 py-1.5 font-medium">HttpOnly</th>
                <th className="px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {paddingTop > 0 && <tr aria-hidden="true" style={{ height: paddingTop }} />}
              {visible.map((row) =>
                row.kind === 'group' ? (
                  <tr key={rowKey(row)} data-testid="cookie-domain-group" className="bg-surface-raised">
                    <th scope="colgroup" colSpan={7} className="px-2 py-1 text-left text-xs font-medium text-fg-muted">
                      <div className="flex items-center justify-between gap-2">
                        <span>{`${row.domain} · ${String(row.count)}`}</span>
                        <Button
                          variant="ghost"
                          data-testid="cookie-delete-domain"
                          onClick={() => {
                            void store().removeDomain(row.domain);
                          }}
                        >
                          {`Delete all for ${row.domain}`}
                        </Button>
                      </div>
                    </th>
                  </tr>
                ) : (
                  <CookieRow
                    key={rowKey(row)}
                    cookie={row.cookie}
                    showValues={showValues}
                    onCommitValue={(value) => {
                      void store().set({ ...row.cookie, value });
                    }}
                    onEdit={() => {
                      setEditing({ cookie: row.cookie });
                    }}
                    onDelete={() => {
                      void store().remove({ name: row.cookie.name, domain: row.cookie.domain, path: row.cookie.path });
                    }}
                  />
                ),
              )}
              {paddingBottom > 0 && <tr aria-hidden="true" style={{ height: paddingBottom }} />}
            </tbody>
          </table>
        </div>
      )}

      {editing !== undefined && (
        <CookieDialog
          open
          cookie={editing.cookie}
          onOpenChange={(open) => {
            if (!open) {
              setEditing(undefined);
            }
          }}
          onSave={(cookie, replaces) => {
            setEditing(undefined);
            void store().set(cookie, replaces);
          }}
        />
      )}

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="Clear all cookies?"
        description={`This deletes all ${String(cookies.length)} cookies of this workspace.`}
        confirmLabel="Clear all"
        destructive
        onConfirm={() => {
          setConfirmClear(false);
          void store().clear();
        }}
        testId="cookie-clear-confirm"
        confirmTestId="cookie-clear-confirm-ok"
        cancelTestId="cookie-clear-confirm-cancel"
      />
    </section>
  );
}
```

  `store().set(cookie, replaces)`: `replaces` is `CookieKeyWire | undefined`, and the action's second parameter is optional, so passing `undefined` is allowed.

- [ ] **Step 7: Show the tab.** In `apps/desktop/src/renderer/shell/editor-area.tsx`, add `import { CookieManager } from '../features/cookies/cookie-manager.js';` with the other feature imports, and insert a branch before the final `) : activeTab.requestId !== undefined ? (`:

```tsx
        ) : activeTab.kind === 'cookies' ? (
          <CookieManager />
```

- [ ] **Step 8: The command.**
  - `apps/desktop/src/shared/commands.ts`: add `'view.showCookies',` after `'view.showWss',`.
  - `apps/desktop/src/shared/command-catalog.ts`: after the `'view.showWss'` entry, add:

```ts
  'view.showCookies': {
    id: 'view.showCookies',
    label: 'Show Cookies',
    category: 'View',
  },
```

  - `apps/desktop/src/renderer/commands/register-view-commands.ts`: add `import { openCookiesTab } from '../features/cookies/cookie-actions.js';`, and after the `view.showWss` registration:

```ts
  registerCommand({
    ...catalogEntry('view.showCookies'),
    run: () => {
      openCookiesTab();
    },
  });
```

  - Run `pnpm docs:commands`, which regenerates `docs-site/src/content/docs/reference/commands.md` (`pnpm check` runs `docs:commands --check`).

- [ ] **Step 9: The Environments view entry.** In `apps/desktop/src/renderer/features/environments/environments-view.tsx`, add `Cookie` to the `lucide-react` import and `import { openCookiesTab } from '../cookies/cookie-actions.js';`. Between the "Add environment" `IconButton` and the "Collapse sidebar" one, add:

```tsx
        <IconButton label="Cookies…" data-testid="environments-cookies" onClick={openCookiesTab}>
          <Cookie size={14} aria-hidden="true" />
        </IconButton>
```

- [ ] **Step 10: Run to see it pass.** Same command as Step 2 → PASS.

- [ ] **Step 11: Gate and commit.**

```bash
WIREBENCH_SKIP_PERF=1 pnpm check
git add apps/desktop/src/renderer/state/cookies.ts apps/desktop/src/renderer/features/cookies apps/desktop/src/renderer/state/editors.ts apps/desktop/src/renderer/shell/editor-area.tsx apps/desktop/src/shared/commands.ts apps/desktop/src/shared/command-catalog.ts apps/desktop/src/renderer/commands/register-view-commands.ts apps/desktop/src/renderer/features/environments/environments-view.tsx apps/desktop/test/renderer/cookie-manager.test.tsx apps/desktop/test/renderer/commands.test.ts apps/desktop/test/renderer/editor-area.test.tsx apps/desktop/test/renderer/environments-view.test.tsx docs-site/src/content/docs/reference/commands.md
git commit -m "feat(desktop): a Cookies tab to see, edit and clear the workspace jar (#44)"
```

### Task 7: The response Cookies tab, and the Send cookies default

**Files:**
- Modify: `apps/desktop/src/renderer/features/rest-editor/response/cookies-view.tsx`
- Modify: `apps/desktop/src/renderer/features/rest-editor/rest-editor.tsx` (~line 292)
- Test: `apps/desktop/test/renderer/rest-response-pane.test.tsx`; `apps/desktop/test/renderer/rest-editor.test.tsx`

**Interfaces:**
- Consumes: `CookieWire.jar` (Task 5); `openCookiesTab` (Task 6).
- Produces: `jarNote(cookie: CookieWire): string | undefined` (exported from `cookies-view.tsx`).

- [ ] **Step 1: Write the failing tests.** In `apps/desktop/test/renderer/rest-response-pane.test.tsx`, add `import { useEditorsStore } from '../../src/renderer/state/editors.js';`, and after the test `'says so when a response set no cookies and when it was not redirected'` add:

```tsx
  it('notes what the cookie jar did with each cookie, and links to the manager', () => {
    useEditorsStore.setState({ tabs: [], activeId: undefined });
    mount(
      makeRestExchange({
        cookies: [
          { name: 'session', value: 'abc', jar: { stored: true } },
          { name: 'far', value: '1', domain: 'other.test', jar: { stored: false, reason: 'domain-mismatch' } },
          { name: 'old', value: '', maxAge: 0, jar: { stored: false, reason: 'deleted' } },
        ],
      }),
    );
    fireEvent.click(screen.getByRole('tab', { name: /Cookies/ }));
    expect(screen.getAllByTestId('rest-cookie-jar').map((cell) => cell.textContent)).toEqual([
      'stored',
      'ignored: the domain does not match the host',
      'deleted from the jar',
    ]);
    fireEvent.click(screen.getByTestId('rest-cookies-manage'));
    expect(useEditorsStore.getState().activeId).toBe('cookies');
  });
```

  In `apps/desktop/test/renderer/rest-editor.test.tsx`, after the test `'leaves an unset setting empty and shows what it would inherit'` add:

```tsx
  it('shows Send cookies off unless the request turns it on, which is what the engine sends', () => {
    mount();
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    expect(screen.getByTestId<HTMLInputElement>('rest-setting-send-cookies').checked).toBe(false);
  });
```

- [ ] **Step 2: Run to see it fail.** `pnpm vitest run apps/desktop/test/renderer/rest-response-pane.test.tsx apps/desktop/test/renderer/rest-editor.test.tsx` → FAIL.

- [ ] **Step 3: Implement.** Replace `apps/desktop/src/renderer/features/rest-editor/response/cookies-view.tsx` with:

```tsx
/**
 * The cookies a response set, parsed into their attributes, with what the workspace cookie jar did
 * with each (cookie jar spec §3).
 *
 * A `Set-Cookie` line the engine could not parse is shown whole rather than dropped: an unparseable
 * cookie is exactly the thing a user is trying to see when they open this tab.
 */
import { Button } from '../../../components/button.js';
import { openCookiesTab } from '../../cookies/cookie-actions.js';
import type { CookieJarVerdictWire, CookieWire, RestExchangeSummary } from '../../../../shared/wire-types.js';

export interface CookiesViewProps {
  readonly exchange: RestExchangeSummary;
}

const IGNORED: Readonly<Record<Exclude<NonNullable<CookieJarVerdictWire['reason']>, 'deleted'>, string>> = {
  'domain-mismatch': 'the domain does not match the host',
  'domain-not-allowed': 'the domain is not allowed',
  'secure-over-http': 'Secure over plain http',
  'too-large': 'too large',
  malformed: 'not a cookie',
};

/** "stored", "deleted from the jar" or "ignored: <why>"; `undefined` when the send had no jar. */
export function jarNote(cookie: CookieWire): string | undefined {
  const verdict = cookie.jar;
  if (verdict === undefined) {
    return undefined;
  }
  if (verdict.stored) {
    return 'stored';
  }
  const reason = verdict.reason ?? 'malformed';
  return reason === 'deleted' ? 'deleted from the jar' : `ignored: ${IGNORED[reason]}`;
}

/** The attributes column for one cookie. */
function attributes(cookie: CookieWire): string {
  return [
    cookie.domain !== undefined ? `Domain=${cookie.domain}` : undefined,
    cookie.path !== undefined ? `Path=${cookie.path}` : undefined,
    cookie.expires !== undefined ? `Expires=${cookie.expires}` : undefined,
    cookie.maxAge !== undefined ? `Max-Age=${String(cookie.maxAge)}` : undefined,
    cookie.sameSite !== undefined ? `SameSite=${cookie.sameSite}` : undefined,
    cookie.secure === true ? 'Secure' : undefined,
    cookie.httpOnly === true ? 'HttpOnly' : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' · ');
}

function ManageLink() {
  return (
    <div className="flex justify-end">
      <Button variant="ghost" data-testid="rest-cookies-manage" onClick={openCookiesTab}>
        Manage cookies
      </Button>
    </div>
  );
}

/** The Cookies tab. */
export function CookiesView({ exchange }: CookiesViewProps) {
  if (exchange.cookies.length === 0) {
    return (
      <div data-testid="rest-response-cookies" className="p-2">
        <ManageLink />
        <p className="px-1 text-sm text-fg-subtle">This response set no cookies.</p>
      </div>
    );
  }

  return (
    <div data-testid="rest-response-cookies" className="overflow-auto p-2">
      <ManageLink />
      <table aria-label="Response cookies" className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-hairline text-left tracking-wider text-fg-subtle uppercase">
            <th className="px-2 py-1 font-medium">Name</th>
            <th className="px-2 py-1 font-medium">Value</th>
            <th className="px-2 py-1 font-medium">Attributes</th>
            <th className="px-2 py-1 font-medium">Jar</th>
          </tr>
        </thead>
        <tbody>
          {exchange.cookies.map((cookie, index) => (
            <tr key={`${cookie.name}:${String(index)}`} data-testid="rest-cookie-row" className="align-top font-mono">
              <td className="px-2 py-0.5 break-words text-fg-default">{cookie.name}</td>
              <td className="px-2 py-0.5 break-words text-fg-muted">
                {cookie.malformed === true ? (
                  <span className="text-status-warning">could not be parsed</span>
                ) : (
                  cookie.value
                )}
              </td>
              <td className="px-2 py-0.5 break-words text-fg-subtle">{attributes(cookie)}</td>
              <td data-testid="rest-cookie-jar" className="px-2 py-0.5 font-sans text-fg-subtle">
                {jarNote(cookie) ?? ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

  In `apps/desktop/src/renderer/features/rest-editor/rest-editor.tsx`, in the `SettingsTab`'s `inherited` object, replace `sendCookies: true,` with:

```tsx
              // Off: the engine sends jar cookies only when a request turns this on (REST spec §3.3).
              sendCookies: false,
```

- [ ] **Step 4: Run to see it pass.** Same command as Step 2 → PASS.

- [ ] **Step 5: Gate and commit.**

```bash
WIREBENCH_SKIP_PERF=1 pnpm check
git add apps/desktop/src/renderer/features/rest-editor/response/cookies-view.tsx apps/desktop/src/renderer/features/rest-editor/rest-editor.tsx apps/desktop/test/renderer/rest-response-pane.test.tsx apps/desktop/test/renderer/rest-editor.test.tsx
git commit -m "feat(desktop): the response Cookies tab says what the jar kept, and Send cookies shows off (#44)"
```


### Task 8: Current values in the engine's scopes

**Files:**
- Create: `packages/engine/src/run/current-values.ts`
- Modify: `packages/engine/src/run/context.ts` (`RunContext`; `scopesFor`)
- Modify: `packages/engine/src/run/index.ts`
- Test: `packages/engine/test/unit/run/current-values.test.ts` (create)

**Interfaces:**
- Produces:
  - `interface CurrentValues { global?: PropertyMap; workspace?: PropertyMap; workspaceEnvironments?: Readonly<Record<string, PropertyMap>>; project?: PropertyMap; projectEnvironments?: Readonly<Record<string, PropertyMap>> }`
  - `overlayCurrent(properties: PropertyMap, current: PropertyMap | undefined): PropertyMap`
  - `withCurrentValues(input: { project: Project; workspace?: Workspace; globals: PropertyMap }, current: CurrentValues | undefined): { project: Project; workspace?: Workspace; globals: PropertyMap }`
  - `RunContext.current?: CurrentValues`

- [ ] **Step 1: Write the failing tests.** Create `packages/engine/test/unit/run/current-values.test.ts`:

```ts
/**
 * Current values in resolution (cookie jar spec §5.2): each overlay lands on its own scope, under the
 * command line's `--var`, never on a disabled variable, and it stays a template.
 */
import { describe, expect, it } from 'vitest';
import { createProject } from '../../../src/project/model.js';
import type { Environment, Project } from '../../../src/project/model.js';
import { expand } from '../../../src/project/properties.js';
import { scopesFor, type RunContext } from '../../../src/run/context.js';
import { overlayCurrent } from '../../../src/run/current-values.js';
import { createWorkspace, createWorkspaceEnvironment } from '../../../src/workspace/model.js';
import { testHost } from '../../helpers/send-host.js';

function environment(id: string, properties: Record<string, string>, disabled: string[] = []): Environment {
  return { id, name: id, slug: id, order: 0, endpoints: {}, properties, disabledProperties: disabled };
}

const project: Project = {
  ...createProject('P', { id: 'p1' }),
  properties: { tenant: 'acme', region: 'eu' },
  environments: [environment('dev', { host: 'dev.test', user: 'alice' }, ['user']), environment('uat', { host: 'uat.test' })],
};

function context(extra: Partial<RunContext> = {}): RunContext {
  return { project, projectDir: '/tmp/p', environmentId: 'dev', overrides: {}, host: testHost(), ...extra };
}

describe('overlayCurrent', () => {
  it('replaces only the names the scope defines', () => {
    expect(overlayCurrent({ a: '1', b: '2' }, { a: 'x', c: 'y' })).toEqual({ a: 'x', b: '2' });
  });

  it('hands the same map back when there is nothing to lay over it', () => {
    const properties = { a: '1' };
    expect(overlayCurrent(properties, undefined)).toBe(properties);
    expect(overlayCurrent(properties, { other: 'x' })).toBe(properties);
  });
});

describe('scopesFor with current values', () => {
  it('lays each overlay over its own scope, the run environment by id', () => {
    const scopes = scopesFor(
      context({
        current: {
          project: { tenant: 'beta' },
          projectEnvironments: { dev: { host: 'mine.test' }, uat: { host: 'never.test' } },
        },
      }),
    );
    expect(scopes.project).toEqual({ tenant: 'beta', region: 'eu' });
    expect(scopes.env).toEqual({ host: 'mine.test' });
  });

  it('lets a --var override win over a current value', () => {
    const scopes = scopesFor(
      context({ overrides: { host: 'cli.test' }, current: { projectEnvironments: { dev: { host: 'mine.test' } } } }),
    );
    expect(scopes.env?.['host']).toBe('cli.test');
  });

  it("does not apply a disabled variable's current value", () => {
    const scopes = scopesFor(context({ current: { projectEnvironments: { dev: { user: 'bob' } } } }));
    expect(scopes.env).toEqual({ host: 'dev.test' });
  });

  it('keeps a current value a template, expanded like a committed one', () => {
    const scopes = scopesFor(context({ current: { project: { tenant: '${#Project#region}-team' } } }));
    expect(expand('${#Project#tenant}', scopes).text).toBe('eu-team');
  });

  it('lays the workspace, its environment and the globals inside a workspace', () => {
    const stage = {
      ...createWorkspaceEnvironment('Stage', new Set<string>(), { id: 'ws-stage' }),
      properties: { base: 'stage.test' },
    };
    const workspace = { ...createWorkspace('W', { id: 'w1' }), properties: { org: 'acme' }, environments: [stage] };
    const scopes = scopesFor(
      context({
        environmentId: 'ws-stage',
        workspace: { workspace, projectSlug: 'p' },
        globals: { who: 'me' },
        current: {
          workspace: { org: 'beta' },
          workspaceEnvironments: { 'ws-stage': { base: 'mine.test' } },
          global: { who: 'you', ghost: 'never' },
        },
      }),
    );
    expect(scopes.workspace).toEqual({ org: 'beta' });
    expect(scopes.env).toEqual({ base: 'mine.test' });
    expect(scopes.global).toEqual({ who: 'you' });
  });

  it('changes nothing without current values', () => {
    expect(scopesFor(context())).toEqual(scopesFor(context({ current: {} })));
  });
});
```

- [ ] **Step 2: Run to see it fail.** `pnpm vitest run packages/engine/test/unit/run/current-values.test.ts` → FAIL (`current-values.js` does not exist).

- [ ] **Step 3: Implement.** Create `packages/engine/src/run/current-values.ts`:

```ts
/**
 * Current values (cookie jar and current values spec §5.2): the session's own value for a variable,
 * laid over its committed value in the same scope before resolution. A host hands them in through
 * `RunContext.current`.
 *
 * A current value is typed by the user, never taken from a response, so it is a template like a
 * committed value and ADR-0015 is untouched. It only replaces a name its scope defines, and since
 * resolution drops disabled names afterwards, a disabled variable's current value does not apply.
 */
import type { Project, PropertyMap } from '../project/model.js';
import type { Workspace } from '../workspace/model.js';

/** The overlays of one run, keyed like the scopes they land on; environments by id. */
export interface CurrentValues {
  readonly global?: PropertyMap;
  readonly workspace?: PropertyMap;
  readonly workspaceEnvironments?: Readonly<Record<string, PropertyMap>>;
  readonly project?: PropertyMap;
  /** The run's project's own environments. */
  readonly projectEnvironments?: Readonly<Record<string, PropertyMap>>;
}

/** `properties` with each name it defines replaced by `current`'s value; the same map when nothing changes. */
export function overlayCurrent(properties: PropertyMap, current: PropertyMap | undefined): PropertyMap {
  if (current === undefined) {
    return properties;
  }
  let laid: Record<string, string> | undefined;
  for (const [name, value] of Object.entries(current)) {
    if (Object.hasOwn(properties, name)) {
      laid ??= { ...properties };
      laid[name] = value;
    }
  }
  return laid ?? properties;
}

/** The project, workspace and globals a run resolves, each scope with its current values laid over it. */
export function withCurrentValues(
  input: { readonly project: Project; readonly workspace?: Workspace; readonly globals: PropertyMap },
  current: CurrentValues | undefined,
): { readonly project: Project; readonly workspace?: Workspace; readonly globals: PropertyMap } {
  if (current === undefined) {
    return input;
  }
  const project: Project = {
    ...input.project,
    properties: overlayCurrent(input.project.properties, current.project),
    environments: input.project.environments.map((environment) => ({
      ...environment,
      properties: overlayCurrent(environment.properties, current.projectEnvironments?.[environment.id]),
    })),
  };
  const workspace: Workspace | undefined =
    input.workspace === undefined
      ? undefined
      : {
          ...input.workspace,
          properties: overlayCurrent(input.workspace.properties, current.workspace),
          environments: input.workspace.environments.map((environment) => ({
            ...environment,
            properties: overlayCurrent(environment.properties, current.workspaceEnvironments?.[environment.id]),
          })),
        };
  return {
    project,
    ...(workspace !== undefined ? { workspace } : {}),
    globals: overlayCurrent(input.globals, current.global),
  };
}
```

  In `packages/engine/src/run/context.ts`:
  - Add `import { withCurrentValues } from './current-values.js';` and `import type { CurrentValues } from './current-values.js';`.
  - In `RunContext`, after `globals`, add:

```ts
  /**
   * The session's current values (cookie jar spec §5.2), each laid over the committed values of its
   * own scope. `overrides` still win over them. Typed by the user, never response-derived.
   */
  readonly current?: CurrentValues;
```

  - Replace the body of `scopesFor` down to the `return {` with:

```ts
export function scopesFor(context: RunContext): PropertyScopes {
  const { environmentId } = context;
  const { project, workspace, globals } = withCurrentValues(
    {
      project: context.project,
      ...(context.workspace !== undefined ? { workspace: context.workspace.workspace } : {}),
      globals: context.globals ?? {},
    },
    context.current,
  );
  const scopes =
    workspace === undefined
      ? resolveScopes(project, environmentId, globals, process.env)
      : resolveWorkspaceScopes({
          workspace: withActiveEnvironment(workspace, environmentId),
          project,
          globals,
          system: process.env,
        });
```

  (The `return { ...scopes, env: { ...(scopes.env ?? {}), ...context.overrides }, … }` that follows is unchanged.)

  In `packages/engine/src/run/index.ts`, after `export { scopesFor } from './context.js';` add:

```ts
export { overlayCurrent, withCurrentValues } from './current-values.js';
export type { CurrentValues } from './current-values.js';
```

- [ ] **Step 4: Run to see it pass.** `pnpm vitest run packages/engine/test/unit/run/current-values.test.ts packages/engine/test/unit/run/host.test.ts` → PASS.

- [ ] **Step 5: Gate and commit.**

```bash
WIREBENCH_SKIP_PERF=1 pnpm check
git add packages/engine/src/run/current-values.ts packages/engine/src/run/context.ts packages/engine/src/run/index.ts packages/engine/test/unit/run/current-values.test.ts
git commit -m "feat(engine): current values laid over committed ones in a run's scopes (#44)"
```

### Task 9: The desktop current-value store, IPC and sends

**Files:**
- Create: `apps/desktop/src/shared/current-value-keys.ts`
- Modify: `apps/desktop/src/shared/wire-types.ts` (after the globals request schemas, ~line 3893)
- Modify: `apps/desktop/src/shared/ipc.ts` (imports; channel group and event group after `cookies`)
- Create: `apps/desktop/src/main/current-values.ts`
- Create: `apps/desktop/src/main/ipc/current-values.ts`
- Modify: `apps/desktop/src/main/project-host.ts` (field after `workspaceContext` ~line 449; `setCurrentValues`; `runContextFor`; `scopesFor`)
- Modify: `apps/desktop/src/main/send/exchange.ts` (`runContextOf`, ~line 594)
- Modify: `apps/desktop/src/main/workspace-service.ts` (`WorkspaceServiceDeps`; after `host.setWorkspaceContext(…)` ~line 1014)
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/test/mocks/wirebench-api.ts`
- Test: `apps/desktop/test/current-values.test.ts` (create); `apps/desktop/test/ipc-current-values.test.ts` (create); `apps/desktop/test/project-host-env.test.ts`

**Interfaces:**
- Consumes: `CurrentValues`, `overlayCurrent`, `withCurrentValues` (Task 8); `WorkspaceHooks.onDeleted` (Task 5).
- Produces:
  - `ScopeKeyWire`, `CurrentValuesStateWire` (`{ scopes: { key: ScopeKeyWire; values: Record<string, string> }[] }`) and the two request schemas
  - `scopeKeyString(key: ScopeKeyWire): string`
  - `class CurrentValuesStore`:
    - `constructor(onChanged?: (state: CurrentValuesStateWire) => void)`
    - `syncWorkspace(workspace: WorkspaceWire | null): void`, `syncProject(projectId: string, project: ProjectWire | null): void`, `syncGlobals(state: GlobalsState): void`
    - `forgetWorkspace(workspaceId: string): void`
    - `state(): CurrentValuesStateWire`
    - `set(key: ScopeKeyWire, name: string, value: string): CurrentValuesStateWire`, `reset(key: ScopeKeyWire, name?: string): CurrentValuesStateWire`
    - `overlaysFor(projectId: string | undefined): CurrentValues`
  - Channels `currentValues.get` / `set` / `reset`, and the event `currentValues.changed`
  - `ProjectHost.setCurrentValues(source: (() => CurrentValues | undefined) | undefined): void`; `runContextFor(...)` gains `current?: CurrentValues`; `WorkspaceServiceDeps.currentValues?: Pick<CurrentValuesStore, 'overlaysFor'>`

- [ ] **Step 1: Write the failing tests.** Create `apps/desktop/test/current-values.test.ts`:

```ts
// @vitest-environment node
/**
 * The current-value store (cookie jar spec §5.1): a value only for a committed variable, kept per
 * workspace, carried by a rename, dropped with its variable or environment.
 */
import { describe, expect, it } from 'vitest';
import { CurrentValuesStore } from '../src/main/current-values.js';
import type { CurrentValuesStateWire, ProjectWire, ScopeKeyWire, WorkspaceWire } from '../src/shared/wire-types.js';

const WORKSPACE: ScopeKeyWire = { scope: 'workspace' };

type Environments = readonly { readonly id: string; readonly properties: Record<string, string> }[];

/** Only what the store reads: the id, the properties and each environment's. */
function workspace(properties: Record<string, string>, environments: Environments = [], id = 'w1'): WorkspaceWire {
  return { id, properties, disabled: [], environments } as unknown as WorkspaceWire;
}

function project(properties: Record<string, string>, environments: Environments = []): ProjectWire {
  return { properties, disabledProperties: [], environments } as unknown as ProjectWire;
}

describe('CurrentValuesStore', () => {
  it('keeps a value only for a committed variable, and none equal to the committed one', () => {
    const changes: CurrentValuesStateWire[] = [];
    const store = new CurrentValuesStore((state) => changes.push(state));
    store.syncWorkspace(workspace({ host: 'a.test' }));
    expect(() => store.set(WORKSPACE, 'nope', 'x')).toThrow(/no committed value/);
    expect(store.set(WORKSPACE, 'host', 'mine.test')).toEqual({
      scopes: [{ key: WORKSPACE, values: { host: 'mine.test' } }],
    });
    expect(store.set(WORKSPACE, 'host', 'a.test')).toEqual({ scopes: [] });
    expect(changes.at(-1)).toEqual({ scopes: [] });
  });

  it('carries a value through a rename, and drops it with a deleted variable', () => {
    const store = new CurrentValuesStore();
    store.syncWorkspace(workspace({ host: 'a.test', port: '80' }));
    store.set(WORKSPACE, 'host', 'mine.test');
    store.set(WORKSPACE, 'port', '8080');
    store.syncWorkspace(workspace({ server: 'a.test', port: '80' }));
    expect(store.state()).toEqual({ scopes: [{ key: WORKSPACE, values: { port: '8080', server: 'mine.test' } }] });
    store.syncWorkspace(workspace({ server: 'a.test' }));
    expect(store.state()).toEqual({ scopes: [{ key: WORKSPACE, values: { server: 'mine.test' } }] });
  });

  it('carries a value through a rename made as a remove and then a set, but no further', () => {
    const store = new CurrentValuesStore();
    store.syncWorkspace(workspace({ host: 'a.test' }));
    store.set(WORKSPACE, 'host', 'mine.test');
    store.syncWorkspace(workspace({}));
    expect(store.state()).toEqual({ scopes: [] });
    store.syncWorkspace(workspace({ server: 'a.test' }));
    expect(store.state()).toEqual({ scopes: [{ key: WORKSPACE, values: { server: 'mine.test' } }] });

    store.syncWorkspace(workspace({}));
    store.syncWorkspace(workspace({ other: 'x' }));
    store.syncWorkspace(workspace({ server: 'a.test' }));
    expect(store.state()).toEqual({ scopes: [] });
  });

  it('keeps the value of a disabled variable', () => {
    const store = new CurrentValuesStore();
    store.syncWorkspace(workspace({ host: 'a.test' }));
    store.set(WORKSPACE, 'host', 'mine.test');
    store.syncWorkspace({ ...workspace({ host: 'a.test' }), disabled: ['host'] } as WorkspaceWire);
    expect(store.state().scopes).toHaveLength(1);
  });

  it("keeps each workspace's values across switches, and forgets a deleted workspace's", () => {
    const store = new CurrentValuesStore();
    store.syncWorkspace(workspace({ host: 'a.test' }, [], 'w1'));
    store.set(WORKSPACE, 'host', 'mine.test');
    store.syncWorkspace(workspace({ host: 'b.test' }, [], 'w2'));
    expect(store.state()).toEqual({ scopes: [] });
    store.syncWorkspace(workspace({ host: 'a.test' }, [], 'w1'));
    expect(store.state().scopes).toHaveLength(1);
    store.forgetWorkspace('w1');
    expect(store.state()).toEqual({ scopes: [] });
  });

  it('resets one value, or every value of a scope', () => {
    const store = new CurrentValuesStore();
    store.syncWorkspace(workspace({ a: '1', b: '2' }));
    store.set(WORKSPACE, 'a', 'x');
    store.set(WORKSPACE, 'b', 'y');
    expect(store.reset(WORKSPACE, 'a')).toEqual({ scopes: [{ key: WORKSPACE, values: { b: 'y' } }] });
    expect(store.reset(WORKSPACE)).toEqual({ scopes: [] });
  });

  it('hands a send the overlays of its project, and drops an environment with its values', () => {
    const store = new CurrentValuesStore();
    store.syncGlobals({ properties: { who: 'me' }, disabled: [] });
    store.syncWorkspace(workspace({ org: 'acme' }, [{ id: 'e1', properties: { base: 'e1.test' } }]));
    store.syncProject('p1', project({ tenant: 't' }, [{ id: 'pe1', properties: { user: 'u' } }]));
    store.set({ scope: 'global' }, 'who', 'you');
    store.set({ scope: 'workspaceEnvironment', environmentId: 'e1' }, 'base', 'mine.test');
    store.set({ scope: 'project', projectId: 'p1' }, 'tenant', 'beta');
    store.set({ scope: 'projectEnvironment', projectId: 'p1', environmentId: 'pe1' }, 'user', 'bob');

    expect(store.overlaysFor('p1')).toEqual({
      global: { who: 'you' },
      workspaceEnvironments: { e1: { base: 'mine.test' } },
      project: { tenant: 'beta' },
      projectEnvironments: { pe1: { user: 'bob' } },
    });
    expect(store.overlaysFor('p2')).toEqual({ global: { who: 'you' }, workspaceEnvironments: { e1: { base: 'mine.test' } } });

    // A closing project keeps its values; a deleted environment takes its own with it.
    store.syncProject('p1', null);
    expect(store.overlaysFor('p1').project).toEqual({ tenant: 'beta' });
    store.syncWorkspace(workspace({ org: 'acme' }));
    expect(store.overlaysFor('p2')).toEqual({ global: { who: 'you' } });
  });
});
```

  Create `apps/desktop/test/ipc-current-values.test.ts`:

```ts
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CurrentValuesStore } from '../src/main/current-values.js';
import { registerCurrentValuesChannels } from '../src/main/ipc/current-values.js';
import { channels } from '../src/shared/ipc.js';
import type { WorkspaceWire } from '../src/shared/wire-types.js';

const registeredHandlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      registeredHandlers.set(name, handler);
    },
  },
}));

function invoke(channelName: string, payload?: unknown): Promise<{ ok: boolean; value?: unknown; error?: { code: string } }> {
  const handler = registeredHandlers.get(channelName);
  if (handler === undefined) {
    throw new Error(`${channelName} was never registered`);
  }
  return handler({ sender: {} }, payload) as Promise<{ ok: boolean; value?: unknown; error?: { code: string } }>;
}

const WORKSPACE = { scope: 'workspace' } as const;

beforeEach(() => {
  registeredHandlers.clear();
});

describe('registerCurrentValuesChannels', () => {
  it('answers every channel with the whole state', async () => {
    const store = new CurrentValuesStore();
    store.syncWorkspace({ id: 'w1', properties: { host: 'a.test', port: '80' }, environments: [] } as unknown as WorkspaceWire);
    registerCurrentValuesChannels(store);

    expect(await invoke(channels.currentValues.get.name, undefined)).toEqual({ ok: true, value: { scopes: [] } });
    await invoke(channels.currentValues.set.name, { key: WORKSPACE, name: 'host', value: 'mine.test' });
    expect(await invoke(channels.currentValues.set.name, { key: WORKSPACE, name: 'port', value: '8080' })).toEqual({
      ok: true,
      value: { scopes: [{ key: WORKSPACE, values: { host: 'mine.test', port: '8080' } }] },
    });
    expect(await invoke(channels.currentValues.reset.name, { key: WORKSPACE, name: 'host' })).toEqual({
      ok: true,
      value: { scopes: [{ key: WORKSPACE, values: { port: '8080' } }] },
    });
    expect(await invoke(channels.currentValues.reset.name, { key: WORKSPACE })).toEqual({ ok: true, value: { scopes: [] } });
  });

  it('refuses a current value for a variable with no committed value', async () => {
    const store = new CurrentValuesStore();
    store.syncWorkspace({ id: 'w1', properties: {}, environments: [] } as unknown as WorkspaceWire);
    registerCurrentValuesChannels(store);
    const result = await invoke(channels.currentValues.set.name, { key: WORKSPACE, name: 'ghost', value: 'x' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('current-value-unknown');
  });
});
```

  In `apps/desktop/test/project-host-env.test.ts`, add at the end:

```ts
describe('ProjectHost with current values', () => {
  it('lays the session current values over committed ones, for a send and for the scopes', async () => {
    const { requestId, dev, test } = await restProject();
    const current = { projectEnvironments: { [dev]: { tenant: 'mine' }, [test]: { tenant: 'theirs' } } };
    host.setCurrentValues(() => current);
    expect(target(await restSend(requestId))).toBe('https://dev.example/pets/mine');
    expect(target(await restSend(requestId, test))).toBe('https://test.example/pets/theirs');
    expect(host.scopesFor().env).toEqual({ tenant: 'mine' });
    expect(host.runContextFor(requestId)?.current).toEqual(current);
  });
});
```

- [ ] **Step 2: Run to see it fail.**

```bash
pnpm vitest run apps/desktop/test/current-values.test.ts apps/desktop/test/ipc-current-values.test.ts apps/desktop/test/project-host-env.test.ts
```

  Expected: FAIL (the modules and `setCurrentValues` do not exist).

- [ ] **Step 3: Wire schemas, the key and the channels.** In `apps/desktop/src/shared/wire-types.ts`, after `globalsSetEnabledRequestSchema` and its type, add:

```ts
/** Which committed variables a current value overrides (cookie jar spec §5.1). */
export const scopeKeyWireSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('global') }),
  z.object({ scope: z.literal('workspace') }),
  z.object({ scope: z.literal('workspaceEnvironment'), environmentId: z.string() }),
  z.object({ scope: z.literal('project'), projectId: z.string() }),
  z.object({ scope: z.literal('projectEnvironment'), projectId: z.string(), environmentId: z.string() }),
]);
export type ScopeKeyWire = z.infer<typeof scopeKeyWireSchema>;

/** The open workspace's current values, one entry per scope that has any. Session only. */
export const currentValuesStateWireSchema = z.object({
  scopes: z.array(z.object({ key: scopeKeyWireSchema, values: z.record(z.string(), z.string()) })),
});
export type CurrentValuesStateWire = z.infer<typeof currentValuesStateWireSchema>;

export const currentValuesSetRequestSchema = z.object({
  key: scopeKeyWireSchema,
  name: z.string().min(1),
  value: z.string(),
});
/** `name` omitted resets the whole scope. */
export const currentValuesResetRequestSchema = z.object({ key: scopeKeyWireSchema, name: z.string().optional() });
```

  Create `apps/desktop/src/shared/current-value-keys.ts`:

```ts
import type { ScopeKeyWire } from './wire-types.js';

/** One string per scope, for maps keyed by scope; main and the renderer key alike. */
export function scopeKeyString(key: ScopeKeyWire): string {
  switch (key.scope) {
    case 'global':
      return 'global';
    case 'workspace':
      return 'workspace';
    case 'workspaceEnvironment':
      return `workspaceEnvironment:${key.environmentId}`;
    case 'project':
      return `project:${key.projectId}`;
    case 'projectEnvironment':
      return `projectEnvironment:${key.projectId}:${key.environmentId}`;
  }
}
```

  In `apps/desktop/src/shared/ipc.ts`, add `currentValuesResetRequestSchema`, `currentValuesSetRequestSchema` and `currentValuesStateWireSchema` to the import from `'./wire-types.js'`. After the channels' `cookies: { … },` group add:

```ts
  /** The open workspace's current values (cookie jar spec §5.3). In memory only; every channel answers with the whole state. */
  currentValues: {
    get: defineChannel('currentValues.get', z.undefined(), currentValuesStateWireSchema),
    set: defineChannel('currentValues.set', currentValuesSetRequestSchema, currentValuesStateWireSchema),
    reset: defineChannel('currentValues.reset', currentValuesResetRequestSchema, currentValuesStateWireSchema),
  },
```

  After the events' `cookies: { … },` group add:

```ts
  currentValues: {
    changed: defineEvent('currentValues.changed', currentValuesStateWireSchema),
  },
```

- [ ] **Step 4: The store.** Create `apps/desktop/src/main/current-values.ts`:

```ts
/**
 * Current values (cookie jar and current values spec §5): a session-only override per variable, in
 * memory per workspace. They never reach disk, sync or the server, and are gone on quit.
 *
 * A current value exists only for a variable with a committed value in its scope. Main learns the
 * committed values from the snapshots it already broadcasts (the workspace, each project, the
 * globals) and keeps the overrides in step with them:
 * - a deleted variable drops its value;
 * - a renamed one keeps it. A rename shows as one name going and another arriving with the same
 *   committed value, in one change or in two changes in a row (a remove, then a set).
 * A disabled variable keeps its value, which does not apply: resolution drops disabled names first.
 */
import { WirebenchError } from '@wirebench/engine';
import type { CurrentValues, PropertyMap } from '@wirebench/engine';
import { scopeKeyString } from '../shared/current-value-keys.js';
import type {
  CurrentValuesStateWire,
  GlobalsState,
  ProjectWire,
  ScopeKeyWire,
  WorkspaceWire,
} from '../shared/wire-types.js';

interface Held {
  readonly committed: string;
  readonly value: string;
}

interface ScopeEntry {
  readonly key: ScopeKeyWire;
  /** The committed values as last seen: the names a current value may exist for. */
  committed: Readonly<Record<string, string>>;
  readonly values: Map<string, string>;
  /** Values of the names the last change removed, kept for one more change in case it was a rename. */
  parked: Map<string, Held>;
}

/** The map used while no workspace is open: the globals' values. */
const NO_WORKSPACE = '';

export class CurrentValuesStore {
  private readonly workspaces = new Map<string, Map<string, ScopeEntry>>();
  private currentId = NO_WORKSPACE;
  private globals: Readonly<Record<string, string>> = {};

  constructor(private readonly onChanged: (state: CurrentValuesStateWire) => void = () => undefined) {}

  /** The open workspace changed (or none is open): its own and its environments' scopes follow it. */
  syncWorkspace(workspace: WorkspaceWire | null): void {
    const id = workspace?.id ?? NO_WORKSPACE;
    const switched = id !== this.currentId;
    this.currentId = id;
    let changed = this.reconcile({ scope: 'global' }, this.globals);
    if (workspace !== null) {
      changed = this.reconcile({ scope: 'workspace' }, workspace.properties) || changed;
      const live = new Set<string>();
      for (const environment of workspace.environments) {
        const key: ScopeKeyWire = { scope: 'workspaceEnvironment', environmentId: environment.id };
        live.add(scopeKeyString(key));
        changed = this.reconcile(key, environment.properties) || changed;
      }
      changed =
        this.dropWhere((key) => key.scope === 'workspaceEnvironment' && !live.has(scopeKeyString(key))) || changed;
    }
    if (switched || changed) {
      this.announce();
    }
  }

  /** One project's model changed. `null` (its host closed) keeps its values for when it opens again. */
  syncProject(projectId: string, project: ProjectWire | null): void {
    if (project === null) {
      return;
    }
    let changed = this.reconcile({ scope: 'project', projectId }, project.properties);
    const live = new Set<string>();
    for (const environment of project.environments) {
      const key: ScopeKeyWire = { scope: 'projectEnvironment', projectId, environmentId: environment.id };
      live.add(scopeKeyString(key));
      changed = this.reconcile(key, environment.properties) || changed;
    }
    changed =
      this.dropWhere(
        (key) => key.scope === 'projectEnvironment' && key.projectId === projectId && !live.has(scopeKeyString(key)),
      ) || changed;
    if (changed) {
      this.announce();
    }
  }

  /** The globals changed; every workspace's global scope reads them. */
  syncGlobals(state: GlobalsState): void {
    this.globals = { ...state.properties };
    if (this.reconcile({ scope: 'global' }, this.globals)) {
      this.announce();
    }
  }

  /** A deleted workspace's values go with it. */
  forgetWorkspace(workspaceId: string): void {
    this.workspaces.delete(workspaceId);
    if (workspaceId === this.currentId) {
      this.announce();
    }
  }

  state(): CurrentValuesStateWire {
    return {
      scopes: [...this.scopes().values()]
        .filter((entry) => entry.values.size > 0)
        .map((entry) => ({ key: entry.key, values: Object.fromEntries(entry.values) })),
    };
  }

  /**
   * Sets `name`'s current value in `key`'s scope. The committed value itself removes the override.
   *
   * @throws WirebenchError `current-value-unknown` — `name` has no committed value in that scope
   */
  set(key: ScopeKeyWire, name: string, value: string): CurrentValuesStateWire {
    const entry = this.scopes().get(scopeKeyString(key));
    if (entry === undefined || !Object.hasOwn(entry.committed, name)) {
      throw new WirebenchError(
        'current-value-unknown',
        `"${name}" has no committed value here, so it cannot have a current value.`,
        { details: { name } },
      );
    }
    if (entry.committed[name] === value) {
      entry.values.delete(name);
    } else {
      entry.values.set(name, value);
    }
    return this.announce();
  }

  /** Resets one current value, or every one of the scope when `name` is omitted. */
  reset(key: ScopeKeyWire, name?: string): CurrentValuesStateWire {
    const entry = this.scopes().get(scopeKeyString(key));
    if (entry !== undefined) {
      if (name === undefined) {
        entry.values.clear();
      } else {
        entry.values.delete(name);
      }
    }
    return this.announce();
  }

  /** What `RunContext.current` is for a send of `projectId` (or of no project) in the open workspace. */
  overlaysFor(projectId: string | undefined): CurrentValues {
    const overlays: {
      global?: PropertyMap;
      workspace?: PropertyMap;
      workspaceEnvironments?: Record<string, PropertyMap>;
      project?: PropertyMap;
      projectEnvironments?: Record<string, PropertyMap>;
    } = {};
    for (const { key, values } of this.scopes().values()) {
      if (values.size === 0) {
        continue;
      }
      const map = Object.fromEntries(values);
      switch (key.scope) {
        case 'global':
          overlays.global = map;
          break;
        case 'workspace':
          overlays.workspace = map;
          break;
        case 'workspaceEnvironment':
          overlays.workspaceEnvironments = { ...overlays.workspaceEnvironments, [key.environmentId]: map };
          break;
        case 'project':
          if (key.projectId === projectId) {
            overlays.project = map;
          }
          break;
        case 'projectEnvironment':
          if (key.projectId === projectId) {
            overlays.projectEnvironments = { ...overlays.projectEnvironments, [key.environmentId]: map };
          }
          break;
      }
    }
    return overlays;
  }

  private scopes(): Map<string, ScopeEntry> {
    let scopes = this.workspaces.get(this.currentId);
    if (scopes === undefined) {
      scopes = new Map();
      this.workspaces.set(this.currentId, scopes);
    }
    return scopes;
  }

  private announce(): CurrentValuesStateWire {
    const state = this.state();
    this.onChanged(state);
    return state;
  }

  /** Drops the scopes `test` picks; true when one of them held a value. */
  private dropWhere(test: (key: ScopeKeyWire) => boolean): boolean {
    const scopes = this.scopes();
    let dropped = false;
    for (const [id, entry] of scopes) {
      if (test(entry.key)) {
        dropped ||= entry.values.size > 0;
        scopes.delete(id);
      }
    }
    return dropped;
  }

  /** Brings `key`'s scope in step with its committed values; true when a current value moved or went. */
  private reconcile(key: ScopeKeyWire, properties: Readonly<Record<string, string>>): boolean {
    const scopes = this.scopes();
    const id = scopeKeyString(key);
    const entry = scopes.get(id);
    if (entry === undefined) {
      scopes.set(id, { key, committed: { ...properties }, values: new Map(), parked: new Map() });
      return false;
    }
    const removed = Object.keys(entry.committed).filter((name) => !Object.hasOwn(properties, name));
    const added = Object.keys(properties).filter((name) => !Object.hasOwn(entry.committed, name));
    const candidates = new Map(entry.parked);
    const parked = new Map<string, Held>();
    let changed = false;
    for (const name of removed) {
      const value = entry.values.get(name);
      if (value !== undefined) {
        const held = { committed: entry.committed[name] ?? '', value };
        candidates.set(name, held);
        parked.set(name, held);
        entry.values.delete(name);
        changed = true;
      }
    }
    for (const name of added) {
      const match = [...candidates].find(([, held]) => held.committed === properties[name]);
      if (match !== undefined) {
        const [from, held] = match;
        entry.values.set(name, held.value);
        candidates.delete(from);
        parked.delete(from);
        changed = true;
      }
    }
    // A committed value that now equals the current one leaves nothing to override.
    for (const [name, value] of entry.values) {
      if (properties[name] === value) {
        entry.values.delete(name);
        changed = true;
      }
    }
    entry.committed = { ...properties };
    entry.parked = parked;
    return changed;
  }
}
```

  Create `apps/desktop/src/main/ipc/current-values.ts`:

```ts
import { channels } from '../../shared/ipc.js';
import type { CurrentValuesStore } from '../current-values.js';
import { registerHandler } from './register.js';

/**
 * Registers the `currentValues.*` channels (cookie jar spec §5.3). Each answers with the whole state;
 * `currentValues.changed` comes from the store after every change.
 */
export function registerCurrentValuesChannels(store: Pick<CurrentValuesStore, 'state' | 'set' | 'reset'>): void {
  registerHandler(channels.currentValues.get, () => Promise.resolve(store.state()));
  registerHandler(channels.currentValues.set, (request) =>
    Promise.resolve(store.set(request.key, request.name, request.value)),
  );
  registerHandler(channels.currentValues.reset, (request) => Promise.resolve(store.reset(request.key, request.name)));
}
```

- [ ] **Step 5: Sends and previews read them.**
  - `apps/desktop/src/main/project-host.ts`:
    - Add `overlayCurrent` and `withCurrentValues` to the value import from `'@wirebench/engine'`, and `CurrentValues` to the type import.
    - After the `private workspaceContext: WorkspaceContext | undefined;` field add:

```ts
  /**
   * The session's current values for this host's project, read afresh on every resolution (cookie
   * jar spec §5.2). Set by `WorkspaceService`; absent for a standalone project and in tests.
   */
  private currentValues: (() => CurrentValues | undefined) | undefined;
```

    - After `setWorkspaceContext`, add:

```ts
  /** Tells this host where its project's current values come from; `undefined` drops them. */
  setCurrentValues(source: (() => CurrentValues | undefined) | undefined): void {
    this.currentValues = source;
  }
```

    - In `runContextFor`, add `readonly current?: CurrentValues;` to the return type after `readonly globals: PropertyMap;`. Before its `return {`, add `const current = this.currentValues?.();`, and after `globals: this.enabledGlobals(),` add `...(current !== undefined ? { current } : {}),`.
    - Replace the body of `scopesFor(envId?: string)` with:

```ts
    const globals = this.enabledGlobals();
    const current = this.currentValues?.();
    if (this.open === undefined) {
      return { project: {}, global: overlayCurrent(globals, current?.global), system: process.env };
    }
    const context = this.workspaceContextFor(envId);
    const laid = withCurrentValues(
      {
        project: this.open.project,
        ...(context !== undefined ? { workspace: context.workspace } : {}),
        globals,
      },
      current,
    );
    if (context !== undefined) {
      // Inside a workspace the active environment is the *workspace's*, and the project
      // manifest's own `activeEnvironmentId` is deliberately not read (spec §3.3) — so `envId`
      // names a workspace environment here, resolved without changing the active one.
      return resolveWorkspaceScopes({
        workspace: laid.workspace ?? context.workspace,
        project: laid.project,
        globals: laid.globals,
        system: process.env,
      });
    }
    return resolveScopes(laid.project, envId ?? this.open.project.activeEnvironmentId, laid.globals, process.env);
```

  - `apps/desktop/src/main/send/exchange.ts`: in `runContextOf`, after the `globals` line add:

```ts
    // The session's current values (cookie jar spec §5.2), laid over committed ones by the engine.
    ...(located.current !== undefined ? { current: located.current } : {}),
```

  - `apps/desktop/src/main/workspace-service.ts`:
    - Add `import type { CurrentValuesStore } from './current-values.js';`.
    - In `WorkspaceServiceDeps`, after `secretScans`, add:

```ts
  /** The session's current values, which every host's sends and previews read. Omitted in tests. */
  readonly currentValues?: Pick<CurrentValuesStore, 'overlaysFor'>;
```

    - After the `host.setWorkspaceContext(() => { … });` call, add:

```ts
    // Read afresh on every resolution, like the workspace context, so a value typed a moment ago applies.
    host.setCurrentValues(() => this.deps.currentValues?.overlaysFor(entry.projectId));
```

  - `apps/desktop/src/main/index.ts`:
    - Add the imports `import { CurrentValuesStore } from './current-values.js';` and `import { registerCurrentValuesChannels } from './ipc/current-values.js';`, and add `overlayCurrent` to the existing `'@wirebench/engine'` import.
    - After the `cookieStore` definition, add:

```ts
/** The session's current values (cookie jar spec §5): in memory per workspace, never written anywhere. */
const currentValues = new CurrentValuesStore((state) => {
  broadcast(events.currentValues.changed, state);
});
```

    - In the `WorkspaceService({ … })` deps, after `history: historyService,`, add `currentValues,`.
    - In its hooks:
      - In `onChanged`, after the `cookieStore.switchTo` call, add `currentValues.syncWorkspace(workspace);`.
      - In `onProjectChanged`, after `secretScans.projectChanged(projectId, project);`, add `currentValues.syncProject(projectId, project);`.
      - In `onDeleted`, after the `cookieStore.deleteWorkspace` line, add `currentValues.forgetWorkspace(workspaceId);`.
    - Replace `requestDeps.adHocScopes` with:

```ts
    adHocScopes: () => {
      const state = globalProperties.get();
      const global = overlayCurrent(
        enabledProperties(state.properties, state.disabled),
        currentValues.overlaysFor(undefined).global,
      );
      return { project: {}, global, system: process.env };
    },
```

    - Change `registerGlobalsChannels(globalProperties, (state) => { broadcast(events.globals.changed, state); });` to also call `currentValues.syncGlobals(state);` inside the callback. After it, add:

```ts
  registerCurrentValuesChannels(currentValues);
  // The committed globals a global current value needs, once the file has been read.
  void globalProperties
    .ready()
    .then(() => {
      currentValues.syncGlobals(globalProperties.get());
    })
    .catch(() => undefined);
```

- [ ] **Step 6: Test API defaults.** In `apps/desktop/test/mocks/wirebench-api.ts`, add after the `cookies` defaults:

```ts
    currentValues: {
      get: vi.fn().mockResolvedValue({ ok: true, value: { scopes: [] } }),
      set: fail('currentValues.set'),
      reset: fail('currentValues.reset'),
    },
```

- [ ] **Step 7: Run to see it pass.** Same command as Step 2, plus `apps/desktop/test/send-host.test.ts apps/desktop/test/workspace-service.test.ts` → PASS. `pnpm typecheck` passes.

- [ ] **Step 8: Gate and commit.**

```bash
WIREBENCH_SKIP_PERF=1 pnpm check
git add apps/desktop/src/shared/current-value-keys.ts apps/desktop/src/shared/wire-types.ts apps/desktop/src/shared/ipc.ts apps/desktop/src/main/current-values.ts apps/desktop/src/main/ipc/current-values.ts apps/desktop/src/main/project-host.ts apps/desktop/src/main/send/exchange.ts apps/desktop/src/main/workspace-service.ts apps/desktop/src/main/index.ts apps/desktop/test/mocks/wirebench-api.ts apps/desktop/test/current-values.test.ts apps/desktop/test/ipc-current-values.test.ts apps/desktop/test/project-host-env.test.ts
git commit -m "feat(desktop): session-only current values that sends and previews resolve (#44)"
```


### Task 10: The Current column

**Files:**
- Create: `apps/desktop/src/renderer/state/current-values.ts`
- Modify: `apps/desktop/src/renderer/features/environments/variables-table.tsx`
- Modify: `apps/desktop/src/renderer/features/environments/environment-page.tsx` (`GlobalsPage`, `WorkspacePage`, `EnvironmentScopePage`)
- Modify: `apps/desktop/src/renderer/features/project/project-tab.tsx`
- Modify: `apps/desktop/src/renderer/shell/app-shell.tsx` (~line 276), `apps/desktop/src/renderer/shell/code-panel.tsx`, `apps/desktop/src/renderer/features/rest-editor/rest-editor.tsx` (preflight effect deps)
- Test: `apps/desktop/test/renderer/variables-table.test.tsx`; `apps/desktop/test/renderer/environment-page.test.tsx`; `apps/desktop/test/renderer/current-values-store.test.ts` (create)

**Interfaces:**
- Consumes: channels `currentValues.*`, event `currentValues.changed`, `ScopeKeyWire`, `CurrentValuesStateWire` (Task 9); `scopeKeyString` (Task 9).
- Produces:
  - `useCurrentValuesStore` (`byScope: Readonly<Record<string, PropertyMapWire>>`, `load`, `set(key, name, value)`, `reset(key, name?)`, `applyState`), `useCurrentValues(key: ScopeKeyWire | undefined): PropertyMapWire`, `subscribeToCurrentValues(): () => void`
  - `interface CurrentColumn { values: PropertyMapWire; onSet(name, value): void; onReset(name?: string): void }`, `VariablesTableTarget.current?: CurrentColumn`, `InheritedScope.current?: PropertyMapWire`

- [ ] **Step 1: Write the failing tests.** Create `apps/desktop/test/renderer/current-values-store.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCurrentValuesStore } from '../../src/renderer/state/current-values.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

afterEach(() => {
  useCurrentValuesStore.setState({ byScope: {} });
});

describe('useCurrentValuesStore', () => {
  it('asks main for every change and mirrors its answer by scope', async () => {
    const answer = { ok: true, value: { scopes: [{ key: { scope: 'workspace' }, values: { host: 'mine' } }] } };
    const set = vi.fn().mockResolvedValue(answer);
    const reset = vi.fn().mockResolvedValue({ ok: true, value: { scopes: [] } });
    installWirebenchApi({ currentValues: { set, reset } });

    await useCurrentValuesStore.getState().set({ scope: 'workspace' }, 'host', 'mine');
    expect(set).toHaveBeenCalledWith({ key: { scope: 'workspace' }, name: 'host', value: 'mine' });
    expect(useCurrentValuesStore.getState().byScope).toEqual({ workspace: { host: 'mine' } });

    await useCurrentValuesStore.getState().reset({ scope: 'workspace' });
    expect(reset).toHaveBeenCalledWith({ key: { scope: 'workspace' } });
    expect(useCurrentValuesStore.getState().byScope).toEqual({});
  });
});
```

  In `apps/desktop/test/renderer/variables-table.test.tsx`, add `import { useSecretsVisibilityStore } from '../../src/renderer/state/secrets-visibility.js';` and append:

```tsx
describe('VariablesTable — the Current column', () => {
  function withCurrent(values: Record<string, string> = {}) {
    const onSet = vi.fn();
    const onReset = vi.fn();
    return { current: { values, onSet, onReset }, onSet, onReset };
  }

  afterEach(() => {
    cleanup();
    useSecretsVisibilityStore.setState({ show: false });
  });

  it('shows the committed value as a placeholder, and sets a current value on Enter', () => {
    const { current, onSet } = withCurrent();
    renderTable(baseTarget({ current }));
    const cell = screen.getByLabelText<HTMLInputElement>('Current value of host');
    expect(cell.value).toBe('');
    expect(cell.placeholder).toBe('one.test');
    fireEvent.change(cell, { target: { value: 'mine.test' } });
    fireEvent.keyDown(cell, { key: 'Enter' });
    expect(onSet).toHaveBeenCalledWith('host', 'mine.test');
  });

  it('removes the override when the committed value is committed', () => {
    const { current, onSet, onReset } = withCurrent({ host: 'mine.test' });
    renderTable(baseTarget({ current }));
    const cell = screen.getByLabelText<HTMLInputElement>('Current value of host');
    expect(cell.value).toBe('mine.test');
    fireEvent.change(cell, { target: { value: 'one.test' } });
    fireEvent.blur(cell);
    expect(onReset).toHaveBeenCalledWith('host');
    expect(onSet).not.toHaveBeenCalled();
  });

  it('removes the override when the cell is emptied', () => {
    const { current, onReset } = withCurrent({ host: 'mine.test' });
    renderTable(baseTarget({ current }));
    const cell = screen.getByLabelText<HTMLInputElement>('Current value of host');
    fireEvent.change(cell, { target: { value: '' } });
    fireEvent.keyDown(cell, { key: 'Enter' });
    expect(onReset).toHaveBeenCalledWith('host');
  });

  it('marks an overridden row, and resets one value or all of them', () => {
    const { current, onReset } = withCurrent({ host: 'mine.test' });
    renderTable(baseTarget({ properties: { host: 'one.test', port: '80' }, current }));
    expect(screen.getAllByTestId('env-variable-current-dot')).toHaveLength(1);
    expect(screen.getByLabelText('Current value set for this session')).toBeTruthy();
    fireEvent.click(screen.getByTestId('env-variable-current-reset'));
    expect(onReset).toHaveBeenCalledWith('host');
    fireEvent.click(screen.getByTestId('env-current-reset-all'));
    expect(onReset).toHaveBeenLastCalledWith();
  });

  it('disables Reset current values while nothing is overridden', () => {
    const { current } = withCurrent();
    renderTable(baseTarget({ current }));
    expect(screen.getByTestId<HTMLButtonElement>('env-current-reset-all').disabled).toBe(true);
  });

  it("shows an inherited row's current value, marked and read-only", () => {
    const { current } = withCurrent();
    renderTable(
      baseTarget({
        properties: {},
        current,
        inherited: [scope({ label: 'Workspace', properties: { region: 'eu' }, current: { region: 'us' } })],
      }),
    );
    const cell = screen.getByLabelText<HTMLInputElement>('Current value of region');
    expect(cell.value).toBe('us');
    expect(cell.readOnly).toBe(true);
    expect(screen.getAllByTestId('env-variable-current-dot')).toHaveLength(1);
    expect(screen.queryByTestId('env-variable-current-reset')).toBeNull();
  });

  it('masks the Current cell of a secret variable while secrets are hidden', () => {
    const { current } = withCurrent({ token: 'typed-secret' });
    renderTable(baseTarget({ properties: { token: '${secret:api}' }, current }));
    expect(screen.getByLabelText<HTMLInputElement>('Current value of token').type).toBe('password');
    cleanup();
    useSecretsVisibilityStore.setState({ show: true });
    renderTable(baseTarget({ properties: { token: '${secret:api}' }, current }));
    expect(screen.getByLabelText<HTMLInputElement>('Current value of token').type).toBe('text');
  });

  it('has no Current column without a current target', () => {
    renderTable(baseTarget());
    expect(screen.queryAllByTestId('env-variable-current')).toHaveLength(0);
  });
});
```

  In `apps/desktop/test/renderer/environment-page.test.tsx`, add `waitFor` to the `@testing-library/react` import, plus `import { useCurrentValuesStore } from '../../src/renderer/state/current-values.js';` and `import { installWirebenchApi } from '../mocks/wirebench-api.js';`, and append:

```tsx
describe('EnvironmentPage — current values', () => {
  afterEach(() => {
    cleanup();
    useCurrentValuesStore.setState({ byScope: {} });
    useGlobalsStore.setState({ properties: {}, disabled: [] });
    useWorkspaceStore.setState({ workspace: null });
  });

  it('gives Globals a Current column bound to the global scope', async () => {
    const set = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { scopes: [{ key: { scope: 'global' }, values: { token: 'mine' } }] } });
    installWirebenchApi({ currentValues: { set } });
    useGlobalsStore.setState({ properties: { token: 'abc' }, disabled: [] });
    renderPage({ kind: 'globals' });
    const cell = screen.getByLabelText<HTMLInputElement>('Current value of token');
    expect(cell.placeholder).toBe('abc');
    fireEvent.change(cell, { target: { value: 'mine' } });
    fireEvent.keyDown(cell, { key: 'Enter' });
    await waitFor(() => {
      expect(set).toHaveBeenCalledWith({ key: { scope: 'global' }, name: 'token', value: 'mine' });
    });
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Current value of token').value).toBe('mine');
    });
  });

  it("shows a global's current value on the Workspace page's inherited row", () => {
    installWirebenchApi();
    useWorkspaceStore.setState({ workspace: workspaceWire({}) });
    useGlobalsStore.setState({ properties: { region: 'eu' }, disabled: [] });
    useCurrentValuesStore.setState({ byScope: { global: { region: 'us' } } });
    renderPage({ kind: 'workspace' });
    expect(screen.getByLabelText<HTMLInputElement>('Current value of region').value).toBe('us');
  });
});
```

- [ ] **Step 2: Run to see it fail.**

```bash
pnpm vitest run apps/desktop/test/renderer/current-values-store.test.ts apps/desktop/test/renderer/variables-table.test.tsx apps/desktop/test/renderer/environment-page.test.tsx
```

  Expected: FAIL.

- [ ] **Step 3: The mirror.** Create `apps/desktop/src/renderer/state/current-values.ts`:

```ts
import { create } from 'zustand';
import { scopeKeyString } from '../../shared/current-value-keys.js';
import type { CurrentValuesStateWire, PropertyMapWire, ScopeKeyWire } from '../../shared/wire-types.js';
import { ipc } from './ipc-client.js';

/**
 * The renderer's mirror of the session's current values (cookie jar spec §5.3), keyed by
 * `scopeKeyString`. Main is the only writer and keeps them in memory only; every action takes the
 * whole state main answers, and `currentValues.changed` keeps every window in step.
 */
export interface CurrentValuesStore {
  readonly byScope: Readonly<Record<string, PropertyMapWire>>;
  readonly load: () => Promise<void>;
  readonly set: (key: ScopeKeyWire, name: string, value: string) => Promise<void>;
  /** Resets one current value, or every one of the scope when `name` is omitted. */
  readonly reset: (key: ScopeKeyWire, name?: string) => Promise<void>;
  readonly applyState: (state: CurrentValuesStateWire) => void;
}

function byScopeOf(state: CurrentValuesStateWire): Record<string, PropertyMapWire> {
  return Object.fromEntries(state.scopes.map((scope) => [scopeKeyString(scope.key), scope.values]));
}

export const useCurrentValuesStore = create<CurrentValuesStore>((set) => ({
  byScope: {},

  applyState: (state) => {
    set({ byScope: byScopeOf(state) });
  },

  load: async () => {
    const result = await ipc().currentValues.get(undefined);
    if (result.ok) {
      set({ byScope: byScopeOf(result.value) });
    }
  },

  set: async (key, name, value) => {
    const result = await ipc().currentValues.set({ key, name, value });
    if (result.ok) {
      set({ byScope: byScopeOf(result.value) });
    }
  },

  reset: async (key, name) => {
    const result = await ipc().currentValues.reset({ key, ...(name !== undefined ? { name } : {}) });
    if (result.ok) {
      set({ byScope: byScopeOf(result.value) });
    }
  },
}));

/** A stable empty map, so a scope with no current values never re-renders its table. */
const NONE: PropertyMapWire = {};

/** One scope's current values (`undefined`: no scope, so none). */
export function useCurrentValues(key: ScopeKeyWire | undefined): PropertyMapWire {
  const id = key === undefined ? undefined : scopeKeyString(key);
  return useCurrentValuesStore((state) => (id === undefined ? NONE : (state.byScope[id] ?? NONE)));
}

/** Pulls the state and follows `currentValues.changed`. Returns an unsubscribe. */
export function subscribeToCurrentValues(): () => void {
  void useCurrentValuesStore.getState().load();
  return window.wirebench.on('currentValues.changed', ((payload: CurrentValuesStateWire) => {
    useCurrentValuesStore.getState().applyState(payload);
  }) as (payload: unknown) => void);
}
```

  In `apps/desktop/src/renderer/shell/app-shell.tsx`, import `subscribeToCurrentValues` from `'../state/current-values.js'` and add `useEffect(() => subscribeToCurrentValues(), []);` after `useEffect(() => subscribeToGlobals(), []);`.

- [ ] **Step 4: The column.** In `apps/desktop/src/renderer/features/environments/variables-table.tsx`:
  - Change the imports to:

```tsx
import { useRef, useState } from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
import { IconButton } from '../../components/icon-button.js';
import { KV_INPUT_CLASS, useCommittedDraft } from '../../components/kv-table.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { useSecretsVisibilityStore } from '../../state/secrets-visibility.js';
import type { PropertyMapWire } from '../../../shared/wire-types.js';
```

  - In `InheritedScope`, after `disabled`, add:

```ts
  /** That scope's current values, shown (read-only) on its inherited rows. */
  readonly current?: PropertyMapWire;
```

  - Before `VariablesTableTarget`, add:

```ts
/** The Current column (cookie jar spec §6): session-only values laid over this scope's committed ones. */
export interface CurrentColumn {
  /** This scope's current values, by name. */
  readonly values: PropertyMapWire;
  readonly onSet: (name: string, value: string) => void;
  /** Resets one name's current value, or every one of the scope when `name` is omitted. */
  readonly onReset: (name?: string) => void;
}
```

  - In `VariablesTableTarget`, after `emptyMessage`, add:

```ts
  /** The Current column. Absent: the table has none. */
  readonly current?: CurrentColumn;
```

  - After `const INPUT_CLASS = KV_INPUT_CLASS;`, add:

```tsx
const SECRET_TOKEN = /\$\{secret:/;
const MASKED = '••••••';
const CURRENT_NOTE = 'Current value set for this session';

/** The Current cell's state for one row; `undefined` when the table has no Current column. */
interface CurrentCellProps {
  /** The current value, or `undefined` when the committed value applies. */
  readonly current: string | undefined;
  /** Masked like a secret's Value while secrets are hidden. */
  readonly masked: boolean;
  /** An inherited row's: shown, never edited here. */
  readonly readOnly: boolean;
  readonly onCommit: (next: string) => void;
  readonly onReset: () => void;
}

function CurrentDot() {
  return (
    <span
      role="img"
      aria-label={CURRENT_NOTE}
      title={CURRENT_NOTE}
      data-testid="env-variable-current-dot"
      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
    />
  );
}

/** One Current cell: empty shows the committed value as its placeholder, and that value applies. */
function CurrentCell({
  name,
  committed,
  current,
  masked,
  readOnly,
  onCommit,
  onReset,
}: CurrentCellProps & { readonly name: string; readonly committed: string }) {
  const field = useCommittedDraft(current ?? '', onCommit);
  return (
    <td className="px-2 py-1">
      <div className="flex items-center gap-1">
        <input
          aria-label={`Current value of ${name}`}
          data-testid="env-variable-current"
          className={INPUT_CLASS}
          type={masked ? 'password' : 'text'}
          placeholder={masked ? MASKED : committed}
          readOnly={readOnly}
          title={readOnly ? 'Set it on the scope it comes from' : 'Session only: never saved, never shared'}
          {...field}
        />
        {current !== undefined && !readOnly && (
          <IconButton label={`Reset current value of ${name}`} data-testid="env-variable-current-reset" onClick={onReset}>
            <RotateCcw size={13} aria-hidden="true" />
          </IconButton>
        )}
      </div>
    </td>
  );
}
```

  - In `RowProps`, add `readonly currentCell: CurrentCellProps | undefined;`. In `VariableRow`, destructure `currentCell`, replace the name cell with:

```tsx
      <td className="px-2 py-1">
        <div className="flex items-center gap-1">
          <input aria-label={`Name of ${name}`} data-testid="env-variable-name" className={INPUT_CLASS} {...nameField} />
          {currentCell?.current !== undefined && <CurrentDot />}
        </div>
      </td>
```

    and after the Value `<td>…</td>` add:

```tsx
      {currentCell !== undefined && <CurrentCell name={name} committed={value} {...currentCell} />}
```

  - In `InheritedRowProps`, add `readonly currentCell: CurrentCellProps | undefined;`. Make the same two changes in `InheritedVariableRow`: wrap its name input with the dot, and add the `CurrentCell` after its Value cell, with `committed={value}`.
  - In `VariablesTable`, add `current` to the destructured `target` fields. After `const disabledSet = new Set(disabled);`, add:

```tsx
  const showSecrets = useSecretsVisibilityStore((state) => state.show);
  const columns = current === undefined ? 5 : 6;
  const masks = (committed: string): boolean => !showSecrets && SECRET_TOKEN.test(committed);

  /** Commits a typed current value: empty, or the committed value itself, removes the override. */
  const commitCurrent = (name: string, committed: string, next: string): void => {
    if (current === undefined) {
      return;
    }
    if (next === '' || next === committed) {
      if (Object.hasOwn(current.values, name)) {
        current.onReset(name);
      }
      return;
    }
    current.onSet(name, next);
  };
```

  - Replace every `colSpan={5}` with `colSpan={columns}` (three places).
  - In `<colgroup>`, after the `<col />` of Value, add `{current !== undefined && <col className="w-[22%]" />}`.
  - In the header row, after `<th className="px-2 py-1.5 font-medium">Value</th>`, add:

```tsx
              {current !== undefined && (
                <th className="px-2 py-1.5 font-medium">
                  <div className="flex items-center gap-1">
                    <span title="Session only: never saved, never shared">Current</span>
                    <IconButton
                      label="Reset current values"
                      data-testid="env-current-reset-all"
                      disabled={Object.keys(current.values).length === 0}
                      onClick={() => {
                        current.onReset();
                      }}
                    >
                      <RotateCcw size={12} aria-hidden="true" />
                    </IconButton>
                  </div>
                </th>
              )}
```

  - In `names.map(…)`, pass to `VariableRow`:

```tsx
                  currentCell={
                    current === undefined
                      ? undefined
                      : {
                          current: current.values[name],
                          masked: masks(properties[name] ?? ''),
                          readOnly: false,
                          onCommit: (next) => {
                            commitCurrent(name, properties[name] ?? '', next);
                          },
                          onReset: () => {
                            current.onReset(name);
                          },
                        }
                  }
```

  - In `inheritedOnlyNames.map(…)`, pass to `InheritedVariableRow`:

```tsx
                  currentCell={
                    current === undefined
                      ? undefined
                      : {
                          current: owner.current?.[name],
                          masked: masks(ownerValue),
                          readOnly: true,
                          onCommit: () => undefined,
                          onReset: () => undefined,
                        }
                  }
```

  - In the add row, after its value `<td>…</td>`, add `{current !== undefined && <td className="px-2 py-1" />}`.

- [ ] **Step 5: Bind every scope.** In `apps/desktop/src/renderer/features/environments/environment-page.tsx`:
  - Change the variables-table import to `import { VariablesTable, type CurrentColumn, type InheritedScope, type VariablesTableTarget } from './variables-table.js';`, and add:

```tsx
import { useCurrentValues, useCurrentValuesStore } from '../../state/current-values.js';
import type { PropertyMapWire, ScopeKeyWire } from '../../../shared/wire-types.js';
```

  - Before `GlobalsPage`, add:

```tsx
/** One scope's Current column: its values and the two writes, through the session store (spec §6). */
function currentColumn(key: ScopeKeyWire, values: PropertyMapWire): CurrentColumn {
  return {
    values,
    onSet: (name, value) => {
      void useCurrentValuesStore.getState().set(key, name, value);
    },
    onReset: (name) => {
      void useCurrentValuesStore.getState().reset(key, name);
    },
  };
}
```

  - `GlobalsPage`: add `const current = useCurrentValues({ scope: 'global' });` with the other hooks, and `current: currentColumn({ scope: 'global' }, current),` to its target.
  - `WorkspacePage`: add `const current = useCurrentValues({ scope: 'workspace' });` and `const globalsCurrent = useCurrentValues({ scope: 'global' });`. Give the inherited Globals scope `current: globalsCurrent`, and add `current: currentColumn({ scope: 'workspace' }, current),` to the target.
  - `EnvironmentScopePage`: after the `projectId` hook add:

```tsx
  const environmentKey: ScopeKeyWire | undefined =
    workspaceEnvironment !== undefined
      ? { scope: 'workspaceEnvironment', environmentId }
      : projectId !== undefined
        ? { scope: 'projectEnvironment', projectId, environmentId }
        : undefined;
  const environmentCurrent = useCurrentValues(environmentKey);
  const projectCurrent = useCurrentValues(projectId === undefined ? undefined : { scope: 'project', projectId });
  const workspaceCurrent = useCurrentValues({ scope: 'workspace' });
  const globalsCurrent = useCurrentValues({ scope: 'global' });
```

    Give the three `inherited` entries `current: projectCurrent`, `current: workspaceCurrent` and `current: globalsCurrent` respectively. Add `...(environmentKey !== undefined ? { current: currentColumn(environmentKey, environmentCurrent) } : {}),` to both target objects (the workspace-scoped one and the linked-project one).
  - `apps/desktop/src/renderer/features/project/project-tab.tsx`: import `useCurrentValues` and `useCurrentValuesStore` from `'../../state/current-values.js'`, and `type CurrentColumn` with the variables-table import. After `const globalsDisabled = …;` (before the early return) add:

```tsx
  const current = useCurrentValues({ scope: 'project', projectId });
  const workspaceCurrent = useCurrentValues({ scope: 'workspace' });
  const globalsCurrent = useCurrentValues({ scope: 'global' });
```

    Give the inherited Workspace and Globals scopes `current: workspaceCurrent` and `current: globalsCurrent`, and add to `propertiesTarget`:

```tsx
    current: {
      values: current,
      onSet: (name, value) => {
        void useCurrentValuesStore.getState().set({ scope: 'project', projectId }, name, value);
      },
      onReset: (name) => {
        void useCurrentValuesStore.getState().reset({ scope: 'project', projectId }, name);
      },
    } satisfies CurrentColumn,
```

- [ ] **Step 6: Previews follow a change.** Main resolves with the current values, but the renderer only re-asks when its inputs change:
  - `apps/desktop/src/renderer/shell/code-panel.tsx`: import `useCurrentValuesStore`, add `const currentValues = useCurrentValuesStore((state) => state.byScope);` next to `globalProperties`, and add `currentValues,` as the last element of `draftKey`, `restDraftKey`, `grpcDraftKey` and `wsDraftKey`.
  - `apps/desktop/src/renderer/features/rest-editor/rest-editor.tsx`: import `useCurrentValuesStore`, add `const currentValues = useCurrentValuesStore((state) => state.byScope);` after `activeEnvironment`, and change the preflight effect's dependency list to `[requestId, url, activeEnvironment, webhookCollection, folders, currentValues]`.

- [ ] **Step 7: Run to see it pass.** Same command as Step 2, plus `apps/desktop/test/renderer/project-tab.test.tsx apps/desktop/test/renderer/code-panel.test.tsx apps/desktop/test/renderer/rest-editor.test.tsx` → PASS.

- [ ] **Step 8: Gate and commit.**

```bash
WIREBENCH_SKIP_PERF=1 pnpm check
git add apps/desktop/src/renderer/state/current-values.ts apps/desktop/src/renderer/features/environments/variables-table.tsx apps/desktop/src/renderer/features/environments/environment-page.tsx apps/desktop/src/renderer/features/project/project-tab.tsx apps/desktop/src/renderer/shell/app-shell.tsx apps/desktop/src/renderer/shell/code-panel.tsx apps/desktop/src/renderer/features/rest-editor/rest-editor.tsx apps/desktop/test/renderer/current-values-store.test.ts apps/desktop/test/renderer/variables-table.test.tsx apps/desktop/test/renderer/environment-page.test.tsx
git commit -m "feat(desktop): a Current column in every variables table, for session-only values (#44)"
```


### Task 11: e2e (CI only)

**Files:**
- Create: `e2e/specs/cookie-jar.spec.ts`

**Interfaces:**
- Consumes: test ids `rest-setting-send-cookies`, `rest-cookie-jar`, `cookie-manager`, `cookie-row`, `env-variable-current`, `env-variable-current-dot` (Tasks 6, 7, 10); command "Show Cookies" (Task 6); e2e helpers `launchApp`, `createWorkspace`, `createProject`, `createApi`, `createRestRequest`, `setMethodAndUrl`, `openRequestTab`, `addHeader`, `sendRest`, `responseStatus`, `openResponseTab`, `openEnvironmentsView`, `environmentRow`, `setVariable`, `runCommand`.
- Produces: nothing.

This spec is not run locally (no Electron windows while the owner works). CI runs it; locally, only `pnpm check` (which type-checks and lints it) runs.

- [ ] **Step 1: Write the spec.** Create `e2e/specs/cookie-jar.spec.ts`:

```ts
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace } from '../helpers/project.js';
import {
  addHeader,
  createApi,
  createRestRequest,
  openRequestTab,
  openResponseTab,
  responseStatus,
  sendRest,
  setMethodAndUrl,
} from '../helpers/rest.js';
import { environmentRow, openEnvironmentsView, setVariable } from '../helpers/environments.js';
import { runCommand } from '../helpers/palette.js';

/** Every request the server saw: its path, its Cookie header and its X-Token header. */
interface Seen {
  readonly path: string;
  readonly cookie: string | undefined;
  readonly token: string | undefined;
}

function headerOf(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
}

test.describe('Cookie jar and current values (#44)', () => {
  let launched: LaunchedApp | undefined;
  let server: Server | undefined;
  const seen: Seen[] = [];

  test.afterEach(async () => {
    try {
      await launched?.close();
    } finally {
      launched = undefined;
      const open = server;
      server = undefined;
      seen.length = 0;
      await new Promise<void>((resolve) => (open ? open.close(() => resolve()) : resolve()));
    }
  });

  async function startServer(): Promise<string> {
    server = createServer((request, response) => {
      const path = request.url ?? '';
      seen.push({ path, cookie: headerOf(request, 'cookie'), token: headerOf(request, 'x-token') });
      if (path === '/login') {
        response.writeHead(200, { 'set-cookie': 'sid=abc123; Path=/; HttpOnly', 'content-type': 'text/plain' });
        response.end('logged in');
        return;
      }
      if (path === '/me') {
        const ok = (headerOf(request, 'cookie') ?? '').split(/;\s*/).includes('sid=abc123');
        response.writeHead(ok ? 200 : 401, { 'content-type': 'text/plain' });
        response.end(ok ? 'me' : 'no session');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  test('a login cookie reaches the next request with Send cookies on, and shows in the manager', async () => {
    const origin = await startServer();
    launched = await launchApp();
    const page = launched.window;
    await createWorkspace(page, 'Cookies');
    await createProject(page, 'Session');
    await createApi(page, 'Site', origin);

    await createRestRequest(page, 'Site', 'Login');
    await setMethodAndUrl(page, 'GET', '/login');
    await sendRest(page);
    await expect(responseStatus(page)).toContainText('200');
    await openResponseTab(page, 'Cookies');
    await expect(page.getByTestId('rest-cookie-jar').first()).toContainText('stored');

    await createRestRequest(page, 'Site', 'Me');
    await setMethodAndUrl(page, 'GET', '/me');
    // Off by default: the cookie is in the jar but not sent.
    await sendRest(page);
    await expect(responseStatus(page)).toContainText('401');

    await openRequestTab(page, 'Settings');
    await page.getByTestId('rest-setting-send-cookies').check();
    await sendRest(page);
    await expect(responseStatus(page)).toContainText('200');
    expect(seen.at(-1)).toMatchObject({ path: '/me', cookie: 'sid=abc123' });

    await runCommand(page, 'Show Cookies');
    await expect(page.getByTestId('cookie-manager')).toBeVisible();
    const row = page.getByTestId('cookie-row').filter({ hasText: 'sid' });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('127.0.0.1');
    // The value is masked until asked.
    await expect(row).not.toContainText('abc123');
  });

  test('a current value replaces the committed one for the next send, until reset', async () => {
    const origin = await startServer();
    launched = await launchApp();
    const page = launched.window;
    await createWorkspace(page, 'Current');
    await createProject(page, 'Values');
    await createApi(page, 'Site', origin);

    await openEnvironmentsView(page);
    await environmentRow(page, 'Workspace').click();
    await setVariable(page, 'token', 'committed');

    await page.getByRole('button', { name: 'Explorer', exact: true }).click();
    await createRestRequest(page, 'Site', 'Echo');
    await setMethodAndUrl(page, 'GET', '/echo');
    await addHeader(page, 'X-Token', '${token}');
    await sendRest(page);
    await expect(responseStatus(page)).toContainText('200');
    expect(seen.at(-1)?.token).toBe('committed');

    await openEnvironmentsView(page);
    await environmentRow(page, 'Workspace').click();
    const current = page.getByLabel('Current value of token');
    await expect(current).toHaveAttribute('placeholder', 'committed');
    await current.fill('session-only');
    await current.press('Enter');
    await expect(page.getByTestId('env-variable-current-dot')).toHaveCount(1);

    await page.getByRole('button', { name: 'Explorer', exact: true }).click();
    await page.getByRole('tab', { name: /Echo/ }).click();
    await sendRest(page);
    await expect.poll(() => seen.at(-1)?.token).toBe('session-only');

    await openEnvironmentsView(page);
    await environmentRow(page, 'Workspace').click();
    await page.getByTestId('env-current-reset-all').click();
    await expect(page.getByTestId('env-variable-current-dot')).toHaveCount(0);

    await page.getByRole('button', { name: 'Explorer', exact: true }).click();
    await page.getByRole('tab', { name: /Echo/ }).click();
    await sendRest(page);
    await expect.poll(() => seen.at(-1)?.token).toBe('committed');
  });
});
```

- [ ] **Step 2: Type-check and lint only.**

```bash
WIREBENCH_SKIP_PERF=1 pnpm check
```

  Expected: green. Do not run `pnpm test:e2e` locally; CI runs the spec on the pull request. If CI fails on a helper detail (the editor tab's accessible name, the Explorer button), fix the selector from the CI trace, not by running Electron locally.

- [ ] **Step 3: Commit.**

```bash
git add e2e/specs/cookie-jar.spec.ts
git commit -m "test(e2e): the cookie jar across two sends, the manager, and a current value (#44)"
```

### Task 12: Documentation

**Files:**
- Modify: `docs-site/src/content/docs/guides/rest-client.mdx`, `docs-site/src/content/docs/guides/environments.mdx`, `docs-site/src/content/docs/guides/sequences.mdx`
- Modify: `docs/cli.md`, `docs/security.md`, `docs/roadmap.md`, `CHANGELOG.md`
- Modify: `docs/specs/2026-09-13-wirebench-rest-client-design.md`, `docs/specs/2026-09-12-wirebench-layout-and-environments-design.md`

**Interfaces:**
- Consumes: behaviour from Tasks 1–10.
- Produces: nothing.

- [ ] **Step 1: The REST client guide.** In `rest-client.mdx`, after the paragraph that starts `**Preview** also renders an HTML body` (in `## Send and read the response`), insert:

```mdx
Cookies a response sets go into the workspace's cookie jar, hop by hop through redirects. A request
sends the jar's matching cookies only when its **Send cookies** setting (Settings tab) is on; it is
off by default. A `Cookie` header you set by hand still goes out, and wins over a jar cookie of the
same name. The response's **Cookies** tab says, for each `Set-Cookie`, whether it was stored,
deleted from the jar, or ignored and why (a domain the host does not match, a `Secure` cookie over
http, a cookie over 4 KB).
```

  Replace the event-stream bullet

```mdx
- Cookies a stream's `Set-Cookie` headers set are remembered once the stream ends, as for any other
  response.
```

  with

```mdx
- Cookies a stream's `Set-Cookie` headers set go into the jar as soon as the headers arrive, as for
  any other response.
```

  Before `## Limits`, insert:

```mdx
## Cookies

**View → Show Cookies**, **Cookies…** in the Environments view, or **Manage cookies** on a
response's Cookies tab opens the workspace's cookie jar in a tab. Cookies are grouped by domain;
values stay masked until you choose **Show values**. You can add a cookie, edit one, delete one or a
whole domain, or **Clear all** after confirming.

- Each workspace has its own jar. Opening another workspace switches jars.
- Cookies with an expiry are kept across restarts, encrypted with the system keychain. Session
  cookies (no `Expires` or `Max-Age`) last until you quit. When the system has no secure storage,
  nothing is written and the tab says so.
- The jar never reaches the project folder, a shared workspace's repository or a Wirebench server.
- A domain may hold 50 cookies and the jar 3,000; past that, the cookie expiring soonest is dropped first, session cookies last.
- `wirebench run` keeps a jar for the run only; see [Run in CI](/wirebench/docs/guides/run-in-ci/).
```

  In `## Limits`, add the bullet:

```mdx
- The jar has no public-suffix list, so a server can set a cookie for a whole registry domain such
  as `co.uk`. It is sent only from requests with **Send cookies** on.
```

- [ ] **Step 2: The environments guide.** In `environments.mdx`, before `## Endpoint overrides`, insert:

```mdx
## Current values

Every variables table — Globals, Workspace, a project and each environment — has a **Current**
column beside **Value**. A current value replaces the committed value for this session only: it is
never written to the project, the workspace or the keychain, and it is gone when you quit.

- An empty Current cell shows the committed value as a placeholder; that value applies.
- Type into the cell and press <kbd>Enter</kbd> to set a current value. The variable's name gets a
  dot, and every send, preview and the code panel use the current value.
- Empty the cell, or enter the committed value, to go back to it. The reset button in a row resets
  that variable; **Reset current values** in the column header resets the whole table.
- A disabled variable stays absent; its current value does not apply.
- A current value may itself contain `${...}`, which is expanded like any other value.
- Rename a variable and its current value follows; delete it and the current value goes too.
- A secret's Current cell is masked like its Value until you show secrets.
- `wirebench run --var` still wins over both.
```

- [ ] **Step 3: Sequences guide and the CLI reference.** In `sequences.mdx`, replace

```mdx
- Wirebench keeps no shared cookie jar, so a cookie from one step reaches the next only through a
  **Cookie** transfer: `Cookie: sid=${#Sequence#sid}`.
```

  with

```mdx
- REST steps share the run's cookie jar (the workspace's jar in the app), so a REST step with
  **Send cookies** on sends what an earlier step's response set. A **Cookie** transfer
  (`Cookie: sid=${#Sequence#sid}`) is for an explicit move, and is the way to carry a cookie into a
  SOAP, gRPC or WebSocket step.
```

  In `docs/cli.md`, replace

```md
- There is no cookie jar: a login's cookie reaches a later step only through a `cookie` transfer, sent as
  `Cookie: sid=${#Sequence#sid}`.
```

  with

```md
- Each `wirebench run` keeps one cookie jar in memory, shared by every request, sequence step and iteration of
  the run; `wirebench call` keeps one per call, and `wirebench mcp` one for the server's lifetime. A REST request
  with `sendCookies: true` sends the cookies earlier responses in that run set. Nothing is written to disk. A
  `cookie` transfer (`Cookie: sid=${#Sequence#sid}`) still works, and is how a cookie reaches a non-REST step.
```

- [ ] **Step 4: Security.** In `docs/security.md`, before `## Catch URLs take anyone's request`, insert:

```md
## The cookie jar

Responses' cookies are kept in a jar per workspace (#44,
`docs/specs/2026-10-03-wirebench-cookie-jar-and-current-values-design.md`):

- **At rest.** Cookies with an expiry are written to `cookies/<workspace id>.json` in the app's data
  folder, encrypted with the OS keychain (`safeStorage`); without it nothing is written. Session cookies
  never reach disk. The jar never reaches the project folder, a shared workspace's git tree or the server.
  A file from a newer version is left untouched and the jar runs in memory; a corrupt file is set aside
  as `.corrupt`. Tests: `apps/desktop/test/cookie-store.test.ts`.
- **Opt-in sending.** Jar cookies go out only from REST requests with *Send cookies* on (off by
  default), only to a matching domain and path, and `Secure` cookies only over https. An http response
  cannot set or overwrite a `Secure` cookie. Tests: `packages/engine/test/unit/rest/cookie-jar.test.ts`.
- **Per hop.** The jar is matched again for every redirect hop, and a cross-origin hop already drops a
  hand-set `Cookie`, so a redirect to another host gets only that host's cookies. Tests:
  `packages/engine/test/integration/run/rest-exchange.test.ts`.
- **Bounded.** 4 KB per cookie, 50 per domain, 3,000 in all; past that, the cookie expiring soonest goes first, session cookies last.
- **Masking.** `Cookie` and `Set-Cookie` stay redacted in History and logs; the cookie manager masks
  values until asked.
- **Residual risk: no public-suffix list.** A server under `a.example.co.uk` can set `Domain=co.uk`, and
  that cookie then reaches every `*.co.uk` host a request with *Send cookies* on is sent to. Accepted:
  the jar holds your own test traffic, sending is opt-in per request, and a public-suffix list is a
  large, moving dependency.
- **Headless.** `wirebench run`, `call` and `mcp` keep their jar in memory only.

## Current values never touch disk

A variable's current value (#44) is a session-only override of its committed value:

- **Memory only.** Current values live in the main process. They are never written to the project,
  the workspace, the keychain, History, the server or a shared workspace, and are gone on quit. Tests:
  `apps/desktop/test/current-values.test.ts`.
- **User input, not response data.** A current value is typed by the user and expands like a
  committed value; ADR-0015's boundary (a response value is data, never a template) is unchanged.
- **Masked like the value.** A secret's Current cell is masked while secrets are hidden.
```

- [ ] **Step 5: The specs.** In `docs/specs/2026-09-13-wirebench-rest-client-design.md`:
  - After the §3.3 **Cookies** bullet (ending "Nothing about cookies reaches the project folder."), add an indented line:

```md
  _Resolved by_ `docs/specs/2026-10-03-wirebench-cookie-jar-and-current-values-design.md` (#44): a workspace-wide
  jar with a manager replaces the per-request cookies; nothing reaches the project folder still holds.
```

  - After §15 item 4 (ending "is a\n   follow-up."), add:

```md
   _Resolved by_ `docs/specs/2026-10-03-wirebench-cookie-jar-and-current-values-design.md` (#44).
```

  In `docs/specs/2026-09-12-wirebench-layout-and-environments-design.md`, after §12 question 1, add (do not repeat the product name that line already has):

```md
   _Resolved by_ `docs/specs/2026-10-03-wirebench-cookie-jar-and-current-values-design.md` (#44): current values
   are a session-only store in main, with no format change.
```

- [ ] **Step 6: Roadmap.** In `docs/roadmap.md`:
  - Item 8's status: `new; HTML preview shipped (#48)` → `new; HTML preview (#48) and cookie jar with current values (#44) shipped`.
  - Milestone 3.1: `cookie jar and initial/current values` → `cookie jar and initial/current values (**shipped** 2026-10-03)`.
  - The parked **Initial value / Current value split** bullet: replace its body with `Done 2026-10-03 (issue #44): a **Current** column in every variables table, session-only and kept in main; see \`docs/specs/2026-10-03-wirebench-cookie-jar-and-current-values-design.md\`.` and prefix its title `**Initial value / Current value split — done 2026-10-03.**`.
  - Delete the deferred-list bullet **A persistent cookie jar.** (both lines).
  - Replace `The cookie jar and the initial/current value split go together. ` with nothing, so the paragraph starts at `The test steps and assertions extend to`.

- [ ] **Step 7: CHANGELOG.** Under `## [Unreleased]` → `### Added`, before the HTML preview entry, add:

```md
- **Cookie jar.** Cookies responses set go into a jar per workspace, kept across restarts (encrypted
  with the system keychain) except session cookies. A REST request with *Send cookies* on sends the
  matching ones, per redirect hop. **View → Show Cookies** opens a manager to view, add, edit and
  delete them, and the response's Cookies tab says what was stored or ignored. `wirebench run`
  keeps a jar for the run (#44).
- **Current values.** Every variables table has a **Current** column: a session-only value that
  replaces the committed one for sends and previews, and is never written anywhere (#44).
```

- [ ] **Step 8: Check and commit.**

```bash
pnpm -s check:banned-terms
npx prettier --check docs/security.md docs/cli.md docs/roadmap.md CHANGELOG.md docs/specs/2026-09-13-wirebench-rest-client-design.md docs/specs/2026-09-12-wirebench-layout-and-environments-design.md docs-site/src/content/docs/guides/rest-client.mdx docs-site/src/content/docs/guides/environments.mdx docs-site/src/content/docs/guides/sequences.mdx
WIREBENCH_SKIP_PERF=1 pnpm check
git add docs/security.md docs/cli.md docs/roadmap.md CHANGELOG.md docs/specs/2026-09-13-wirebench-rest-client-design.md docs/specs/2026-09-12-wirebench-layout-and-environments-design.md docs-site/src/content/docs/guides/rest-client.mdx docs-site/src/content/docs/guides/environments.mdx docs-site/src/content/docs/guides/sequences.mdx
git commit -m "docs: the cookie jar and current values (#44)"
```

  Expected: banned-terms prints nothing, prettier reports every file formatted (run `--write` on any it flags, then re-check), `pnpm check` green.

## Plan notes

Deviations from the spec, and choices it left open:

1. **Where the jar lives.** The jar types and `CookieJarHost` are in core `http/cookies.ts`, and the `CookieJar` class in `rest/cookie-jar.ts`, because `scripts/engine-import-graph.mjs` forbids core importing a protocol folder. `cookiesToSend` moves into `rest/cookie-jar.ts` (its export from `index.ts` is unchanged) to avoid a `cookies.ts` ↔ `cookie-jar.ts` cycle.
2. **The Cookie header** is built by `mergeCookieHeader`, not `cookieHeader`, so two jar cookies with one name on different paths are both sent (§1.2 ordering); a hand-set pair still wins by name.
3. **The per-hop hook lives in the HTTP client** (`HttpRequest.cookies`). With a jar present, `exchange.request.headers` shows the last attempt's headers. `RestSendInput.cookies` stays for API compatibility.
4. **Current-value overlays are keyed by environment id** (`CurrentValues.workspaceEnvironments` / `projectEnvironments`), not pre-narrowed to the active environment, so the preview, multi-environment send and workspace-linked environments share one shape.
5. **Rename tracking** diffs committed values in main, within one change and across one following change (a name removed then set). Side effect: deleting a variable and at once adding another with the same committed value carries the current value over.
6. **Empty-request channels** take `z.undefined()` (house pattern), not `{}`.
7. **"Cookies…"** is an icon button in the Environments view header, which has no menu. The command is **Show Cookies** in View, like its siblings.
8. **The no-workspace jar** is session-only; `persisted: false` (the "no secure storage" note) is also shown for it and for a jar refused because its file is newer.
9. **Response note wording:** `deleted` reads "deleted from the jar".
10. **Committing an empty Current cell** (or the committed value) resets it.
11. **A standalone project** (no workspace) gets current values for globals only; `setCurrentValues` is wired by `WorkspaceService`.
12. **The status-bar environment switcher** shows no values, so it is unchanged; previews resolve in main and get the overlays.
13. **Inherited rows (D1).** An inherited row shows the committed value in Value and the override in Current.
14. **No secure storage at load (D2).** An existing cookie file is left untouched and the jar is session-only.
15. **Evicted right after storing (D3).** A cookie evicted right after being stored still gets the verdict `stored`.
