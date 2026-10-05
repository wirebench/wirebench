# Plan: Kerberos/SPNEGO authentication

Spec: [`docs/specs/2026-10-05-kerberos-spnego-auth-design.md`](../specs/2026-10-05-kerberos-spnego-auth-design.md)
ADR: [`docs/adr/0019-kerberos-uses-an-optional-native-module.md`](../adr/0019-kerberos-uses-an-optional-native-module.md)
Issue: [#40](https://github.com/wirebench/wirebench/issues/40)

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to carry out this plan task by task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Requests authenticate with the user's Kerberos ticket. A server that answers
`WWW-Authenticate: Negotiate` gets a Kerberos token. This covers SOAP, REST, WebSocket and gRPC
sends, definition fetches, the CLI runner and MCP. On Windows, an explicit account is allowed too.

**Architecture:**
- One engine module loads the optional `kerberos` native binding, and one seam
  (`startKerberosContext`/`kerberosToken`) applies every rule.
- The HTTP transport runs a two-leg Negotiate handshake beside the existing NTLM one.
- Every other path converts the Kerberos credentials, just before sending, into a one-shot
  `Authorization: Negotiate <token>`.
- The desktop app vendors a hash-checked binary per architecture and points the engine at it at
  start-up.

**Tech stack:**
- TypeScript (ESM, `.js` import suffixes), zod 4, undici 8, `kerberos@7.0.0` (N-API v9).
- vitest, React, Electron IPC (`defineChannel`), electron-builder, GitHub Actions.
- An apt-installed MIT KDC, in CI only.

## Global constraints

- **Gate before every commit:** `WIREBENCH_SKIP_PERF=1 pnpm check`.
  - While `git-worktrees/` holds full checkouts, `eslint .` can run out of heap. Run the chain with
    `pnpm exec eslint . --max-warnings 0 --ignore-pattern 'git-worktrees/**'` in place of
    `pnpm lint`'s eslint half.
  - `pnpm test:perf` runs unskipped before every push.
  - Do not open local Electron windows while the owner works; CI runs e2e.
- **Commits:** one per task, after the gate is green.
  - Commit as Mohammed Naami <m.naami@outlook.com>.
  - No `Co-Authored-By:` or `Claude-Session:` trailer.
  - PR descriptions have no generated-by footer.
- **Product names:** never name the product that inspired a feature. `pnpm check:banned-terms`
  enforces this.
- **Dependencies:** `kerberos` is the only new dependency, pinned to exactly `7.0.0`
  (ADR-0019). The KDC packages are apt-installed in one CI job only.
- **Mechanism:** always `GSS_MECH_OID_KRB5` (9), never SPNEGO and never NTLM (spec R4).
- **Flags:** always `GSS_C_MUTUAL_FLAG` (2), and never `GSS_C_DELEG_FLAG`.
- **Explicit credentials:** on macOS and Linux, a `username` or `password` is refused before any
  network traffic (spec R2).
- **Secrets:** no plaintext `password` in a project file or over IPC (ADR-0004). Only
  `passwordRef`/`passwordEnv`.
- **Renderer imports:** the renderer imports `shared/wire-types.ts` for **types only**. It never
  imports the engine's root entry, nor any module that loads the binding.
- **Format:** `FORMAT_VERSION` 7 → 8, with a no-op migration.
- **Merging:** `gh pr merge --merge` (never squash), only after CI is green on the latest head.
  Never use `--auto`.

## Spec amendments made with this plan

The plan PR also edits the spec where the code disagrees with it. The amendments are listed here so a
reviewer sees them in one place.

1. **Binding option names (§ Facts, D1).** The package's `index.d.ts` documents `gssFlag` and `pass`,
   but the C++ reads `flags`, `user`, `domain` and `password` on Windows
   (`src/win32/kerberos_win32.cc:131–147`), and `principal`, `flags` and `mechOID` on Unix
   (`src/unix/kerberos_unix.cc:131–135`). The loader passes the keys the binary reads.
2. **macOS binary (§ Facts, D7).** The `darwin-x64` and `darwin-arm64` tarballs hold the same
   universal (fat) `kerberos.node` (same SHA-256). It is vendored into both `darwin-<arch>` folders,
   and `mac.x64ArchFiles` covers `Contents/Resources/kerberos/**`. Without that, the universal merge
   refuses a Mach-O file identical in both builds.
3. **Injection (D1, D5).** REST passes no options to `sendWithAuth`, and the native library is
   per-process anyway. So the provider is **process-wide**:
   - the desktop app calls `configureKerberos(loadKerberosProvider({ bindingPath }))` once at
     start-up;
   - unit tests call `configureKerberos(fake)` and reset it with `configureKerberos(undefined)`;
   - `startKerberosContext(…, { provider })` still takes an explicit provider, which overrides the
     process-wide one.

   #41's call `kerberosToken(spn, credentials)` is unchanged.
4. **WebSocket, gRPC and definition fetches (D4).** Their header builders are synchronous
   (`authHeadersAndQuery`, `buildGrpcHeaders`, `credentialsFor`). The async send step first turns
   Kerberos credentials into `{ type: 'bearer', scheme: 'Negotiate', token }` through
   `negotiateBearer`/`withNegotiate`; the existing `applyAuth` then emits
   `Authorization: Negotiate …`. The WebSocket `101` reply is not verified, and the spec's "verify if
   present" is dropped.
5. **WSDL import (D4).** `withBasicAuth` uses global `fetch` with no origin scoping. A Kerberos WSDL
   fetch goes through `createHttpFetchDocument({ auth, authOrigin })` instead. The Basic path is
   unchanged; its scoping is out of scope here.
   - The import dialog offers **Kerberos (signed-in ticket)** with an optional SPN; there is no
     explicit account at import.
   - A re-fetch uses the interface's own Kerberos auth, the explicit account included.
6. **CLI (D4).**
   - A request whose Kerberos send cannot start is **errored**, so the run exits **3**
     (`ExitCode.RunError`), not 2.
   - `wirebench --version --verbose` does not exist, and that line is dropped. The `kerberos-unavailable`
     message already says why.
7. **gRPC command export (D4).** `grpc/command.ts` omits NTLM silently today. Kerberos is omitted the
   same way, and the desktop export adds a note.
8. **Redaction (D8).** `WWW-Authenticate` is not a masked header. Its `Negotiate <token>` part (the
   mutual-auth reply) is masked, and the rest of the challenge stays readable.
9. **Desktop UI and export (D5, D6).** Three things the spec assumed are not in the code:
   - there is no `send-with-history.ts`: every desktop send goes through `desktopSendHost`;
   - no NTLM timeline text exists: the only auth summary in the UI is the SOAP status note
     "Authenticated after 401 challenge";
   - the cURL export has no NTLM output.

   So:
   - the provider is configured once in `main/index.ts`;
   - the SOAP status note becomes Kerberos-aware ("Authenticated with Kerberos as HTTP/host");
   - the REST status line and the HTTP log are left unchanged;
   - `CurlCommand` gains `negotiate`, emitted as `--negotiate --user :` (or `--user 'DOMAIN\user:'`).
10. **Platform in the renderer (D6).** The availability channel returns `platform` too, so the
    renderer needs no user-agent sniffing for this.
11. **Packaging (D7).** pnpm 9 runs dependency build scripts by default, and there is no
    `onlyBuiltDependencies` in the repo. Adding one would stop every other dependency's build
    scripts, so the spec's line about it is dropped.
    - The vendoring script lives in root `scripts/` (with its test in the `scripts` vitest project),
      not in `apps/desktop/scripts/`.
    - `third-party-licenses.ts` reads `optionalDependencies` too.
    - The mac and Linux release jobs do no `--dir` packaging, so `check-kerberos-vendor.ts` runs on
      the unpacked folders that full packaging leaves behind. Nightly has no packaging, so it is not
      added there.
12. **Integration KDC (Testing).** The MIT KDC is apt-installed on the runner (`krb5-kdc`,
    `krb5-admin-server`, `krb5-user`, `libkrb5-dev`) and configured by a script. No container image
    is pulled.
13. **Delivery.** Two PRs instead of three. WebSocket and gRPC are small once `withNegotiate`
    exists, so they ship in the engine PR. The pickers offer Kerberos everywhere in the desktop PR.

## Prebuilt binaries (pinned)

`kerberos@7.0.0`. Each tarball contains the one entry `build/Release/kerberos.node`.

| Prebuild | SHA-256 of the `.tar.gz` |
| --- | --- |
| `darwin-arm64` | `a5587d6744fae4daa3f569156866a5d9d62004a431c0cb79c46010f62219c18f` |
| `darwin-x64` | `a5587d6744fae4daa3f569156866a5d9d62004a431c0cb79c46010f62219c18f` |
| `linux-arm64` | `3fc5d80d7085e601004107c910185c51d4a5d71733bbd58b43cf4e974096c2b0` |
| `linux-x64` | `97613f37eeb336f61c19763959dae6245657b11ff0f725a4c3d276ba6ebf135d` |
| `win32-x64` | `86ab38f3a3463fcf35ab458faa3ecd9fa510dfdc260c682869ca8327b6728515` |

URL: `https://github.com/mongodb-js/kerberos/releases/download/v7.0.0/kerberos-v7.0.0-napi-v9-<prebuild>.tar.gz`.

## File structure

**PR 1 — engine (`feat/40-kerberos-engine`)**

| File | Responsibility |
| --- | --- |
| `packages/engine/src/http/auth/kerberos-native.ts` (new) | Loads the binding; availability; the process-wide provider |
| `packages/engine/src/http/auth/kerberos-token.ts` (new) | The seam: SPN rules, credential rules, error mapping, `startKerberosContext`, `kerberosToken`, `negotiateBearer`, `withNegotiate` |
| `packages/engine/src/http/auth/kerberos-transport.ts` (new) | The two-leg HTTP handshake |
| `packages/engine/src/http/auth/send-auth.ts` | `SendAuth` Kerberos arm; `AuthSummary.spn` |
| `packages/engine/src/http/auth/apply.ts` | Routes Kerberos to the transport |
| `packages/engine/src/project/schema-parts.ts`, `model.ts` | Format arm, types, `FORMAT_VERSION = 8` |
| `packages/engine/src/secrets/resolve.ts`, `secrets/env-names.ts` | Resolution and environment-variable needs |
| `packages/engine/src/redact/index.ts` | Masks the Negotiate token in `WWW-Authenticate` |
| `packages/engine/src/http/document-fetch.ts`, `soap/import.ts`, `soap/types.ts` | Definition fetches |
| `packages/engine/src/ws/call.ts`, `ws/run.ts`, `grpc/send.ts` | Preemptive Negotiate |
| `packages/engine/src/index.ts` | Exports |
| `packages/engine/test/helpers/negotiate-server.ts` (new) | A `node:http` server that challenges with Negotiate |
| `packages/engine/test/helpers/fake-kerberos.ts` (new) | A scriptable `KerberosProvider` |
| `packages/engine/test/integration/auth/kerberos-real.test.ts` (new) | Real KDC, gated by `WIREBENCH_KERBEROS_TESTS=1` |
| `scripts/ci/kerberos-kdc.sh` (new) | Builds a throwaway realm on the CI runner |
| `.github/workflows/ci.yml` | Job `kerberos-integration` |

**PR 2 — desktop (`feat/40-kerberos-desktop`)**

| File | Responsibility |
| --- | --- |
| `scripts/vendor-kerberos.ts` (new), `scripts/kerberos-prebuilds.json` (new) | Download, verify and extract prebuilds |
| `scripts/check-kerberos-vendor.ts` (new) | Asserts every unpacked build carries its binaries |
| `scripts/third-party-licenses.ts` | Reads `optionalDependencies` |
| `apps/desktop/electron-builder.yml`, root `package.json` | `extraResources`, `x64ArchFiles`, packaging scripts |
| `.github/workflows/release.yml` | Vendors on Windows; runs the vendor check |
| `apps/desktop/src/main/kerberos.ts` (new) | Picks the binding path; configures the engine; answers availability |
| `apps/desktop/src/shared/ipc.ts`, `shared/wire-types.ts` | Channel and schemas |
| `apps/desktop/src/main/engine-wire.ts` | `spn` in the auth summary |
| `apps/desktop/src/renderer/components/auth-fields.tsx`, `definition-auth.tsx` | The Kerberos option |
| `apps/desktop/src/renderer/features/request-editor/response-status.tsx` | Kerberos-aware note |
| `apps/desktop/src/renderer/features/explorer/import-dialog.tsx`, `main/engine-service.ts`, `main/project-host.ts` | WSDL import |
| `packages/engine/src/http/curl.ts`, `rest/curl.ts`, `apps/desktop/src/main/ipc/request.ts` | `--negotiate` export |
| Docs | `auth.mdx`, `importers.mdx`, CLI reference, roadmap, `release.md`, CHANGELOG, success criteria |

---

## PR 1 — engine

Branch: `git worktree add git-worktrees/40-kerberos-engine -b feat/40-kerberos-engine main`, then
`pnpm install` inside it. Set the board status of #40 to **In progress**.

### Task 1: The native binding and the process-wide provider

**Files:**
- Modify: `packages/engine/package.json` (add `optionalDependencies`)
- Create: `packages/engine/src/http/auth/kerberos-native.ts`
- Create: `packages/engine/test/fixtures/kerberos/fake-binding.cjs`
- Test: `packages/engine/test/unit/http/auth/kerberos-native.test.ts`

**Interfaces:**
- Produces:
  - `KerberosAvailability`, `KerberosInitInput`, `KerberosClientLike` and `KerberosProvider`;
  - `GSS_MECH_OID_KRB5 = 9` and `GSS_C_MUTUAL_FLAG = 2`;
  - `loadKerberosProvider(options?: { bindingPath?: string; platform?: NodeJS.Platform; arch?: string }): KerberosProvider`;
  - `configureKerberos(provider: KerberosProvider | undefined): void`;
  - `kerberosProvider(): KerberosProvider`.

- [ ] **Step 1: Add the dependency.** In `packages/engine/package.json`, after `dependencies`:

```json
  "optionalDependencies": {
    "kerberos": "7.0.0"
  },
```

Run `pnpm install`. Expected: `pnpm-lock.yaml` gains `kerberos@7.0.0`, and
`node_modules/.pnpm/kerberos@7.0.0/node_modules/kerberos/build/Release/kerberos.node` exists
(prebuild-install fetched it).

- [ ] **Step 2: Write the fake binding fixture**, `packages/engine/test/fixtures/kerberos/fake-binding.cjs`.
It has the raw binding's callback shape, so the loader's promisification is tested for real:

```js
'use strict';
// Stands in for build/Release/kerberos.node: callback-style, as the N-API binding is.
const calls = [];
class KerberosClient {
  constructor(service, options) {
    this.service = service;
    this.options = options;
    this.contextComplete = false;
  }
  step(challenge, callback) {
    calls.push({ step: challenge, service: this.service });
    this.contextComplete = challenge !== '';
    callback(null, challenge === '' ? Buffer.from(`token-for:${this.service}`).toString('base64') : '');
  }
}
function initializeClient(service, options, callback) {
  calls.push({ init: service, options });
  if (service.includes('fail-init')) return callback(new Error('No Kerberos credentials available (default cache: FILE:/tmp/krb5cc_501)'));
  callback(null, new KerberosClient(service, options));
}
module.exports = { initializeClient, KerberosClient, __calls: calls };
```

- [ ] **Step 3: Write the failing tests**, `packages/engine/test/unit/http/auth/kerberos-native.test.ts`:

```ts
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GSS_C_MUTUAL_FLAG,
  GSS_MECH_OID_KRB5,
  configureKerberos,
  kerberosProvider,
  loadKerberosProvider,
  type KerberosProvider,
} from '../../../../src/http/auth/kerberos-native.js';

const FAKE = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'kerberos', 'fake-binding.cjs');
const ABSENT = join(import.meta.dirname, 'absent.node');

afterEach(() => {
  configureKerberos(undefined);
});

describe('loadKerberosProvider', () => {
  it('loads a binding from an explicit path, lazily, and promisifies it', async () => {
    const provider = loadKerberosProvider({ bindingPath: FAKE });
    expect(provider.availability()).toEqual({ available: true });
    const client = await provider.initClient({ spn: 'HTTP@svc.corp' });
    await expect(client.step('')).resolves.toBe(Buffer.from('token-for:HTTP@svc.corp').toString('base64'));
  });

  it('passes the keys the binary reads: mechOID, flags, principal, user, domain, password', async () => {
    const provider = loadKerberosProvider({ bindingPath: FAKE });
    await provider.initClient({ spn: 'HTTP/svc', principal: 'a@R', user: 'u', domain: 'D', password: 'p' });
    const binding = createRequire(import.meta.url)(FAKE) as { __calls: { init?: string; options?: Record<string, unknown> }[] };
    const init = binding.__calls.findLast((call) => call.init === 'HTTP/svc');
    expect(init?.options).toEqual({
      mechOID: GSS_MECH_OID_KRB5,
      flags: GSS_C_MUTUAL_FLAG,
      principal: 'a@R',
      user: 'u',
      domain: 'D',
      password: 'p',
    });
  });

  it('reports a missing binding as unavailable, with a reason, and never throws on load', () => {
    const availability = loadKerberosProvider({ bindingPath: ABSENT }).availability();
    expect(availability).toEqual({ available: false, reason: 'The Kerberos component is not installed.' });
  });

  it('names Windows on ARM when there is no binding for it', () => {
    const provider = loadKerberosProvider({ bindingPath: ABSENT, platform: 'win32', arch: 'arm64' });
    expect(provider.availability()).toEqual({ available: false, reason: 'Kerberos is not available on Windows on ARM.' });
  });

  it('rejects initClient on an unavailable provider with the reason', async () => {
    await expect(loadKerberosProvider({ bindingPath: ABSENT }).initClient({ spn: 'HTTP@x' })).rejects.toThrow(
      'The Kerberos component is not installed.',
    );
  });
});

describe('configureKerberos', () => {
  it('replaces and restores the process-wide provider', () => {
    const fake: KerberosProvider = {
      availability: () => ({ available: false, reason: 'fake' }),
      initClient: () => Promise.reject(new Error('fake')),
    };
    configureKerberos(fake);
    expect(kerberosProvider()).toBe(fake);
    configureKerberos(undefined);
    expect(kerberosProvider()).not.toBe(fake);
  });
});
```

- [ ] **Step 4: Run them to see them fail.**
Run: `pnpm vitest run --project engine-unit packages/engine/test/unit/http/auth/kerberos-native.test.ts`
Expected: FAIL, because `kerberos-native.js` does not exist.

- [ ] **Step 5: Implement** `packages/engine/src/http/auth/kerberos-native.ts`:

```ts
/**
 * The one file that touches the native Kerberos binding (ADR-0019). Everything else goes through
 * `kerberos-token.ts`.
 *
 * The binding is loaded directly rather than through the `kerberos` package's JavaScript, because
 * that file only ever loads `../build/Release/kerberos.node` and the desktop app ships a vendored
 * copy elsewhere. Loading is lazy and memoised: nothing native is touched until a send needs it.
 *
 * The option keys are the ones the C++ reads in kerberos@7.0.0 (`flags`, `user`, `domain`,
 * `password`), not the `gssFlag`/`pass` its `index.d.ts` documents.
 */

import { createRequire } from 'node:module';
import { promisify } from 'node:util';

/** `GSS_MECH_OID_KRB5` in kerberos@7.0.0: the Kerberos mechanism (SSPI package `Kerberos` on Windows). */
export const GSS_MECH_OID_KRB5 = 9;
/** `GSS_C_MUTUAL_FLAG` in kerberos@7.0.0. */
export const GSS_C_MUTUAL_FLAG = 2;

export type KerberosAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

export interface KerberosInitInput {
  /** Already in the platform's form: `HTTP/host` on Windows, `HTTP@host` elsewhere. */
  readonly spn: string;
  readonly principal?: string;
  readonly user?: string;
  readonly domain?: string;
  readonly password?: string;
}

export interface KerberosClientLike {
  step(challengeBase64: string): Promise<string>;
  readonly contextComplete: boolean;
}

export interface KerberosProvider {
  availability(): KerberosAvailability;
  initClient(input: KerberosInitInput): Promise<KerberosClientLike>;
}

interface RawClient {
  step(challenge: string, callback: (error: Error | null, response?: string) => void): void;
  readonly contextComplete: boolean;
}
interface RawBinding {
  initializeClient(
    service: string,
    options: Record<string, unknown>,
    callback: (error: Error | null, client?: RawClient) => void,
  ): void;
}

type Loaded = { readonly binding: RawBinding } | { readonly reason: string };

export interface LoadKerberosOptions {
  /** The vendored binding; when absent, the installed `kerberos` package's own binding. */
  readonly bindingPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}

/** A provider over the binding at `bindingPath`. Never throws: a load failure becomes a reason. */
export function loadKerberosProvider(options: LoadKerberosOptions = {}): KerberosProvider {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  let loaded: Loaded | undefined;

  const load = (): Loaded => {
    if (loaded !== undefined) return loaded;
    const require = createRequire(import.meta.url);
    try {
      const path =
        options.bindingPath ??
        require.resolve('kerberos/package.json').replace(/package\.json$/, 'build/Release/kerberos.node');
      loaded = { binding: require(path) as RawBinding };
    } catch (error) {
      loaded = { reason: reasonFor(error, platform, arch) };
    }
    return loaded;
  };

  return {
    availability() {
      const state = load();
      return 'binding' in state ? { available: true } : { available: false, reason: state.reason };
    },
    async initClient(input) {
      const state = load();
      if (!('binding' in state)) throw new Error(state.reason);
      const init = promisify(state.binding.initializeClient.bind(state.binding)) as (
        service: string,
        options: Record<string, unknown>,
      ) => Promise<RawClient>;
      const raw = await init(input.spn, {
        mechOID: GSS_MECH_OID_KRB5,
        flags: GSS_C_MUTUAL_FLAG,
        ...(input.principal !== undefined ? { principal: input.principal } : {}),
        ...(input.user !== undefined ? { user: input.user } : {}),
        ...(input.domain !== undefined ? { domain: input.domain } : {}),
        ...(input.password !== undefined ? { password: input.password } : {}),
      });
      const step = promisify(raw.step.bind(raw)) as (challenge: string) => Promise<string>;
      return {
        step: (challenge) => step(challenge),
        get contextComplete() {
          return raw.contextComplete;
        },
      };
    },
  };
}

function reasonFor(error: unknown, platform: NodeJS.Platform, arch: string): string {
  if (platform === 'win32' && arch === 'arm64') return 'Kerberos is not available on Windows on ARM.';
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'MODULE_NOT_FOUND') return 'The Kerberos component is not installed.';
  const message = error instanceof Error ? error.message : String(error);
  if (/libgssapi|libkrb5/.test(message)) {
    return `The Kerberos libraries could not be loaded (${message}). Install the krb5 libraries (libgssapi-krb5-2 or krb5-libs).`;
  }
  return `The Kerberos component could not be loaded: ${message}`;
}

let configured: KerberosProvider | undefined;
let installed: KerberosProvider | undefined;

/** Sets the provider every Kerberos send uses; `undefined` restores the installed package's. */
export function configureKerberos(provider: KerberosProvider | undefined): void {
  configured = provider;
}

/** The provider in force: the configured one, else the installed `kerberos` package's binding. */
export function kerberosProvider(): KerberosProvider {
  if (configured !== undefined) return configured;
  installed ??= loadKerberosProvider();
  return installed;
}
```

- [ ] **Step 6: Run the tests to see them pass.** Same command. Expected: PASS, 6 tests.

- [ ] **Step 7: Gate and commit.**

```bash
git add packages/engine/package.json pnpm-lock.yaml packages/engine/src/http/auth/kerberos-native.ts packages/engine/test/fixtures/kerberos packages/engine/test/unit/http/auth/kerberos-native.test.ts
git commit -m "feat(engine): load the optional Kerberos binding lazily, with a process-wide provider"
```

### Task 2: The token seam

**Files:**
- Create: `packages/engine/src/http/auth/kerberos-token.ts`
- Create: `packages/engine/test/helpers/fake-kerberos.ts`
- Test: `packages/engine/test/unit/http/auth/kerberos-token.test.ts`

**Interfaces:**
- Consumes: `KerberosProvider` and `kerberosProvider()` (Task 1).
- Produces:
  - `KerberosCredentials { principal?; username?; domain?; password? }`;
  - `KerberosSendAuth = { type: 'kerberos'; spn? } & KerberosCredentials`;
  - `KerberosOptions { provider?: KerberosProvider; platform?: NodeJS.Platform }`;
  - `KerberosContext { token: Uint8Array; spn: string; verify(reply: Uint8Array): Promise<void> }`;
  - `normaliseSpn(spn: string, platform: NodeJS.Platform): string`;
  - `defaultSpn(url: string): string`, which returns `HTTP@<hostname>`;
  - `startKerberosContext(spn, credentials, options?): Promise<KerberosContext>`;
  - `kerberosToken(spn, credentials, options?): Promise<Uint8Array>`;
  - `negotiateBearer(auth: KerberosSendAuth, url: string, options?): Promise<{ type: 'bearer'; scheme: 'Negotiate'; token: string }>`;
  - `kerberosError(error: unknown, spn: string): HttpError`.
- Error codes: `kerberos-unavailable`, `kerberos-explicit-credentials-unsupported`,
  `kerberos-no-credentials`, `kerberos-unknown-spn`, `kerberos-clock-skew`,
  `kerberos-mutual-auth-failed`, `kerberos-failed`. The transport adds `kerberos-rejected` (Task 4).

- [ ] **Step 1: Write the fake provider**, `packages/engine/test/helpers/fake-kerberos.ts`:

```ts
import type { KerberosClientLike, KerberosInitInput, KerberosProvider } from '../../src/http/auth/kerberos-native.js';

export interface FakeKerberos extends KerberosProvider {
  readonly inits: KerberosInitInput[];
  readonly steps: string[];
}

/** A scriptable provider: the first step returns `token` (base64), a later step fails when `verifyFails`. */
export function fakeKerberos(
  options: {
    readonly unavailable?: string;
    readonly initError?: string;
    readonly token?: string;
    readonly verifyFails?: boolean;
  } = {},
): FakeKerberos {
  const inits: KerberosInitInput[] = [];
  const steps: string[] = [];
  return {
    inits,
    steps,
    availability: () =>
      options.unavailable !== undefined ? { available: false, reason: options.unavailable } : { available: true },
    initClient(input) {
      inits.push(input);
      if (options.unavailable !== undefined) return Promise.reject(new Error(options.unavailable));
      if (options.initError !== undefined) return Promise.reject(new Error(options.initError));
      let complete = false;
      const client: KerberosClientLike = {
        step(challenge) {
          steps.push(challenge);
          if (challenge === '') return Promise.resolve(options.token ?? Buffer.from('ap-req').toString('base64'));
          if (options.verifyFails === true) return Promise.reject(new Error('GSS failure: Bad integrity check'));
          complete = true;
          return Promise.resolve('');
        },
        get contextComplete() {
          return complete;
        },
      };
      return Promise.resolve(client);
    },
  };
}
```

- [ ] **Step 2: Write the failing tests**, `packages/engine/test/unit/http/auth/kerberos-token.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  defaultSpn,
  kerberosToken,
  negotiateBearer,
  normaliseSpn,
  startKerberosContext,
} from '../../../../src/http/auth/kerberos-token.js';
import { fakeKerberos } from '../../../helpers/fake-kerberos.js';

describe('normaliseSpn', () => {
  it.each([
    ['HTTP/svc.corp', 'win32', 'HTTP/svc.corp'],
    ['HTTP@svc.corp', 'win32', 'HTTP/svc.corp'],
    ['svc.corp', 'win32', 'HTTP/svc.corp'],
    ['HTTP/svc.corp', 'darwin', 'HTTP@svc.corp'],
    ['host/sts.corp', 'linux', 'host@sts.corp'],
    ['svc.corp', 'linux', 'HTTP@svc.corp'],
  ] as const)('%s on %s → %s', (spn, platform, expected) => {
    expect(normaliseSpn(spn, platform)).toBe(expected);
  });

  it('defaults to HTTP and the hostname, without the port', () => {
    expect(defaultSpn('https://svc.corp:8443/a?b')).toBe('HTTP@svc.corp');
  });
});

describe('startKerberosContext', () => {
  it('asks in the platform form and returns the first token', async () => {
    const provider = fakeKerberos();
    const context = await startKerberosContext('HTTP@svc', {}, { provider, platform: 'win32' });
    expect(provider.inits).toEqual([{ spn: 'HTTP/svc' }]);
    expect(context.spn).toBe('HTTP/svc');
    expect(Buffer.from(context.token).toString()).toBe('ap-req');
  });

  it('passes an explicit account on Windows', async () => {
    const provider = fakeKerberos();
    await startKerberosContext('svc', { username: 'u', domain: 'D', password: 'p' }, { provider, platform: 'win32' });
    expect(provider.inits).toEqual([{ spn: 'HTTP/svc', user: 'u', domain: 'D', password: 'p' }]);
  });

  it.each(['darwin', 'linux'] as const)('refuses an explicit account on %s before touching the provider', async (platform) => {
    const provider = fakeKerberos();
    await expect(startKerberosContext('svc', { username: 'u' }, { provider, platform })).rejects.toMatchObject({
      code: 'kerberos-explicit-credentials-unsupported',
    });
    expect(provider.inits).toEqual([]);
  });

  it('passes a principal on GSSAPI only', async () => {
    const provider = fakeKerberos();
    await startKerberosContext('svc', { principal: 'alice@CORP' }, { provider, platform: 'linux' });
    await startKerberosContext('svc', { principal: 'alice@CORP' }, { provider, platform: 'win32' });
    expect(provider.inits).toEqual([{ spn: 'HTTP@svc', principal: 'alice@CORP' }, { spn: 'HTTP/svc' }]);
  });

  it('refuses when the provider is unavailable, with its reason', async () => {
    const provider = fakeKerberos({ unavailable: 'The Kerberos component is not installed.' });
    await expect(startKerberosContext('svc', {}, { provider, platform: 'linux' })).rejects.toMatchObject({
      code: 'kerberos-unavailable',
      message: 'The Kerberos component is not installed.',
    });
  });

  it.each([
    ['No Kerberos credentials available (default cache: FILE:/tmp/x)', 'kerberos-no-credentials'],
    ['SEC_E_NO_CREDENTIALS', 'kerberos-no-credentials'],
    ['Server not found in Kerberos database', 'kerberos-unknown-spn'],
    ['SEC_E_TARGET_UNKNOWN', 'kerberos-unknown-spn'],
    ['Clock skew too great', 'kerberos-clock-skew'],
    ['SEC_E_TIME_SKEW', 'kerberos-clock-skew'],
    ['Something else entirely', 'kerberos-failed'],
  ])('maps "%s" to %s, naming the SPN and keeping the OS text', async (osMessage, code) => {
    const provider = fakeKerberos({ initError: osMessage });
    await expect(startKerberosContext('svc', {}, { provider, platform: 'linux' })).rejects.toMatchObject({
      code,
      details: { spn: 'HTTP@svc', osMessage },
    });
  });

  it('verifies a reply token, and fails a bad one as kerberos-mutual-auth-failed', async () => {
    const good = await startKerberosContext('svc', {}, { provider: fakeKerberos(), platform: 'linux' });
    await expect(good.verify(Buffer.from('ap-rep'))).resolves.toBeUndefined();
    const bad = await startKerberosContext('svc', {}, { provider: fakeKerberos({ verifyFails: true }), platform: 'linux' });
    await expect(bad.verify(Buffer.from('ap-rep'))).rejects.toMatchObject({ code: 'kerberos-mutual-auth-failed' });
  });
});

describe('kerberosToken and negotiateBearer', () => {
  it('kerberosToken returns the raw bytes of the first step', async () => {
    const token = await kerberosToken('host/sts.corp', {}, { provider: fakeKerberos(), platform: 'linux' });
    expect(Buffer.from(token).toString()).toBe('ap-req');
  });

  it('negotiateBearer derives the SPN from the URL unless one is set', async () => {
    const provider = fakeKerberos();
    await expect(
      negotiateBearer({ type: 'kerberos' }, 'wss://svc.corp:9443/ws', { provider, platform: 'linux' }),
    ).resolves.toEqual({ type: 'bearer', scheme: 'Negotiate', token: Buffer.from('ap-req').toString('base64') });
    await negotiateBearer({ type: 'kerberos', spn: 'HTTP/alias.corp' }, 'https://svc.corp', { provider, platform: 'linux' });
    expect(provider.inits.map((init) => init.spn)).toEqual(['HTTP@svc.corp', 'HTTP@alias.corp']);
  });
});
```

- [ ] **Step 3: Run them to see them fail.**
Run: `pnpm vitest run --project engine-unit packages/engine/test/unit/http/auth/kerberos-token.test.ts`
Expected: FAIL, because the module does not exist.

- [ ] **Step 4: Implement** `packages/engine/src/http/auth/kerberos-token.ts`:

```ts
/**
 * The one seam every Kerberos caller goes through: HTTP Negotiate (`kerberos-transport.ts`), the
 * preemptive WebSocket, gRPC and definition-fetch paths (`negotiateBearer`), and WS-Trust's STS
 * request (#41, `kerberosToken`). The rules live here once: availability, Windows-only explicit
 * credentials, SPN form and error mapping; mechanism and flags are fixed in `kerberos-native.ts`.
 *
 * The token is the GSS-API initial context token for Kerberos v5 (RFC 4121 framing around an
 * AP-REQ): what a `Negotiate` header carries for a Kerberos-only client, and what WS-Security's
 * `#GSS_Kerberosv5_AP_REQ` value type names.
 */

import { HttpError } from '../../errors.js';
import { kerberosProvider, type KerberosProvider } from './kerberos-native.js';

export interface KerberosCredentials {
  /** GSSAPI only: pick this principal's ticket from the cache. */
  readonly principal?: string;
  /** Windows only. */
  readonly username?: string;
  /** Windows only. */
  readonly domain?: string;
  /** Windows only; already resolved from a reference by the host. */
  readonly password?: string;
}

export type KerberosSendAuth = { readonly type: 'kerberos'; readonly spn?: string } & KerberosCredentials;

export interface KerberosOptions {
  /** Overrides the process-wide provider (`configureKerberos`). */
  readonly provider?: KerberosProvider;
  readonly platform?: NodeJS.Platform;
}

export interface KerberosContext {
  readonly token: Uint8Array;
  /** The SPN actually asked for, in the platform's form. */
  readonly spn: string;
  /** Feeds the acceptor's reply token; throws `kerberos-mutual-auth-failed` when it does not verify. */
  verify(replyToken: Uint8Array): Promise<void>;
}

/** `HTTP/host`, `HTTP@host` or a bare host, in the form this platform's API wants. */
export function normaliseSpn(spn: string, platform: NodeJS.Platform): string {
  const trimmed = spn.trim();
  const match = /^([^/@]+)[/@](.+)$/.exec(trimmed);
  const service = match?.[1] ?? 'HTTP';
  const host = match?.[2] ?? trimmed;
  return platform === 'win32' ? `${service}/${host}` : `${service}@${host}`;
}

/** `HTTP` plus the URL's hostname, without the port: what Windows asks for by default. */
export function defaultSpn(url: string): string {
  return `HTTP@${new URL(url).hostname}`;
}

export async function startKerberosContext(
  spn: string,
  credentials: KerberosCredentials,
  options: KerberosOptions = {},
): Promise<KerberosContext> {
  const platform = options.platform ?? process.platform;
  const provider = options.provider ?? kerberosProvider();
  const target = normaliseSpn(spn, platform);

  if (platform !== 'win32' && (credentials.username !== undefined || credentials.password !== undefined)) {
    throw new HttpError(
      'kerberos-explicit-credentials-unsupported',
      'Explicit Kerberos credentials are Windows-only. Run `kinit user@REALM` and leave username and password empty.',
      { details: { spn: target } },
    );
  }
  const availability = provider.availability();
  if (!availability.available) {
    throw new HttpError('kerberos-unavailable', availability.reason, { details: { spn: target } });
  }

  try {
    const client = await provider.initClient({
      spn: target,
      ...(credentials.principal !== undefined && platform !== 'win32' ? { principal: credentials.principal } : {}),
      ...(credentials.username !== undefined ? { user: credentials.username } : {}),
      ...(credentials.domain !== undefined ? { domain: credentials.domain } : {}),
      ...(credentials.password !== undefined ? { password: credentials.password } : {}),
    });
    const first = await client.step('');
    return {
      token: Buffer.from(first, 'base64'),
      spn: target,
      async verify(replyToken) {
        try {
          await client.step(Buffer.from(replyToken).toString('base64'));
        } catch (error) {
          throw new HttpError('kerberos-mutual-auth-failed', `The server's Kerberos reply could not be verified (${target}).`, {
            cause: error,
            details: { spn: target, osMessage: messageOf(error) },
          });
        }
      },
    };
  } catch (error) {
    throw kerberosError(error, target);
  }
}

export async function kerberosToken(
  spn: string,
  credentials: KerberosCredentials,
  options?: KerberosOptions,
): Promise<Uint8Array> {
  return (await startKerberosContext(spn, credentials, options)).token;
}

/** One preemptive token as a bearer credential, for the paths whose header builders are synchronous. */
export async function negotiateBearer(
  auth: KerberosSendAuth,
  url: string,
  options?: KerberosOptions,
): Promise<{ readonly type: 'bearer'; readonly scheme: 'Negotiate'; readonly token: string }> {
  const token = await kerberosToken(auth.spn ?? defaultSpn(url), auth, options);
  return { type: 'bearer', scheme: 'Negotiate', token: Buffer.from(token).toString('base64') };
}

const KNOWN: readonly (readonly [RegExp, string, (spn: string) => string])[] = [
  [
    /no kerberos credentials|SEC_E_NO_CREDENTIALS|credentials cache/i,
    'kerberos-no-credentials',
    () => 'No Kerberos ticket. Sign in to the domain, or run `kinit`.',
  ],
  [
    /not found in kerberos database|S_PRINCIPAL_UNKNOWN|SEC_E_TARGET_UNKNOWN/i,
    'kerberos-unknown-spn',
    (spn) => `The KDC does not know ${spn}. Set the SPN to the name the service is registered under.`,
  ],
  [/clock skew|TIME_SKEW|AP_ERR_SKEW/i, 'kerberos-clock-skew', () => "This machine's clock differs from the domain's by more than allowed."],
];

/** An OS failure as one of the named codes; an HttpError passes through. */
export function kerberosError(error: unknown, spn: string): HttpError {
  if (error instanceof HttpError) return error;
  const osMessage = messageOf(error);
  for (const [pattern, code, message] of KNOWN) {
    if (pattern.test(osMessage)) return new HttpError(code, message(spn), { cause: error, details: { spn, osMessage } });
  }
  return new HttpError('kerberos-failed', `Kerberos failed for ${spn}: ${osMessage}`, { cause: error, details: { spn, osMessage } });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

- [ ] **Step 5: Run the tests to see them pass.** Same command. Expected: PASS.

- [ ] **Step 6: Gate and commit.**

```bash
git add packages/engine/src/http/auth/kerberos-token.ts packages/engine/test/helpers/fake-kerberos.ts packages/engine/test/unit/http/auth/kerberos-token.test.ts
git commit -m "feat(engine): one Kerberos token seam with SPN, credential and error rules"
```

### Task 3: Format, types and resolution

**Files:**
- Modify: `packages/engine/src/project/schema-parts.ts` (new arm, l.40–159), `project/schema.ts:37-45` (re-export)
- Modify: `packages/engine/src/project/model.ts` (`FORMAT_VERSION`, `AuthType`, `KerberosAuth`, `AuthConfig`, `DefinitionAuth`, l.30–154)
- Modify: `packages/engine/src/project/migrate.ts:24` (the version list in the doc comment)
- Modify: `packages/engine/src/http/auth/send-auth.ts`
- Modify: `packages/engine/src/secrets/resolve.ts:118-159`, `packages/engine/src/secrets/env-names.ts:38-50`
- Modify: hard-coded format 7 in tests:
  - `packages/engine/test/unit/project/format-migration.test.ts` (l.44, 67, 82, 102, 116, 130, 152,
    187, 199, 219; the too-new test at 137–145 becomes version 9);
  - `roundtrip.test.ts` (l.76, 427, 431);
  - `webhooks-format.test.ts:67`, `webhook-signing-format.test.ts:55`;
  - `packages/engine/test/unit/sequence/load-save.test.ts:38`.
- Test: `packages/engine/test/unit/project/kerberos-auth-format.test.ts` (new), `packages/engine/test/unit/secrets/resolve-kerberos.test.ts` (new)

**Interfaces:**
- Consumes: `KerberosSendAuth` (Task 2).
- Produces:
  - `kerberosAuthSchema`;
  - the model type `KerberosAuth { type: 'kerberos'; spn?; principal?; username?; domain?; passwordRef?; passwordEnv? }`;
  - `SendAuth`'s new arm `KerberosSendAuth`;
  - `AuthSummary.spn?: string`;
  - `FORMAT_VERSION = 8`.

- [ ] **Step 1: Write the failing format tests**, `packages/engine/test/unit/project/kerberos-auth-format.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { authConfigSchema, definitionAuthSchema, kerberosAuthSchema, soapOwnerAuthSchema } from '../../../src/project/schema-parts.js';
import { FORMAT_VERSION } from '../../../src/project/model.js';
import { effectiveAuth } from '../../../src/project/endpoints.js';

const KERBEROS = { type: 'kerberos', spn: 'HTTP/svc.corp', principal: 'a@CORP', username: 'u', domain: 'D', passwordRef: 'sec_1' };

describe('kerberos auth in the project format', () => {
  it('is accepted at every site', () => {
    for (const schema of [kerberosAuthSchema, authConfigSchema, soapOwnerAuthSchema, definitionAuthSchema]) {
      expect(schema.safeParse(KERBEROS).success).toBe(true);
      expect(schema.safeParse({ type: 'kerberos' }).success).toBe(true);
    }
  });

  it('refuses a plaintext password', () => {
    for (const schema of [authConfigSchema, soapOwnerAuthSchema, definitionAuthSchema]) {
      expect(schema.safeParse({ type: 'kerberos', password: 'hunter2' }).success).toBe(false);
    }
  });

  it('is format 8', () => {
    expect(FORMAT_VERSION).toBe(8);
  });

  it('is a whole value under effectiveAuth: nothing merges into it', () => {
    const endpoint = { type: 'kerberos' } as const;
    const request = { type: 'basic', username: 'u', passwordRef: 'r' } as const;
    expect(effectiveAuth(request, endpoint, 'complement')).toEqual(request);
    expect(effectiveAuth(undefined, endpoint, 'complement', { type: 'basic', username: 'x' })).toEqual(endpoint);
  });
});
```

- [ ] **Step 2: Write the failing resolution tests**, `packages/engine/test/unit/secrets/resolve-kerberos.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveAuthConfig, resolveSoapAuth } from '../../../src/secrets/resolve.js';
import { secretNeedsOfAuth } from '../../../src/secrets/env-names.js';

const secrets = (values: Record<string, string>) => (ref: string) => Promise.resolve(values[ref]);

describe('kerberos resolution', () => {
  it('maps the signed-in form with no secret at all', async () => {
    await expect(resolveAuthConfig({ type: 'kerberos', spn: 'HTTP/x', principal: 'a@R' }, secrets({}))).resolves.toEqual({
      type: 'kerberos',
      spn: 'HTTP/x',
      principal: 'a@R',
    });
  });

  it('resolves the password only when a username is set', async () => {
    await expect(
      resolveAuthConfig({ type: 'kerberos', username: 'u', domain: 'D', passwordRef: 'r' }, secrets({ r: 'p' })),
    ).resolves.toEqual({ type: 'kerberos', username: 'u', domain: 'D', password: 'p' });
    await expect(resolveAuthConfig({ type: 'kerberos', passwordRef: 'r' }, secrets({}))).resolves.toEqual({ type: 'kerberos' });
  });

  it('fails a dangling reference as secret-missing', async () => {
    await expect(
      resolveAuthConfig({ type: 'kerberos', username: 'u', passwordRef: 'gone' }, secrets({})),
    ).rejects.toMatchObject({ code: 'secret-missing' });
  });

  it('resolves for a SOAP owner too', async () => {
    await expect(resolveSoapAuth({ type: 'kerberos' }, secrets({}))).resolves.toEqual({ type: 'kerberos' });
  });

  it('names its environment-variable need only with a username', () => {
    expect(secretNeedsOfAuth({ type: 'kerberos' })).toEqual([]);
    expect(secretNeedsOfAuth({ type: 'kerberos', username: 'u', passwordRef: 'r', passwordEnv: 'KRB_PW' })).toHaveLength(1);
  });
});
```

Check `resolveSoapAuth`'s third parameter (`resolve.ts:177`). If it is required, pass `{}`.

- [ ] **Step 3: Run them to see them fail.**
Run: `pnpm vitest run --project engine-unit packages/engine/test/unit/project/kerberos-auth-format.test.ts packages/engine/test/unit/secrets/resolve-kerberos.test.ts`
Expected: FAIL, because `kerberosAuthSchema` is not exported.

- [ ] **Step 4: Add the schema arm.** In `schema-parts.ts`, after `oauth2AuthSchema` (≈l.122):

```ts
/**
 * Kerberos over HTTP Negotiate (#40). No secret by default: the OS's own ticket is used. The account
 * fields are Windows-only and refused at send time elsewhere; the password is only ever a reference.
 */
export const kerberosAuthSchema = refuseSecretValues(
  z.looseObject({
    type: z.literal('kerberos'),
    spn: z.string().optional(),
    principal: z.string().optional(),
    username: z.string().optional(),
    domain: z.string().optional(),
    passwordRef: z.string().optional(),
    passwordEnv: envName,
  }),
);
```

Add `kerberosAuthSchema` as the last arm of `authConfigSchema` (l.130), `soapOwnerAuthSchema`
(l.146) and `definitionAuthSchema` (l.153). Re-export it beside the others in
`project/schema.ts:37–45`.

- [ ] **Step 5: Add the types.** In `model.ts`:
  - Set `FORMAT_VERSION = 8`. Add a line to the doc comment at l.30–41:
    "8 — Kerberos auth (`type: kerberos`), so an older build refuses such a project as too new."
  - Add `'kerberos'` to `AuthType` (l.54).
  - Add the type below `OAuth2Auth`:

```ts
export interface KerberosAuth {
  readonly type: 'kerberos';
  readonly spn?: string;
  readonly principal?: string;
  readonly username?: string;
  readonly domain?: string;
  readonly passwordRef?: string;
  readonly passwordEnv?: string;
}
```

  - Then:
    - `AuthConfig = InheritAuth | EndpointAuth | BearerAuth | ApiKeyAuth | OAuth2Auth | KerberosAuth` (l.141);
    - `DefinitionAuth = (EndpointAuth & { readonly type: 'basic' }) | BearerAuth | ApiKeyAuth | KerberosAuth` (l.154).
  - In `migrate.ts:24`, extend the version list to "… → 7 → 8".

- [ ] **Step 6: Extend `SendAuth`.** In `send-auth.ts`:

```ts
import type { KerberosSendAuth } from './kerberos-token.js';
// …
  | { readonly type: 'oauth2'; readonly accessToken: string }
  /** Kerberos over Negotiate (#40): the OS ticket, or on Windows an explicit account. */
  | KerberosSendAuth;
```

In `AuthSummary`, add:

```ts
  /** The service principal Kerberos asked for, in the platform's form. Not a secret. */
  readonly spn?: string;
```

- [ ] **Step 7: Resolve it.** In `resolve.ts` `resolveAuthConfig`, before `default:`:

```ts
    case 'kerberos': {
      const password =
        auth.username !== undefined && auth.passwordRef !== undefined
          ? await requireSecret(auth.passwordRef, getSecret, auth.username)
          : undefined;
      return {
        type: 'kerberos',
        ...(auth.spn !== undefined ? { spn: auth.spn } : {}),
        ...(auth.principal !== undefined ? { principal: auth.principal } : {}),
        ...(auth.username !== undefined ? { username: auth.username } : {}),
        ...(auth.domain !== undefined ? { domain: auth.domain } : {}),
        ...(password !== undefined ? { password } : {}),
      };
    }
```

`requireSecret` (l.192) is private. Call it exactly as the `bearer` case beside it does; if its
parameter list differs from `(ref, getSecret, label)`, follow that call. `resolveSoapAuth` reaches
this case already, because `isEndpointAuth` is false for Kerberos.

In `env-names.ts` `secretNeedsOfAuth`:

```ts
    case 'kerberos':
      return auth.username !== undefined
        ? need(auth.passwordRef, auth.passwordEnv, `kerberos password for "${auth.username}"`)
        : [];
```

- [ ] **Step 8: Bump the hard-coded format 7s** in the tests listed under **Files**, to 8. The
too-new test rewrites to `formatVersion: 9` and expects `supported: 8`.

- [ ] **Step 9: Run the engine unit suite.**
Run: `pnpm vitest run --project engine-unit`
Expected: PASS, including both new files and `format-migration.test.ts`. Run
`pnpm --filter @wirebench/engine exec tsc --noEmit`, and fix every exhaustive `switch` over
`AuthConfig['type']` or `SendAuth['type']` the compiler names. Kerberos joins the arm that does
nothing (`missingSecretRef`'s default) or the arm that passes through to the transport (`applyAuth`'s
default).

- [ ] **Step 10: Gate and commit.**

```bash
git add packages/engine/src packages/engine/test/unit
git commit -m "feat(engine): Kerberos auth in the project format (v8) and its resolution"
```

### Task 4: The HTTP Negotiate handshake

**Files:**
- Create: `packages/engine/src/http/auth/kerberos-transport.ts`
- Modify: `packages/engine/src/http/auth/apply.ts:45-104`
- Create: `packages/engine/test/helpers/negotiate-server.ts`
- Test: `packages/engine/test/integration/auth/kerberos.test.ts`

**Interfaces:**
- Consumes: `startKerberosContext`, `defaultSpn` and `KerberosSendAuth` (Task 2);
  `createSingleConnectionDispatcher` and `sendHttp` (`http/client.ts:137, 398`); `headerValue`
  (`http/headers.ts:48`).
- Produces:
  - `kerberosHandshake(request: HttpRequest, auth: KerberosSendAuth, options?: { now?: () => number; dispatcher?: Dispatcher; preemptive?: boolean }): Promise<KerberosHandshakeResult>`;
  - `offersNegotiate(header: string | undefined): boolean`;
  - `negotiateToken(header: string | undefined): Uint8Array | undefined`.

- [ ] **Step 1: Write the test server**, `packages/engine/test/helpers/negotiate-server.ts`:

```ts
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export interface NegotiateRecord {
  readonly authorization: string | undefined;
  readonly body: string;
  readonly socket: number;
}

export interface NegotiateServer {
  readonly url: string;
  readonly requests: NegotiateRecord[];
  sameSocket(): boolean;
  close(): Promise<void>;
}

/**
 * Answers 401 `WWW-Authenticate: Negotiate` (or `challenge`) to a request without
 * `Authorization: Negotiate <expectedToken>`, and 200, with an optional mutual-auth reply, to one with it.
 */
export async function startNegotiateServer(options: {
  readonly expectedToken: string;
  readonly challenge?: string;
  readonly reply?: string;
  readonly rejectToken?: boolean;
}): Promise<NegotiateServer> {
  const requests: NegotiateRecord[] = [];
  const sockets = new WeakMap<Socket, number>();
  let nextSocket = 0;
  const server = createServer((request: IncomingMessage, response) => {
    let socketId = sockets.get(request.socket);
    if (socketId === undefined) {
      socketId = nextSocket++;
      sockets.set(request.socket, socketId);
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const authorization = request.headers.authorization;
      requests.push({ authorization, body: Buffer.concat(chunks).toString(), socket: socketId });
      const ok = authorization === `Negotiate ${options.expectedToken}` && options.rejectToken !== true;
      if (!ok) {
        response.writeHead(401, { 'WWW-Authenticate': options.challenge ?? 'Negotiate', 'Content-Length': '0' });
        response.end();
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'text/plain',
        ...(options.reply !== undefined ? { 'WWW-Authenticate': `Negotiate ${options.reply}` } : {}),
      });
      response.end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/svc`,
    requests,
    sameSocket: () => new Set(requests.map((entry) => entry.socket)).size === 1,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
```

- [ ] **Step 2: Write the failing tests**, `packages/engine/test/integration/auth/kerberos.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { sendWithAuth } from '../../../src/http/auth/apply.js';
import { configureKerberos } from '../../../src/http/auth/kerberos-native.js';
import { kerberosHandshake } from '../../../src/http/auth/kerberos-transport.js';
import { fakeKerberos } from '../../helpers/fake-kerberos.js';
import { startNegotiateServer, type NegotiateServer } from '../../helpers/negotiate-server.js';

const TOKEN = Buffer.from('ap-req').toString('base64');
const REPLY = Buffer.from('ap-rep').toString('base64');
let server: NegotiateServer | undefined;

afterEach(async () => {
  configureKerberos(undefined);
  await server?.close();
  server = undefined;
});

const post = (url: string, timeoutMs = 10_000) => ({
  url,
  method: 'POST' as const,
  headers: { 'content-type': 'text/xml' },
  body: Buffer.from('<Envelope/>'),
  timeoutMs,
  followRedirects: false,
});

describe('Kerberos over HTTP Negotiate', () => {
  it('answers a challenge on the same connection, the body sent twice, and verifies the reply', async () => {
    const provider = fakeKerberos();
    configureKerberos(provider);
    server = await startNegotiateServer({ expectedToken: TOKEN, reply: REPLY });
    const result = await sendWithAuth(post(server.url), { type: 'kerberos' });
    expect(result.http.status).toBe(200);
    expect(result.auth).toEqual({
      scheme: 'kerberos',
      challenged: true,
      attempts: 2,
      spn: process.platform === 'win32' ? 'HTTP/127.0.0.1' : 'HTTP@127.0.0.1',
    });
    expect(server.requests.map((entry) => entry.body)).toEqual(['<Envelope/>', '<Envelope/>']);
    expect(server.sameSocket()).toBe(true);
    expect(provider.steps).toEqual(['', REPLY]);
  });

  it('never touches the provider when the server does not ask for Negotiate', async () => {
    const provider = fakeKerberos();
    configureKerberos(provider);
    server = await startNegotiateServer({ expectedToken: TOKEN, challenge: 'Basic realm="x"' });
    const result = await sendWithAuth(post(server.url), { type: 'kerberos' });
    expect(result.http.status).toBe(401);
    expect(result.auth).toMatchObject({ scheme: 'kerberos', challenged: true, attempts: 1 });
    expect(provider.inits).toEqual([]);
  });

  it('fails a second 401 as kerberos-rejected', async () => {
    configureKerberos(fakeKerberos());
    server = await startNegotiateServer({ expectedToken: TOKEN, rejectToken: true });
    await expect(sendWithAuth(post(server.url), { type: 'kerberos' })).rejects.toMatchObject({ code: 'kerberos-rejected' });
  });

  it('fails a reply that does not verify as kerberos-mutual-auth-failed', async () => {
    configureKerberos(fakeKerberos({ verifyFails: true }));
    server = await startNegotiateServer({ expectedToken: TOKEN, reply: REPLY });
    await expect(sendWithAuth(post(server.url), { type: 'kerberos' })).rejects.toMatchObject({
      code: 'kerberos-mutual-auth-failed',
    });
  });

  it('sends preemptively when asked: one request', async () => {
    configureKerberos(fakeKerberos());
    server = await startNegotiateServer({ expectedToken: TOKEN });
    const result = await kerberosHandshake(post(server.url), { type: 'kerberos' }, { preemptive: true });
    expect(result.attempts).toBe(1);
    expect(server.requests).toHaveLength(1);
  });

  it('lets a caller-supplied Authorization header win', async () => {
    const provider = fakeKerberos();
    configureKerberos(provider);
    server = await startNegotiateServer({ expectedToken: TOKEN });
    const result = await sendWithAuth({ ...post(server.url), headers: { authorization: `Negotiate ${TOKEN}` } }, { type: 'kerberos' });
    expect(result.http.status).toBe(200);
    expect(provider.inits).toEqual([]);
  });

  it('reports the 401 when the time budget is spent before leg 2', async () => {
    configureKerberos(fakeKerberos());
    server = await startNegotiateServer({ expectedToken: TOKEN });
    let clock = 0;
    const result = await sendWithAuth(post(server.url, 1000), { type: 'kerberos' }, { now: () => (clock += 600) });
    expect(result.http.status).toBe(401);
    expect(result.auth).toMatchObject({ challenged: true, attempts: 1 });
  });
});
```

- [ ] **Step 3: Run them to see them fail.**
Run: `pnpm vitest run --project engine-integration packages/engine/test/integration/auth/kerberos.test.ts`
Expected: FAIL, because `kerberos-transport.js` does not exist.

- [ ] **Step 4: Implement** `packages/engine/src/http/auth/kerberos-transport.ts`:

```ts
/**
 * Kerberos over HTTP Negotiate, Kerberos mechanism only (#40, R4). Two legs at most, on one
 * connection, as NTLM's are, because IIS ties an authenticated session to its socket:
 *
 *   leg 1  the real request, bare      → anything but 401 + Negotiate: that is the result
 *   leg 2  Authorization: Negotiate <token>, the real body again → the final response; a
 *          `WWW-Authenticate: Negotiate <reply>` on it is verified (mutual auth)
 *
 * The token is only made once the server asks, so an unchallenged send never loads the binding.
 * `preemptive` skips leg 1: an AP-REQ stands on its own, which an NTLM message does not.
 */

import type { Dispatcher } from 'undici';
import { HttpError } from '../../errors.js';
import { createSingleConnectionDispatcher, sendHttp } from '../client.js';
import { headerValue } from '../headers.js';
import type { HttpExchange, HttpRequest } from '../types.js';
import { defaultSpn, startKerberosContext, type KerberosSendAuth } from './kerberos-token.js';

export interface KerberosHandshakeResult {
  readonly http: HttpExchange;
  readonly attempts: 1 | 2;
  readonly challenged: boolean;
  readonly durationMs: number;
  /** The SPN asked for; before a token is made, the default in its written form. */
  readonly spn: string;
}

const EMPTY_BODY = new Uint8Array(0);

/** True when any challenge in the header is `Negotiate`, with or without a token. */
export function offersNegotiate(header: string | undefined): boolean {
  return header !== undefined && header.split(',').some((part) => /^\s*Negotiate(\s|$)/i.test(part));
}

/** The token in a `Negotiate <token>` challenge or reply, if there is one. */
export function negotiateToken(header: string | undefined): Uint8Array | undefined {
  for (const part of header?.split(',') ?? []) {
    const match = /^\s*Negotiate\s+([A-Za-z0-9+/=]+)\s*$/i.exec(part);
    if (match?.[1] !== undefined) return Buffer.from(match[1], 'base64');
  }
  return undefined;
}

export async function kerberosHandshake(
  request: HttpRequest,
  auth: KerberosSendAuth,
  options: { readonly now?: () => number; readonly dispatcher?: Dispatcher; readonly preemptive?: boolean } = {},
): Promise<KerberosHandshakeResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const remaining = (): number => request.timeoutMs - (now() - startedAt);
  const spnWanted = auth.spn ?? defaultSpn(request.url);

  let ownDispatcher: Dispatcher | undefined;
  let dispatcher = options.dispatcher;
  if (dispatcher === undefined) {
    ownDispatcher = createSingleConnectionDispatcher({
      ...(request.tls !== undefined ? { tls: request.tls } : {}),
      ...(request.proxy !== undefined ? { proxy: request.proxy } : {}),
      ...(request.localAddress !== undefined ? { localAddress: request.localAddress } : {}),
    });
    dispatcher = ownDispatcher;
  }
  const sendOptions = { dispatcher, ...(options.now !== undefined ? { now: options.now } : {}) };
  let durationMs = 0;
  const leg = async (headers: Readonly<Record<string, string>>): Promise<HttpExchange> => {
    const exchange = await sendHttp(
      { ...request, headers, body: request.body ?? EMPTY_BODY, timeoutMs: Math.max(1, remaining()) },
      sendOptions,
    );
    durationMs += exchange.timings.totalMs;
    return exchange;
  };

  try {
    let challenged = false;
    if (options.preemptive !== true) {
      const first = await leg(request.headers);
      if (first.status !== 401 || !offersNegotiate(headerValue(first.headers, 'www-authenticate'))) {
        return { http: first, attempts: 1, challenged: first.status === 401, durationMs, spn: spnWanted };
      }
      challenged = true;
      if (remaining() <= 0) return { http: first, attempts: 1, challenged, durationMs, spn: spnWanted };
    }

    const context = await startKerberosContext(spnWanted, auth);
    const final = await leg({ ...request.headers, Authorization: `Negotiate ${Buffer.from(context.token).toString('base64')}` });
    if (final.status === 401) {
      throw new HttpError('kerberos-rejected', `The server refused the Kerberos token for ${context.spn} (HTTP 401).`, {
        details: { spn: context.spn, status: 401 },
      });
    }
    const reply = negotiateToken(headerValue(final.headers, 'www-authenticate'));
    if (reply !== undefined) await context.verify(reply);
    return { http: final, attempts: options.preemptive === true ? 1 : 2, challenged, durationMs, spn: context.spn };
  } finally {
    if (ownDispatcher !== undefined) await ownDispatcher.close().catch(() => undefined);
  }
}
```

- [ ] **Step 5: Route it in `sendWithAuth`.** In `apply.ts`:
  - Import `kerberosHandshake` from `./kerberos-transport.js`.
  - After the `ntlmAuth` line (l.52), add
    `const kerberosAuth = auth?.type === 'kerberos' && !callerAuthorization ? auth : undefined;`.
  - Widen `let attempts: 1 | 2 | 3 = 1;`, which already fits, and add `let spn: string | undefined;`.
  - Turn the NTLM `if … else` (l.67–79) into `if / else if / else`:

```ts
  } else if (kerberosAuth !== undefined) {
    // Kerberos owns its exchange too: at most two legs on one connection, its own dispatcher.
    const handshake = await kerberosHandshake(firstRequest, kerberosAuth, {
      ...(options?.now !== undefined ? { now: options.now } : {}),
      ...(options?.dispatcher !== undefined ? { dispatcher: options.dispatcher } : {}),
    });
    http = handshake.http;
    durationMs = handshake.durationMs;
    challenged = handshake.challenged;
    attempts = handshake.attempts;
    spn = handshake.spn;
  } else {
```

  - The summary at l.103 becomes
    `{ auth: { scheme: auth.type, challenged, attempts, ...(spn !== undefined ? { spn } : {}) } }`.
  - Add to the module doc comment: "Kerberos (Negotiate) is a transport concern too: see
    `kerberos-transport.ts`."

- [ ] **Step 6: Run the tests to see them pass.** Same command as Step 3, then
`pnpm vitest run --project engine-integration packages/engine/test/integration/auth`. Expected:
PASS. NTLM, Basic and token are unchanged.

- [ ] **Step 7: Gate and commit.**

```bash
git add packages/engine/src/http/auth packages/engine/test/helpers/negotiate-server.ts packages/engine/test/integration/auth/kerberos.test.ts
git commit -m "feat(engine): the two-leg Kerberos Negotiate handshake in sendWithAuth"
```

### Task 5: Redaction and run-host reporting

**Files:**
- Modify: `packages/engine/src/redact/index.ts:19-60, 381`
- Modify: `packages/engine/src/run/send-helpers.ts:216-237` (`reportedAuth`)
- Test: `packages/engine/test/unit/redact/negotiate.test.ts` (new)

**Interfaces:**
- Produces: `maskNegotiateTokens(value: string): string`, exported from `redact/index.ts`.

- [ ] **Step 1: Read** `redact/index.ts:35-70` and `:375-395` for the exact signatures of
`redactHeaders` and `redactRawHttp`. If they take an options argument, pass `{}` in the tests below.

- [ ] **Step 2: Write the failing test**, `packages/engine/test/unit/redact/negotiate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { maskNegotiateTokens, redactHeaders, redactRawHttp } from '../../../src/redact/index.js';

describe('Negotiate tokens', () => {
  it('masks Authorization: Negotiate whole, as every Authorization is', () => {
    expect(redactHeaders({ Authorization: 'Negotiate YIIB' })).toEqual({ Authorization: '<redacted>' });
  });

  it('masks the token in WWW-Authenticate and keeps the rest of the challenge readable', () => {
    expect(maskNegotiateTokens('Negotiate oYG0MIGxoAMKAQA=, Basic realm="x"')).toBe('Negotiate <redacted>, Basic realm="x"');
    expect(maskNegotiateTokens('Negotiate')).toBe('Negotiate');
    expect(redactHeaders({ 'www-authenticate': 'Negotiate oYG0' })).toEqual({ 'www-authenticate': 'Negotiate <redacted>' });
  });

  it('masks it in raw HTTP too', () => {
    const raw = 'HTTP/1.1 200 OK\r\nWWW-Authenticate: Negotiate oYG0MIGx\r\n\r\nok';
    expect(redactRawHttp(raw)).toContain('WWW-Authenticate: Negotiate <redacted>');
  });
});
```

- [ ] **Step 3: Run it to see it fail.**
Run: `pnpm vitest run --project engine-unit packages/engine/test/unit/redact/negotiate.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement.** In `redact/index.ts`, below `isSensitiveHeaderName`:

```ts
/** A Negotiate reply token is a credential; the challenge's other schemes and realms stay readable. */
export function maskNegotiateTokens(value: string): string {
  return value.replace(/(^|,\s*)(Negotiate)\s+[A-Za-z0-9+/=]+/gi, '$1$2 <redacted>');
}

function isChallengeHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'www-authenticate' || lower === 'proxy-authenticate';
}
```

In `redactHeaders`, `redactHeaderPairs` and the per-line branch of `redactRawHttp`: where a header
is **not** masked, return `isChallengeHeader(name) ? maskNegotiateTokens(value) : value`.

- [ ] **Step 5: Report an explicit password.** In `send-helpers.ts` `reportedAuth`, before `default`:

```ts
    case 'kerberos':
      // The password never travels (SSPI uses it locally), but a server echoing it back is still masked.
      if (auth.password !== undefined) report(auth.password);
      break;
```

- [ ] **Step 6: Run the redact unit tests.** Run
`pnpm vitest run --project engine-unit packages/engine/test/unit/redact`. Expected: PASS.

- [ ] **Step 7: Gate and commit.**

```bash
git add packages/engine/src/redact/index.ts packages/engine/src/run/send-helpers.ts packages/engine/test/unit/redact/negotiate.test.ts
git commit -m "feat(engine): mask Negotiate tokens in challenges and report a Kerberos password"
```

### Task 6: Definition fetches: OpenAPI, AsyncAPI and WSDL

**Files:**
- Modify: `packages/engine/src/http/document-fetch.ts:158-190`
- Modify: `packages/engine/src/soap/import.ts:43-63, 162-166`, `packages/engine/src/soap/types.ts:58-67`
- Test: `packages/engine/test/integration/http/document-fetch-kerberos.test.ts` (new)

**Interfaces:**
- Consumes: `negotiateBearer` and `KerberosSendAuth` (Task 2); `createHttpFetchDocument` (`document-fetch.ts:236`).
- Produces: `WsdlImportOptions.auth?: { readonly username: string; readonly password: string } | KerberosSendAuth`.

- [ ] **Step 1: Read** the `WsdlImportSource` shape (`soap/types.ts`), the `FetchDocument` type and
its result's fields (`document-fetch.ts`), and `test/integration/http/document-fetch.test.ts:1-60`
for how it builds a source and reads a result. Use those shapes in the tests below, wherever they
differ from `{ kind: 'url', url }` and `.text`.

- [ ] **Step 2: Write the failing tests**, `packages/engine/test/integration/http/document-fetch-kerberos.test.ts`:

```ts
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { configureKerberos } from '../../../src/http/auth/kerberos-native.js';
import { createHttpFetchDocument } from '../../../src/http/document-fetch.js';
import { importWsdl } from '../../../src/soap/import.js';
import { fakeKerberos } from '../../helpers/fake-kerberos.js';

const TOKEN = Buffer.from('ap-req').toString('base64');
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  configureKerberos(undefined);
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** Serves `body` only to `Negotiate <TOKEN>`; with `redirectTo`, redirects every request there first. */
async function serve(body: string, redirectTo?: () => string): Promise<{ url: string; seen: (string | undefined)[] }> {
  const seen: (string | undefined)[] = [];
  const server = createServer((request, response) => {
    seen.push(request.headers.authorization);
    if (redirectTo !== undefined) {
      response.writeHead(302, { Location: redirectTo() }).end();
      return;
    }
    if (request.headers.authorization !== `Negotiate ${TOKEN}`) {
      response.writeHead(401, { 'WWW-Authenticate': 'Negotiate' }).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/plain' }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/doc`, seen };
}

describe('Kerberos on definition fetches', () => {
  it('attaches a preemptive Negotiate token on a same-origin hop', async () => {
    configureKerberos(fakeKerberos());
    const doc = await serve('openapi: 3.1.0');
    const fetch = createHttpFetchDocument({ auth: { type: 'kerberos' }, authOrigin: new URL(doc.url).origin });
    await expect(fetch(doc.url)).resolves.toMatchObject({ text: 'openapi: 3.1.0' });
    expect(doc.seen).toEqual([`Negotiate ${TOKEN}`]);
  });

  it('never sends it to another origin', async () => {
    configureKerberos(fakeKerberos());
    const other = await serve('x');
    const first = await serve('', () => other.url);
    const fetch = createHttpFetchDocument({ auth: { type: 'kerberos' }, authOrigin: new URL(first.url).origin });
    await expect(fetch(first.url)).rejects.toMatchObject({ code: 'definition-auth-required' });
    expect(other.seen).toEqual([undefined]);
  });

  it('imports a WSDL with Kerberos through the origin-scoped fetcher', async () => {
    configureKerberos(fakeKerberos());
    const wsdl = await serve('<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" name="Empty"/>');
    await importWsdl({ kind: 'url', url: wsdl.url }, { auth: { type: 'kerberos' } });
    expect(wsdl.seen[0]).toBe(`Negotiate ${TOKEN}`);
  });
});
```

- [ ] **Step 3: Run them to see them fail.**
Run: `pnpm vitest run --project engine-integration packages/engine/test/integration/http/document-fetch-kerberos.test.ts`
Expected: FAIL. No header is sent, so a 401 → `definition-auth-required`.

- [ ] **Step 4: Implement the per-hop token.** In `document-fetch.ts` `fetchHttp`, import
`negotiateBearer` from `./auth/kerberos-token.js`, and replace
`const { url, headers } = credentialsFor(bare, options);` (l.169) with:

```ts
    // Kerberos makes a fresh token per same-origin hop; `credentialsFor` stays synchronous for the rest.
    const sameOrigin = options.authOrigin !== undefined && new URL(bare).origin === options.authOrigin;
    const hopOptions: DocumentFetchOptions =
      options.auth?.type !== 'kerberos'
        ? options
        : sameOrigin
          ? { ...options, auth: await negotiateBearer(options.auth, bare) }
          : { ...(options.network !== undefined ? { network: options.network } : {}) };
    const { url, headers } = credentialsFor(bare, hopOptions);
```

A `kerberos-*` error propagates as is: it is not a fetch failure.

- [ ] **Step 5: Use it for a Kerberos WSDL.** In `soap/types.ts`, widen `WsdlImportOptions.auth` to
`{ readonly username: string; readonly password: string } | KerberosSendAuth`, with a type import from
`../http/auth/kerberos-token.js`. In `soap/import.ts`, move `const definitionSource = toDefinitionSource(source);`
above the fetcher, and replace l.165 with:

```ts
  const auth = options?.auth;
  const fetchDocument =
    auth === undefined
      ? baseFetch
      : 'type' in auth
        ? kerberosFetch(baseFetch, auth, definitionSource.location)
        : withBasicAuth(baseFetch, auth);
```

Below `withBasicAuth`, add the following. Match the parameter list of `FetchDocument` as declared:

```ts
/**
 * Kerberos for a WSDL fetch goes through the origin-scoped document fetcher, so a token reaches only
 * the WSDL's own origin; `file:` locations and inline sources fall back to `base`.
 */
function kerberosFetch(base: FetchDocument, auth: KerberosSendAuth, location: string): FetchDocument {
  if (!/^https?:/i.test(location)) return base;
  const web = createHttpFetchDocument({ auth, authOrigin: new URL(location).origin });
  return (target, signal) => (/^https?:/i.test(target) ? web(target, signal) : base(target, signal));
}
```

Import `createHttpFetchDocument` from `../http/document-fetch.js`. `soap/` may import `http/`
(core), as `scripts/engine-import-graph.mjs` allows.

- [ ] **Step 6: Run the tests.** Same command, then
`pnpm vitest run --project engine-integration packages/engine/test/integration/http`, then
`pnpm check:engine-layers`. Expected: PASS.

- [ ] **Step 7: Gate and commit.**

```bash
git add packages/engine/src/http/document-fetch.ts packages/engine/src/soap/import.ts packages/engine/src/soap/types.ts packages/engine/test/integration/http/document-fetch-kerberos.test.ts
git commit -m "feat(engine): Kerberos for OpenAPI, AsyncAPI and WSDL fetches, same origin only"
```

### Task 7: WebSocket and gRPC

**Files:**
- Modify: `packages/engine/src/http/auth/kerberos-token.ts` (add `withNegotiate`)
- Modify: `packages/engine/src/ws/run.ts:169-185`, `packages/engine/src/ws/call.ts:79-103`
- Modify: `packages/engine/src/grpc/send.ts:137-159, 295-300`
- Modify: `apps/desktop/src/main/ipc/request.ts:965-980` (`wsCommand`: Kerberos never reaches `toWsSessionOptions`)
- Test: `packages/engine/test/unit/http/auth/kerberos-token.test.ts` (extend), the existing `ws/run` and gRPC unit tests (extend)

**Interfaces:**
- Consumes: `negotiateBearer` (Task 2).
- Produces: `withNegotiate<T extends { type: string }>(auth: T | undefined, url: string, options?): Promise<T | NegotiateBearer | undefined>`.

- [ ] **Step 1: Write the failing helper tests.** Append to `kerberos-token.test.ts`:

```ts
describe('withNegotiate', () => {
  it('turns Kerberos into one preemptive Negotiate bearer', async () => {
    await expect(
      withNegotiate({ type: 'kerberos' }, 'wss://svc.corp/ws', { provider: fakeKerberos(), platform: 'linux' }),
    ).resolves.toEqual({ type: 'bearer', scheme: 'Negotiate', token: Buffer.from('ap-req').toString('base64') });
  });

  it('leaves every other scheme alone', async () => {
    const basic = { type: 'basic', username: 'u', password: 'p', preemptive: true } as const;
    await expect(withNegotiate(basic, 'wss://x')).resolves.toBe(basic);
    await expect(withNegotiate(undefined, 'wss://x')).resolves.toBeUndefined();
  });
});
```

Add `withNegotiate` to that file's import. Run it, and see it fail.

- [ ] **Step 2: Implement the helper.** Append to `kerberos-token.ts`:

```ts
export type NegotiateBearer = { readonly type: 'bearer'; readonly scheme: 'Negotiate'; readonly token: string };

/** The credential for a one-request path: Kerberos becomes a preemptive Negotiate bearer; the rest pass. */
export async function withNegotiate<T extends { readonly type: string }>(
  auth: T | undefined,
  url: string,
  options?: KerberosOptions,
): Promise<T | NegotiateBearer | undefined> {
  return auth?.type === 'kerberos' ? negotiateBearer(auth as unknown as KerberosSendAuth, url, options) : auth;
}
```

Run Step 1's tests, and see them pass.

- [ ] **Step 3: Wire WebSocket, test first.** Find the `connectWs` tests with
`grep -rln "connectWs\|runWs\|ws/run" packages/engine/test`. Add a case mirroring that file's Bearer
case:
  - a request whose effective auth is `{ type: 'kerberos' }`;
  - with `configureKerberos(fakeKerberos())`;
  - the session options' headers carry
    `Authorization: Negotiate ${Buffer.from('ap-req').toString('base64')}`.

Run it, and see it fail. Then, in `ws/run.ts` `connectWs`, after `const auth = await authFor(…)`:

```ts
  // A handshake is one request: Kerberos goes on preemptively as a Negotiate header.
  const sendAuth = await withNegotiate(auth, dialledUrl(input).replace(/^ws/, 'http'));
```

Pass `sendAuth` instead of `auth` to `toWsSessionOptions`. In `ws/call.ts` `authHeadersAndQuery`, add
this before the NTLM guard, so a caller that skips `withNegotiate` gets a clear error rather than an
empty header:

```ts
  if (auth.type === 'kerberos') {
    throw new WsError(
      'ws-auth-unsupported',
      'Kerberos needs a Negotiate token made first (withNegotiate) before the session options are built.',
      { details: { type: auth.type } },
    );
  }
```

In the desktop `wsCommand` (`ipc/request.ts:972`), replace a Kerberos `auth` with `undefined`
before `toWsSessionOptions`. Push the note
`'Kerberos is not expressible in this command; the upgrade is shown without authorization.'` into
its `notes`. Run the ws tests, and see them pass.

- [ ] **Step 4: Wire gRPC, test first.** In the existing gRPC send unit test (`grep -rln "buildGrpcHeaders\|sendGrpc" packages/engine/test/unit`),
add a case:
  - `configureKerberos(fakeKerberos())`;
  - call `sendGrpc` against the in-process gRPC test server that file already uses, with
    `auth: { type: 'kerberos' }`;
  - assert that the server saw metadata `authorization: Negotiate ${Buffer.from('ap-req').toString('base64')}`.

If that file only covers `buildGrpcHeaders`, use the integration gRPC test with a server instead
(`grep -rln "sendGrpc" packages/engine/test/integration`). Run it, and see it fail.

Then, in `grpc/send.ts` `sendGrpc`, replace l.300 with:

```ts
  // One token per call, at call start: an HTTP/2 stream has no 401 to wait for.
  const callAuth = await withNegotiate(input.auth, `${target.tls ? 'https' : 'http'}://${target.authority}`);
  const requestHeaders = buildGrpcHeaders(callAuth === input.auth ? input : { ...input, auth: callAuth }, target);
```

`authHeaders`'s `default` arm still throws `grpc-auth-unsupported` for anything left. Change its
message to `` `${auth.type} cannot authenticate a gRPC call directly; …` ``, keeping the rest of the
existing text. Run it, and see it pass.

- [ ] **Step 5: Run the suites.** Run `pnpm vitest run --project engine-unit` and
`pnpm vitest run --project engine-integration packages/engine/test/integration/grpc packages/engine/test/integration/ws`.
Expected: PASS.

- [ ] **Step 6: Gate and commit.**

```bash
git add packages/engine/src/http/auth/kerberos-token.ts packages/engine/src/ws packages/engine/src/grpc/send.ts packages/engine/test apps/desktop/src/main/ipc/request.ts
git commit -m "feat(engine): preemptive Kerberos on the WebSocket upgrade and on gRPC calls"
```

### Task 8: Exports, CLI and MCP

**Files:**
- Modify: `packages/engine/src/index.ts` (after l.391; near l.929–934; the model type exports)
- Test: `packages/cli/test/integration/kerberos-run.test.ts` (new), plus the MCP send test (extend)

**Interfaces:**
- Produces:
  - engine root value exports: `configureKerberos`, `kerberosProvider`, `loadKerberosProvider`,
    `kerberosToken`, `startKerberosContext`, `negotiateBearer`, `withNegotiate`, `normaliseSpn`,
    `defaultSpn`, `kerberosAuthSchema`, `GSS_MECH_OID_KRB5`, `GSS_C_MUTUAL_FLAG`;
  - engine root type exports: `KerberosAvailability`, `KerberosProvider`, `KerberosClientLike`,
    `KerberosInitInput`, `KerberosCredentials`, `KerberosContext`, `KerberosOptions`,
    `KerberosSendAuth`, `NegotiateBearer`, `KerberosAuth`.

- [ ] **Step 1: Export.** After l.391 in `index.ts`:

```ts
export {
  GSS_C_MUTUAL_FLAG,
  GSS_MECH_OID_KRB5,
  configureKerberos,
  kerberosProvider,
  loadKerberosProvider,
} from './http/auth/kerberos-native.js';
export type { KerberosAvailability, KerberosClientLike, KerberosInitInput, KerberosProvider } from './http/auth/kerberos-native.js';
export {
  defaultSpn,
  kerberosToken,
  negotiateBearer,
  normaliseSpn,
  startKerberosContext,
  withNegotiate,
} from './http/auth/kerberos-token.js';
export type {
  KerberosContext,
  KerberosCredentials,
  KerberosOptions,
  KerberosSendAuth,
  NegotiateBearer,
} from './http/auth/kerberos-token.js';
```

Add `kerberosAuthSchema` to the schema export at l.929–934, and `KerberosAuth` to the model type
export that lists `OAuth2Auth`.

- [ ] **Step 2: Write the failing CLI test.** Find the closest CLI integration test that runs a REST
request against a local server: `grep -ln "createServer\|listen(0" packages/cli/test/integration`.
Copy its harness into `packages/cli/test/integration/kerberos-run.test.ts`. The project's REST
request has `auth: { type: kerberos }` and targets `startNegotiateServer`, imported from
`@wirebench/engine/test-helpers`. If the helper is not re-exported there, add it to
`packages/engine/test/helpers/index.ts`.

Two cases:
  - **Available:** with `configureKerberos(fakeKerberos())` set in-process, before the harness runs
    the CLI's `main`, the run exits `0`;
  - **Unavailable:** with `configureKerberos(fakeKerberos({ unavailable: 'The Kerberos component is not installed.' }))`,
    the request is errored, the exit code is `3`, and the JSON report's request error code is
    `kerberos-unavailable`.

If that harness spawns a child process instead of running in-process, keep only the unavailable
case. Make the binding unloadable in the child with `NODE_OPTIONS=--require=<fixture>`, where the
fixture patches `Module._resolveFilename` so that `kerberos/package.json` throws `MODULE_NOT_FOUND`.
Say so in a comment.

- [ ] **Step 3: Run it.** Run `pnpm vitest run --project cli-integration packages/cli/test/integration/kerberos-run.test.ts`.
Expected: PASS. `authFor` → `resolveAuthConfig` gives the Kerberos `SendAuth`, `sendWithAuth` handles
it, and `run/run.ts:484` turns a throw into `errored`. If it fails, fix only the runner path the
failure names.

- [ ] **Step 4: MCP.** Find the MCP send test (`grep -rln "tools/call\|send_request\|mcp" packages/cli/test`).
Add one case: a Kerberos request with an unavailable provider returns the tool error carrying
`kerberos-unavailable`. Run that file. Expected: PASS.

- [ ] **Step 5: Gate and commit.**

```bash
git add packages/engine/src/index.ts packages/engine/test/helpers packages/cli/test
git commit -m "feat(engine): export the Kerberos seam; the CLI and MCP send with it"
```

### Task 9: A real KDC in CI

**Files:**
- Create: `scripts/ci/kerberos-kdc.sh`
- Create: `packages/engine/test/helpers/kerberos-gate.ts`
- Test: `packages/engine/test/integration/auth/kerberos-real.test.ts`
- Modify: `.github/workflows/ci.yml` (add job `kerberos-integration` after `server-integration`)

- [ ] **Step 1: Write the realm script**, `scripts/ci/kerberos-kdc.sh`. It is CI-only and builds a
throwaway realm with generated keys:

```bash
#!/usr/bin/env bash
# Builds a throwaway MIT Kerberos realm on a CI runner for
# packages/engine/test/integration/auth/kerberos-real.test.ts. Every key is generated here and lives
# under $KRB_DIR; nothing is a real credential.
set -euo pipefail
KRB_DIR="${KRB_DIR:-$RUNNER_TEMP/krb}"
REALM=WIREBENCH.TEST
mkdir -p "$KRB_DIR"
cat > "$KRB_DIR/krb5.conf" <<EOF
[libdefaults]
  default_realm = $REALM
  dns_lookup_kdc = false
  dns_lookup_realm = false
  rdns = false
  dns_canonicalize_hostname = false
[realms]
  $REALM = {
    kdc = 127.0.0.1:88
    admin_server = 127.0.0.1:749
  }
[domain_realm]
  localhost = $REALM
EOF
sudo cp "$KRB_DIR/krb5.conf" /etc/krb5.conf
sudo mkdir -p /etc/krb5kdc
printf '[realms]\n  %s = {\n    acl_file = /etc/krb5kdc/kadm5.acl\n  }\n' "$REALM" | sudo tee /etc/krb5kdc/kdc.conf >/dev/null
echo '*/admin *' | sudo tee /etc/krb5kdc/kadm5.acl >/dev/null
sudo kdb5_util create -s -r "$REALM" -P "$(openssl rand -hex 16)"
sudo kadmin.local -q "addprinc -randkey alice@$REALM"
sudo kadmin.local -q "addprinc -randkey HTTP/localhost@$REALM"
sudo kadmin.local -q "ktadd -k $KRB_DIR/alice.keytab alice@$REALM"
sudo kadmin.local -q "ktadd -k $KRB_DIR/http.keytab HTTP/localhost@$REALM"
sudo chown "$(id -u)" "$KRB_DIR"/*.keytab
sudo systemctl restart krb5-kdc
{
  echo "KRB5_CONFIG=$KRB_DIR/krb5.conf"
  echo "KRB5_KTNAME=$KRB_DIR/http.keytab"
  echo "KRB5CCNAME=FILE:$KRB_DIR/ccache"
  echo "WIREBENCH_KRB_CLIENT_KEYTAB=$KRB_DIR/alice.keytab"
} >> "$GITHUB_ENV"
```

- [ ] **Step 2: Write the gate**, `packages/engine/test/helpers/kerberos-gate.ts`. It mirrors
`packages/server/test/helpers/database.ts:11-22`:

```ts
import { describe } from 'vitest';

/** Runs only in the `kerberos-integration` CI job, which builds a realm first; skips, saying so, elsewhere. */
export const describeKerberos = (name: string, factory: () => void): void => {
  if (process.env['WIREBENCH_KERBEROS_TESTS'] === '1') {
    describe(name, factory);
    return;
  }
  console.warn(`Skipping "${name}": set WIREBENCH_KERBEROS_TESTS=1 after scripts/ci/kerberos-kdc.sh to run it.`);
  describe.skip(name, factory);
};
```

- [ ] **Step 3: Write the test**, `packages/engine/test/integration/auth/kerberos-real.test.ts`. The
server side uses the same package's `KerberosServer`, through the package's own JavaScript:

```ts
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { sendWithAuth } from '../../../src/http/auth/apply.js';
import { kerberosToken } from '../../../src/http/auth/kerberos-token.js';
import { describeKerberos } from '../../helpers/kerberos-gate.js';

interface ServerContext {
  step(token: string): Promise<string>;
  readonly username: string;
}
const load = () => createRequire(import.meta.url)('kerberos') as { initializeServer(service: string): Promise<ServerContext> };

describeKerberos('Kerberos against a real KDC', () => {
  let server: Server | undefined;
  let url = '';
  const users: string[] = [];

  beforeAll(async () => {
    execFileSync('kinit', ['-kt', process.env['WIREBENCH_KRB_CLIENT_KEYTAB'] ?? '', 'alice@WIREBENCH.TEST']);
    const kerberos = load();
    server = createServer((request, response) => {
      const header = request.headers.authorization;
      if (header?.startsWith('Negotiate ') !== true) {
        response.writeHead(401, { 'WWW-Authenticate': 'Negotiate' }).end();
        return;
      }
      void kerberos.initializeServer('HTTP@localhost').then(
        async (context) => {
          const reply = await context.step(header.slice('Negotiate '.length));
          users.push(context.username);
          response.writeHead(200, { 'WWW-Authenticate': `Negotiate ${reply}` }).end('ok');
        },
        () => response.writeHead(401).end(),
      );
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    url = `http://localhost:${(server.address() as AddressInfo).port}/svc`;
  });

  afterAll(() => {
    server?.close();
  });

  const get = () => ({ url, method: 'GET' as const, headers: {}, timeoutMs: 10_000, followRedirects: false });

  it('authenticates with the signed-in ticket and verifies the server (SC-K1)', async () => {
    const result = await sendWithAuth(get(), { type: 'kerberos' });
    expect(result.http.status).toBe(200);
    expect(result.auth).toMatchObject({ scheme: 'kerberos', challenged: true, attempts: 2, spn: 'HTTP@localhost' });
    expect(users.at(-1)).toBe('alice@WIREBENCH.TEST');
  });

  it('makes a token a real acceptor accepts (the #41 seam, SC-K10)', async () => {
    const token = await kerberosToken('HTTP@localhost', {});
    const context = await load().initializeServer('HTTP@localhost');
    await context.step(Buffer.from(token).toString('base64'));
    expect(context.username).toBe('alice@WIREBENCH.TEST');
  });

  it('names an SPN the KDC does not know', async () => {
    await expect(sendWithAuth(get(), { type: 'kerberos', spn: 'HTTP/nowhere.invalid' })).rejects.toMatchObject({
      code: 'kerberos-unknown-spn',
    });
  });

  it('says there is no ticket after kdestroy', async () => {
    execFileSync('kdestroy');
    await expect(sendWithAuth(get(), { type: 'kerberos' })).rejects.toMatchObject({ code: 'kerberos-no-credentials' });
  });
});
```

- [ ] **Step 4: Run it locally to see it skip.**
Run: `pnpm vitest run --project engine-integration packages/engine/test/integration/auth/kerberos-real.test.ts`
Expected: 4 skipped, plus the warning line.

- [ ] **Step 5: Add the CI job** to `.github/workflows/ci.yml`, after `server-integration`:

```yaml
  # Kerberos against a real MIT KDC (#40): the real binding and the real GSSAPI, end to end. `check`
  # runs the same file with WIREBENCH_KERBEROS_TESTS unset (it skips, saying so); this job builds a
  # throwaway realm and runs it for real, once, on Linux.
  kerberos-integration:
    runs-on: ubuntu-latest
    defaults:
      run:
        shell: bash
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: pnpm
      - run: sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y krb5-kdc krb5-admin-server krb5-user libkrb5-dev
      - run: bash scripts/ci/kerberos-kdc.sh
      - run: pnpm install --frozen-lockfile
      - run: WIREBENCH_KERBEROS_TESTS=1 pnpm vitest run --project engine-integration packages/engine/test/integration/auth/kerberos-real.test.ts
```

- [ ] **Step 6: Gate and commit.**

```bash
git add scripts/ci/kerberos-kdc.sh packages/engine/test/helpers/kerberos-gate.ts packages/engine/test/integration/auth/kerberos-real.test.ts .github/workflows/ci.yml
git commit -m "test(engine): Kerberos end to end against a throwaway MIT KDC in CI"
```

- [ ] **Step 7: Open PR 1.** Push, then open it titled
"feat(engine): Kerberos/SPNEGO authentication (#40, 1 of 2)". The body:
  - lists D1–D4 and D8 as done, and the spec amendments relied on;
  - says the desktop app does not offer the scheme yet;
  - names `kerberosToken` as the seam #41 waits for.

Tell the #41 session the PR number. Wait for CI to go green, `kerberos-integration` included. If that
job fails on realm set-up, fix `kerberos-kdc.sh` from the job log. Merge with `gh pr merge --merge`.

---

## PR 2 — desktop

Branch: `git worktree add git-worktrees/40-kerberos-desktop -b feat/40-kerberos-desktop main`, after
PR 1 is merged, then `pnpm install`.

### Task 10: Vendor the prebuilt binaries

**Files:**
- Create: `scripts/kerberos-prebuilds.json`
- Create: `scripts/vendor-kerberos.ts`, `scripts/vendor-kerberos.test.ts`
- Modify: root `package.json` scripts `package`, `package:mac`, `package:win`, `package:linux`
- Modify: `.gitignore` (add `apps/desktop/build-resources/`)

**Interfaces:**
- Produces:
  - `vendorKerberos(options: { platform: 'darwin' | 'linux' | 'win32'; outDir: string; pins?: Record<string, string>; fetchBytes?: (url: string) => Promise<Buffer> }): Promise<string[]>`;
  - `tarEntry(name: string, data: Buffer): Buffer`, used by tests;
  - CLI `node scripts/vendor-kerberos.ts [platform]`.

- [ ] **Step 1: Write the pin file**, `scripts/kerberos-prebuilds.json`. Its values come from
**Prebuilt binaries (pinned)**:

```json
{
  "version": "7.0.0",
  "napi": 9,
  "url": "https://github.com/mongodb-js/kerberos/releases/download/v{version}/kerberos-v{version}-napi-v{napi}-{prebuild}.tar.gz",
  "entry": "build/Release/kerberos.node",
  "prebuilds": {
    "darwin-arm64": "a5587d6744fae4daa3f569156866a5d9d62004a431c0cb79c46010f62219c18f",
    "darwin-x64": "a5587d6744fae4daa3f569156866a5d9d62004a431c0cb79c46010f62219c18f",
    "linux-arm64": "3fc5d80d7085e601004107c910185c51d4a5d71733bbd58b43cf4e974096c2b0",
    "linux-x64": "97613f37eeb336f61c19763959dae6245657b11ff0f725a4c3d276ba6ebf135d",
    "win32-x64": "86ab38f3a3463fcf35ab458faa3ecd9fa510dfdc260c682869ca8327b6728515"
  }
}
```

- [ ] **Step 2: Read** `scripts/lib/tar.ts:15-70` for `TarEntry`'s field names. They are assumed below
to be `name` and `data`; use the real ones.

- [ ] **Step 3: Write the failing test**, `scripts/vendor-kerberos.test.ts`:

```ts
import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { tarEntry, vendorKerberos } from './vendor-kerberos.ts';

/** A one-entry ustar archive, gzipped: the shape of a real prebuild tarball. */
function tarball(content: string): Buffer {
  return gzipSync(Buffer.concat([tarEntry('build/Release/kerberos.node', Buffer.from(content)), Buffer.alloc(1024)]));
}
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

describe('vendorKerberos', () => {
  it('writes every prebuild of the platform when its hash matches', async () => {
    const bytes = tarball('fat-binary');
    const outDir = await mkdtemp(join(tmpdir(), 'krb-'));
    const written = await vendorKerberos({
      platform: 'darwin',
      outDir,
      pins: { 'darwin-arm64': sha(bytes), 'darwin-x64': sha(bytes), 'linux-x64': 'x' },
      fetchBytes: () => Promise.resolve(bytes),
    });
    expect(written.map((path) => path.slice(outDir.length + 1)).sort()).toEqual([
      join('darwin-arm64', 'kerberos.node'),
      join('darwin-x64', 'kerberos.node'),
    ]);
    await expect(readFile(join(outDir, 'darwin-x64', 'kerberos.node'), 'utf8')).resolves.toBe('fat-binary');
  });

  it('fails the build on a hash mismatch', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'krb-'));
    await expect(
      vendorKerberos({ platform: 'linux', outDir, pins: { 'linux-x64': '00' }, fetchBytes: () => Promise.resolve(tarball('x')) }),
    ).rejects.toThrow(/SHA-256 mismatch for linux-x64/);
  });

  it('vendors only what is pinned: win32 has x64 alone', async () => {
    const bytes = tarball('w');
    const outDir = await mkdtemp(join(tmpdir(), 'krb-'));
    const written = await vendorKerberos({ platform: 'win32', outDir, pins: { 'win32-x64': sha(bytes) }, fetchBytes: () => Promise.resolve(bytes) });
    expect(written).toEqual([join(outDir, 'win32-x64', 'kerberos.node')]);
  });

  it('pins a real hash for every prebuild', async () => {
    const pins = JSON.parse(await readFile(join(import.meta.dirname, 'kerberos-prebuilds.json'), 'utf8')) as { prebuilds: Record<string, string> };
    for (const value of Object.values(pins.prebuilds)) expect(value).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 4: Run it to see it fail.**
Run: `pnpm vitest run --project scripts scripts/vendor-kerberos.test.ts`. Expected: FAIL.

- [ ] **Step 5: Implement** `scripts/vendor-kerberos.ts`:

```ts
/**
 * Vendors the Kerberos binding for every architecture of one platform into
 * apps/desktop/build-resources/kerberos/<platform>-<arch>/kerberos.node (ADR-0019).
 *
 * The release jobs pack several architectures from one install with npmRebuild off, so the
 * installed binary only matches the runner; this downloads the pinned prebuilds instead and refuses
 * any whose SHA-256 differs from scripts/kerberos-prebuilds.json.
 *
 *   node scripts/vendor-kerberos.ts [darwin|linux|win32]
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTarGz } from './lib/tar.ts';

interface PinFile {
  readonly version: string;
  readonly napi: number;
  readonly url: string;
  readonly entry: string;
  readonly prebuilds: Readonly<Record<string, string>>;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PIN_FILE = join(ROOT, 'scripts', 'kerberos-prebuilds.json');
export const DEFAULT_OUT_DIR = join(ROOT, 'apps', 'desktop', 'build-resources', 'kerberos');

export async function vendorKerberos(options: {
  readonly platform: 'darwin' | 'linux' | 'win32';
  readonly outDir: string;
  readonly pins?: Readonly<Record<string, string>>;
  readonly fetchBytes?: (url: string) => Promise<Buffer>;
}): Promise<string[]> {
  const file = JSON.parse(await readFile(PIN_FILE, 'utf8')) as PinFile;
  const pins = options.pins ?? file.prebuilds;
  const fetchBytes = options.fetchBytes ?? download;
  const extracted: (readonly [string, Uint8Array])[] = [];
  for (const prebuild of Object.keys(pins).filter((name) => name.startsWith(`${options.platform}-`))) {
    const url = file.url
      .replaceAll('{version}', file.version)
      .replace('{napi}', String(file.napi))
      .replace('{prebuild}', prebuild);
    const bytes = await fetchBytes(url);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== pins[prebuild]) {
      throw new Error(`SHA-256 mismatch for ${prebuild}: expected ${pins[prebuild]}, got ${actual} (${url})`);
    }
    const entry = readTarGz(new Uint8Array(bytes)).find((candidate) => candidate.name === file.entry);
    if (entry === undefined) throw new Error(`${prebuild}: ${file.entry} is not in the tarball`);
    extracted.push([prebuild, entry.data]);
  }
  // Everything is verified before anything is written: a mismatch leaves the previous folder as it was.
  await rm(options.outDir, { recursive: true, force: true });
  const written: string[] = [];
  for (const [prebuild, data] of extracted) {
    const target = join(options.outDir, prebuild, 'kerberos.node');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
    written.push(target);
  }
  return written;
}

async function download(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'wirebench-build' } });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/** A ustar header plus padded body for one regular file: the test's fixture tarballs. */
export function tarEntry(name: string, data: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write('0', 156);
  header.write('ustar\u000000', 257);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const platform = (process.argv[2] ?? process.platform) as 'darwin' | 'linux' | 'win32';
  const written = await vendorKerberos({ platform, outDir: DEFAULT_OUT_DIR });
  console.log(`kerberos: vendored ${written.length} binding(s) for ${platform}`);
}
```

- [ ] **Step 6: Run the test to see it pass.** Same command. Expected: PASS, 4 tests.

- [ ] **Step 7: Run vendoring from the packaging scripts.** In root `package.json`:

```json
    "package": "pnpm build && node scripts/vendor-kerberos.ts && pnpm --filter @wirebench/desktop package",
    "package:mac": "pnpm build && node scripts/vendor-kerberos.ts darwin && pnpm --filter @wirebench/desktop package:mac",
    "package:win": "pnpm build && node scripts/vendor-kerberos.ts win32 && pnpm --filter @wirebench/desktop package:win",
    "package:linux": "pnpm build && node scripts/vendor-kerberos.ts linux && pnpm --filter @wirebench/desktop package:linux",
```

Add `apps/desktop/build-resources/` to `.gitignore`.

- [ ] **Step 8: Gate and commit.**

```bash
git add scripts/kerberos-prebuilds.json scripts/vendor-kerberos.ts scripts/vendor-kerberos.test.ts package.json .gitignore
git commit -m "build: vendor the pinned, hash-checked Kerberos prebuilds per architecture"
```

### Task 11: Package them, check them, and list the licence

**Files:**
- Modify: `apps/desktop/electron-builder.yml` (l.37–49 and the `mac:` block, l.59–79)
- Create: `scripts/check-kerberos-vendor.ts`, `scripts/check-kerberos-vendor.test.ts`
- Modify: `.github/workflows/release.yml` (`build` after `Package`; `win-unpacked` around l.320)
- Modify: `scripts/third-party-licenses.ts:172, 248-250`, `scripts/third-party-licenses.test.ts`; regenerate `THIRD-PARTY-LICENSES.md`
- Modify: `docs/release.md:73-91`, plus a new section

- [ ] **Step 1: Ship the folder.** In `electron-builder.yml`:

```yaml
# Regenerated and verified by `pnpm licenses:third-party [--check]`.
# `kerberos/` is vendored by `scripts/vendor-kerberos.ts`, one binding per architecture (ADR-0019);
# it sits outside the asar so the OS loader can map it, and it is signed with the app.
extraResources:
  - from: ../../THIRD-PARTY-LICENSES.md
    to: THIRD-PARTY-LICENSES.md
  - from: build-resources/kerberos
    to: kerberos
```

Replace the `npmRebuild` comment:

```yaml
# pnpm's store is already exactly what should ship. The one native module, the Kerberos binding, is
# vendored per architecture instead of rebuilt (ADR-0019); running npm against a symlinked tree only
# risks flattening it.
npmRebuild: false
```

In `mac:`, add:

```yaml
  # The Kerberos binding is one universal (fat) file, the same in the x64 and arm64 builds; the
  # universal merge refuses identical Mach-O files it is not told about.
  x64ArchFiles: Contents/Resources/kerberos/**
```

- [ ] **Step 2: Write the failing check test**, `scripts/check-kerberos-vendor.test.ts`:

```ts
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkKerberosVendor } from './check-kerberos-vendor.ts';

async function resources(prebuilds: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'res-'));
  for (const prebuild of prebuilds) {
    await mkdir(join(dir, 'kerberos', prebuild), { recursive: true });
    await writeFile(join(dir, 'kerberos', prebuild, 'kerberos.node'), 'x');
  }
  return dir;
}

describe('checkKerberosVendor', () => {
  it('passes when every pinned prebuild of the platform is there', async () => {
    const dir = await resources(['linux-x64', 'linux-arm64']);
    expect(checkKerberosVendor({ platform: 'linux', resourcesDirs: [dir], loadHost: false })).toEqual([]);
  });

  it('names each missing binding', async () => {
    const dir = await resources(['linux-x64']);
    expect(checkKerberosVendor({ platform: 'linux', resourcesDirs: [dir], loadHost: false })).toEqual([
      `${join(dir, 'kerberos', 'linux-arm64', 'kerberos.node')} is missing`,
    ]);
  });
});
```

- [ ] **Step 3: Run it to see it fail.**
Run: `pnpm vitest run --project scripts scripts/check-kerberos-vendor.test.ts`. Expected: FAIL.

- [ ] **Step 4: Implement** `scripts/check-kerberos-vendor.ts`:

```ts
/**
 * Asserts that each unpacked desktop build carries the Kerberos binding for every architecture of its
 * platform that has a pinned prebuild, and that the one for this machine loads.
 *
 *   node scripts/check-kerberos-vendor.ts <platform> <resources dir>...
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PIN_FILE = join(dirname(fileURLToPath(import.meta.url)), 'kerberos-prebuilds.json');

export function checkKerberosVendor(options: {
  readonly platform: string;
  readonly resourcesDirs: readonly string[];
  readonly loadHost: boolean;
}): string[] {
  const pins = JSON.parse(readFileSync(PIN_FILE, 'utf8')) as { prebuilds: Record<string, string> };
  const wanted = Object.keys(pins.prebuilds).filter((prebuild) => prebuild.startsWith(`${options.platform}-`));
  const problems: string[] = [];
  for (const dir of options.resourcesDirs) {
    for (const prebuild of wanted) {
      const path = join(dir, 'kerberos', prebuild, 'kerberos.node');
      if (!existsSync(path)) {
        problems.push(`${path} is missing`);
        continue;
      }
      if (options.loadHost && prebuild === `${process.platform}-${process.arch}`) {
        try {
          createRequire(import.meta.url)(path);
        } catch (error) {
          problems.push(`${path} does not load: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [platform = process.platform, ...dirs] = process.argv.slice(2);
  const problems = checkKerberosVendor({ platform, resourcesDirs: dirs, loadHost: true });
  for (const problem of problems) console.error(`kerberos vendor: ${problem}`);
  if (problems.length > 0 || dirs.length === 0) process.exit(1);
  console.log(`kerberos vendor: ${dirs.length} build(s) carry every binding for ${platform}`);
}
```

- [ ] **Step 5: Run the test to see it pass.** Same command. Expected: PASS.

- [ ] **Step 6: Run it in the release jobs.** In `release.yml` `build`, after the `Package` step:

```yaml
      - name: Check the vendored Kerberos bindings
        run: |
          if [ "${{ matrix.os }}" = macos-latest ]; then
            node scripts/check-kerberos-vendor.ts darwin apps/desktop/release/mac*/Wirebench.app/Contents/Resources
          else
            node scripts/check-kerberos-vendor.ts linux apps/desktop/release/linux-unpacked/resources apps/desktop/release/linux-arm64-unpacked/resources
          fi
```

In `win-unpacked`, that job runs electron-builder directly, not `package:win`. Change l.320 to vendor
first, then add the check:

```yaml
      - run: pnpm build && node scripts/vendor-kerberos.ts win32 && pnpm --filter @wirebench/desktop exec electron-builder --win --dir --x64 --arm64 --publish never
      - run: node scripts/check-kerberos-vendor.ts win32 apps/desktop/release/win-unpacked/resources apps/desktop/release/win-arm64-unpacked/resources
```

The arm64 app also carries `win32-x64/kerberos.node`. Its loader asks for
`win32-arm64/kerberos.node` and reports "Kerberos is not available on Windows on ARM.", which is
intended.

- [ ] **Step 7: Read `optionalDependencies` in the licence script.**
  - In `third-party-licenses.ts`, at l.172, walk `{ ...manifest.dependencies, ...manifest.optionalDependencies }`.
  - At l.248–250, add `engine.optionalDependencies` to the roots.
  - In `third-party-licenses.test.ts`, add a case that lists an optional dependency, mirroring its
    existing dependency fixture.
  - Run `pnpm licenses:third-party`. Expected: `THIRD-PARTY-LICENSES.md` gains `kerberos` 7.0.0
    (Apache-2.0) and its runtime dependencies.
  - Then run `pnpm licenses:third-party --check` and
    `pnpm vitest run --project scripts scripts/third-party-licenses.test.ts`. Expected: pass.

- [ ] **Step 8: Correct `docs/release.md`.**
  - Replace l.75–76 with: "`npmRebuild: false`. Wirebench has one native module, the Kerberos
    binding, and it is vendored per architecture by `scripts/vendor-kerberos.ts` rather than rebuilt
    ([ADR-0019](adr/0019-kerberos-uses-an-optional-native-module.md)). Running npm's rebuild against
    pnpm's symlinked store is a good way to flatten a tree that was fine."
  - Under _What is unpacked from the asar_, add: "`Resources/kerberos/<platform>-<arch>/kerberos.node`
    ships through `extraResources`, outside the asar, and `scripts/check-kerberos-vendor.ts` checks
    it in every release job. macOS gets one universal file in both architecture folders, which is why
    `mac.x64ArchFiles` names it."
  - Under the Windows signing section, add: "The SignPath app configuration must include
    `resources/kerberos/**/*.node`, so the binding is signed with `Wirebench.exe`. That is a one-time
    change on SignPath's side."
  - Add a new section after _After the tag_:

```markdown
## Manual Kerberos check (per release candidate)

CI has a real KDC on Linux but no Windows domain. On a domain-joined Windows x64 machine with the
release candidate installed:

1. An IIS site with Windows Authentication and the Kerberos-only provider (`Negotiate:Kerberos`): a
   REST GET with auth **Kerberos** returns 200, and the SOAP status note reads "Authenticated with
   Kerberos as HTTP/<host>".
2. The same request with **Use another account** (a second domain user) returns 200, and the IIS log
   shows that user.
3. The SPN set to `HTTP/nowhere.invalid` fails with "The KDC does not know HTTP/nowhere.invalid…".
4. On Windows on ARM, the Kerberos option is disabled and reads "Kerberos is not available on Windows
   on ARM."
```

- [ ] **Step 9: Gate and commit.**

```bash
git add apps/desktop/electron-builder.yml scripts/check-kerberos-vendor.ts scripts/check-kerberos-vendor.test.ts .github/workflows/release.yml scripts/third-party-licenses.ts scripts/third-party-licenses.test.ts THIRD-PARTY-LICENSES.md docs/release.md
git commit -m "build: ship and verify the Kerberos bindings, list the licence, document the release check"
```

### Task 12: Main configures the engine and answers availability

**Files:**
- Create: `apps/desktop/src/main/kerberos.ts`
- Modify: `apps/desktop/src/main/index.ts` (before `registerAppChannels`, l.524)
- Modify: `apps/desktop/src/shared/ipc.ts` (`channels`, l.440)
- Modify: `apps/desktop/test/mocks/wirebench-api.ts` (a default for the new channel, near l.31)
- Test: `apps/desktop/test/main-kerberos.test.ts`

**Interfaces:**
- Consumes: engine `configureKerberos`, `loadKerberosProvider`, `kerberosProvider` (Task 8).
- Produces:
  - `kerberosBindingPath(input: { isPackaged: boolean; resourcesPath: string; platform: string; arch: string }): string | undefined`;
  - `setUpKerberos(input: { isPackaged: boolean; resourcesPath: string }): void`;
  - `registerKerberosChannels(): void`;
  - channel `channels.auth.kerberosAvailability`: `z.undefined()` →
    `{ available: boolean; reason?: string; platform: 'win32' | 'darwin' | 'linux' }`.

- [ ] **Step 1: Write the failing test**, `apps/desktop/test/main-kerberos.test.ts`:

```ts
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { kerberosBindingPath } from '../src/main/kerberos.js';
import { channels } from '../src/shared/ipc.js';

describe('kerberosBindingPath', () => {
  it('points a packaged app at its vendored binding for this architecture', () => {
    expect(kerberosBindingPath({ isPackaged: true, resourcesPath: '/app/Resources', platform: 'darwin', arch: 'arm64' })).toBe(
      join('/app/Resources', 'kerberos', 'darwin-arm64', 'kerberos.node'),
    );
  });

  it('leaves a development run on the installed package', () => {
    expect(kerberosBindingPath({ isPackaged: false, resourcesPath: '/x', platform: 'linux', arch: 'x64' })).toBeUndefined();
  });
});

describe('auth.kerberosAvailability', () => {
  it('carries availability, the reason and the platform', () => {
    const response = channels.auth.kerberosAvailability.response;
    expect(response.safeParse({ available: false, reason: 'r', platform: 'win32' }).success).toBe(true);
    expect(response.safeParse({ available: true, platform: 'aix' }).success).toBe(false);
  });
});
```

Check how an `IpcChannel` exposes its response schema (`shared/ipc.ts:409`). If the property is not
`response`, use its name.

- [ ] **Step 2: Run it to see it fail.**
Run: `pnpm vitest run --project desktop apps/desktop/test/main-kerberos.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** `apps/desktop/src/main/kerberos.ts`:

```ts
/**
 * Points the engine's Kerberos at the binding this build vendored (ADR-0019), once, at start-up. A
 * development run uses the installed `kerberos` package instead.
 */

import { join } from 'node:path';
import { configureKerberos, kerberosProvider, loadKerberosProvider } from '@wirebench/engine';
import { channels } from '../shared/ipc.js';
import { registerHandler } from './ipc/register.js';

export function kerberosBindingPath(input: {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly platform: string;
  readonly arch: string;
}): string | undefined {
  return input.isPackaged ? join(input.resourcesPath, 'kerberos', `${input.platform}-${input.arch}`, 'kerberos.node') : undefined;
}

export function setUpKerberos(input: { readonly isPackaged: boolean; readonly resourcesPath: string }): void {
  const bindingPath = kerberosBindingPath({ ...input, platform: process.platform, arch: process.arch });
  configureKerberos(loadKerberosProvider(bindingPath !== undefined ? { bindingPath } : {}));
}

export function registerKerberosChannels(): void {
  registerHandler(channels.auth.kerberosAvailability, () => {
    const availability = kerberosProvider().availability();
    const platform = process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux';
    return Promise.resolve(
      availability.available ? { available: true, platform } : { available: false, reason: availability.reason, platform },
    );
  });
}
```

In `shared/ipc.ts`, inside `channels`:

```ts
  auth: {
    kerberosAvailability: defineChannel(
      'auth.kerberosAvailability',
      z.undefined(),
      z.object({ available: z.boolean(), reason: z.string().optional(), platform: z.enum(['win32', 'darwin', 'linux']) }),
    ),
  },
```

If an `auth` group already exists, add the channel to it.

In `main/index.ts`, before `registerAppChannels(...)` (l.524):

```ts
  setUpKerberos({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath });
  registerKerberosChannels();
```

In `test/mocks/wirebench-api.ts` `stubWirebenchApi`, add the default
`auth: { kerberosAvailability: … }`, answering `{ ok: true, value: { available: true, platform: 'linux' } }`
with that file's success helper.

- [ ] **Step 4: Run the test to see it pass.** Same command, then `pnpm --filter @wirebench/desktop typecheck`.
Expected: PASS.

- [ ] **Step 5: Gate and commit.**

```bash
git add apps/desktop/src/main/kerberos.ts apps/desktop/src/main/index.ts apps/desktop/src/shared/ipc.ts apps/desktop/test/mocks/wirebench-api.ts apps/desktop/test/main-kerberos.test.ts
git commit -m "feat(desktop): point the engine at the vendored Kerberos binding; report availability"
```

### Task 13: Wire schemas, the auth summary and WSDL import in main

**Files:**
- Modify: `apps/desktop/src/shared/wire-types.ts`:
  - `importAuthSchema` l.47–52;
  - `requestAuthSourceSchema` l.773;
  - `authSummaryWireSchema` l.820–824;
  - `authConfigWireSchema` l.981–1008;
  - `definitionAuthWireSchema` l.3299–3310.
- Modify: `apps/desktop/src/main/engine-wire.ts:369-374, 640-645`
- Modify: `apps/desktop/src/main/engine-service.ts:136-147, 190, 209`, `apps/desktop/src/main/project-host.ts:2805-2814`, plus the `useForRequests` site
- Test: `apps/desktop/test/kerberos-wire.test.ts` (new)

- [ ] **Step 1: Write the failing test**, `apps/desktop/test/kerberos-wire.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  authConfigWireSchema,
  authSummaryWireSchema,
  definitionAuthWireSchema,
  importAuthSchema,
  projectChangeSchema,
} from '../src/shared/wire-types.js';

describe('Kerberos on the wire', () => {
  it('is an auth config with spn and principal, at every SOAP site', () => {
    const auth = { type: 'kerberos', spn: 'HTTP/x', principal: 'a@R', username: 'u', domain: 'D', passwordRef: 'r' } as const;
    expect(authConfigWireSchema.parse(auth)).toEqual(auth);
    for (const change of [
      { kind: 'update-request-auth', requestId: 'r1', auth },
      { kind: 'update-interface-auth', interfaceId: 'i1', auth },
      { kind: 'update-endpoint-auth', interfaceId: 'i1', endpointId: 'e1', auth },
    ]) {
      expect(projectChangeSchema.safeParse(change).success).toBe(true);
    }
  });

  it('is a definition auth, and refuses a plaintext password there', () => {
    expect(definitionAuthWireSchema.safeParse({ type: 'kerberos', spn: 'HTTP/x' }).success).toBe(true);
    expect(definitionAuthWireSchema.safeParse({ type: 'kerberos', password: 'p' }).success).toBe(false);
  });

  it('is a WSDL import auth with only an optional SPN', () => {
    expect(importAuthSchema.safeParse({ type: 'kerberos' }).success).toBe(true);
    expect(importAuthSchema.safeParse({ type: 'kerberos', spn: 'HTTP/x' }).success).toBe(true);
    expect(importAuthSchema.safeParse({ username: 'u', passwordRef: 'r' }).success).toBe(true);
    expect(importAuthSchema.safeParse({ type: 'kerberos', password: 'p' }).success).toBe(false);
  });

  it('carries the SPN in the auth summary', () => {
    expect(authSummaryWireSchema.parse({ scheme: 'kerberos', challenged: true, attempts: 2, spn: 'HTTP/x' })).toMatchObject({
      spn: 'HTTP/x',
    });
  });
});
```

- [ ] **Step 2: Run it to see it fail.**
Run: `pnpm vitest run --project desktop apps/desktop/test/kerberos-wire.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement the schemas.**
  - `authConfigWireSchema`: add `'kerberos'` to the `type` enum, and add
    `spn: z.string().optional(),` and `principal: z.string().optional(),` after `preemptive`.
  - `requestAuthSourceSchema`: add `'kerberos'` to its `type` enum.
  - `authSummaryWireSchema`: add `'kerberos'` to `scheme`, and add `spn: z.string().optional(),`.
  - `definitionAuthWireSchema`: add the arm

```ts
  z
    .object({
      type: z.literal('kerberos'),
      spn: z.string().optional(),
      principal: z.string().optional(),
      username: z.string().optional(),
      domain: z.string().optional(),
      passwordRef: z.string().optional(),
    })
    .strict(),
```

  - `importAuthSchema` (keep the `.strict()` comment above it):

```ts
export const importAuthSchema = z.union([
  z.object({ username: z.string(), passwordRef: z.string() }).strict(),
  // Kerberos with the signed-in ticket; an explicit account is set on the interface afterwards.
  z.object({ type: z.literal('kerberos'), spn: z.string().optional() }).strict(),
]);
```

- [ ] **Step 4: Map the SPN through.** In both `engine-wire.ts` mappers, after `attempts`, add
`...(exchange.auth.spn !== undefined ? { spn: exchange.auth.spn } : {}),`.

- [ ] **Step 5: WSDL import in main.**
  - In `engine-service.ts` (l.136–147), resolve the secret only for the Basic arm:

```ts
    const wireAuth = request.options?.auth;
    const auth =
      wireAuth === undefined
        ? undefined
        : 'type' in wireAuth
          ? { type: 'kerberos' as const, ...(wireAuth.spn !== undefined ? { spn: wireAuth.spn } : {}) }
          : { username: wireAuth.username, password: await this.resolveImportPassword(wireAuth.passwordRef) };
```

    `resolveImportPassword` stands for the secret lookup the existing code already does at l.140–146.
    Keep that code and its `secret-missing` handling as it is; only the branch is new.
  - Widen the `auth` parameter types at l.190 and l.209 to
    `{ readonly username: string; readonly password: string } | KerberosSendAuth`, with a type import
    from `@wirebench/engine`.
  - In `project-host.ts` `importAuthFor` (l.2805), before the Basic branch:

```ts
    if (iface.auth?.type === 'kerberos') {
      const resolved = await resolveAuthConfig(iface.auth, (ref) => this.getSecret(ref));
      return resolved?.type === 'kerberos' ? resolved : undefined;
    }
```

    Widen its return type to `{ username: string; password: string } | KerberosSendAuth | undefined`.
  - Find where `useForRequests` copies the import credentials into the interface auth
    (`grep -n useForRequests apps/desktop/src/main`). Beside its Basic branch, set
    `{ type: 'kerberos', spn? }` when the import auth is Kerberos. Add a case to that site's existing
    test.
  - Run `pnpm --filter @wirebench/desktop typecheck`, and fix what it names the same way: Kerberos
    passes through, and Basic is unchanged.

- [ ] **Step 6: Run the desktop suite.**
Run: `pnpm vitest run --project desktop`. Expected: PASS.

- [ ] **Step 7: Gate and commit.**

```bash
git add apps/desktop/src/shared/wire-types.ts apps/desktop/src/main apps/desktop/test
git commit -m "feat(desktop): Kerberos in the wire schemas, the auth summary and WSDL import"
```

### Task 14: The Kerberos option in every picker

**Files:**
- Create: `apps/desktop/src/renderer/lib/use-kerberos-availability.ts`
- Modify: `apps/desktop/src/renderer/components/auth-fields.tsx`:
  - `TYPES` l.27–34 and `SOAP_AUTH_TYPES` l.42–49;
  - the `text()` field union at l.200;
  - the option map at l.232–269;
  - a block after l.292.
- Modify: `apps/desktop/src/renderer/components/definition-auth.tsx:14, 24-47`
- Test: `apps/desktop/test/renderer/auth-fields-kerberos.test.tsx` (new); update
  `apps/desktop/test/renderer/auth-fields.test.tsx` l.49 and l.62, and `definition-auth.test.ts`.

**Interfaces:**
- Consumes: `window.wirebench.auth.kerberosAvailability` (Task 12).
- Produces: `useKerberosAvailability(): KerberosAvailabilityView | undefined`.

- [ ] **Step 1: Write the failing tests**, `apps/desktop/test/renderer/auth-fields-kerberos.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { AuthFields } from '../../src/renderer/components/auth-fields.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

afterEach(() => {
  cleanup();
});

const availability = (value: { available: boolean; reason?: string; platform: 'win32' | 'darwin' | 'linux' }) =>
  installWirebenchApi({ auth: { kerberosAvailability: vi.fn().mockResolvedValue({ ok: true, value }) } });

describe('Kerberos in AuthFields', () => {
  it('offers Kerberos, with SPN and, off Windows, principal', async () => {
    availability({ available: true, platform: 'linux' });
    render(<AuthFields scope="API" auth={{ type: 'kerberos' }} onChange={vi.fn()} />);
    expect(screen.getByRole('option', { name: 'Kerberos' })).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText('API principal')).toBeTruthy());
    expect(screen.getByLabelText('API spn')).toHaveProperty('placeholder', 'HTTP/<host of the request>');
    expect(screen.queryByText('Use another account')).toBeNull();
  });

  it('offers another account on Windows, and no principal', async () => {
    availability({ available: true, platform: 'win32' });
    render(<AuthFields scope="API" auth={{ type: 'kerberos' }} onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Use another account')).toBeTruthy());
    expect(screen.queryByLabelText('API principal')).toBeNull();
  });

  it('disables the option and says why when the binding is unavailable', async () => {
    availability({ available: false, reason: 'Kerberos is not available on Windows on ARM.', platform: 'win32' });
    render(<AuthFields scope="API" auth={{ type: 'kerberos' }} onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Kerberos' })).toHaveProperty('disabled', true));
    expect(screen.getByText('Kerberos is not available on Windows on ARM.')).toBeTruthy();
  });
});
```

In `auth-fields.test.tsx` l.49 and l.62, append `'Kerberos'` to both expected option lists. In
`definition-auth.test.ts`, add the case `toDefinitionAuthWire({ type: 'kerberos', spn: 'HTTP/x' })` →
`{ type: 'kerberos', spn: 'HTTP/x' }`.

- [ ] **Step 2: Run them to see them fail.**
Run: `pnpm vitest run --project desktop apps/desktop/test/renderer/auth-fields-kerberos.test.tsx apps/desktop/test/renderer/auth-fields.test.tsx apps/desktop/test/renderer/definition-auth.test.ts`.
Expected: FAIL.

- [ ] **Step 3: The hook**, `apps/desktop/src/renderer/lib/use-kerberos-availability.ts`. It
restates the shape, because the renderer takes no value from `shared/`:

```ts
import { useEffect, useState } from 'react';

export interface KerberosAvailabilityView {
  readonly available: boolean;
  readonly reason?: string;
  readonly platform: 'win32' | 'darwin' | 'linux';
}

/** Asked once per mount; undefined until main answers. */
export function useKerberosAvailability(): KerberosAvailabilityView | undefined {
  const [value, setValue] = useState<KerberosAvailabilityView | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void window.wirebench.auth.kerberosAvailability(undefined).then((result) => {
      if (!cancelled && result.ok) setValue(result.value);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return value;
}
```

- [ ] **Step 4: The fields.** In `auth-fields.tsx`:
  - Append `{ value: 'kerberos', label: 'Kerberos' }` to `TYPES`, and `'kerberos'` to `SOAP_AUTH_TYPES`.
  - Add `'spn' | 'principal'` to the `text()` field union. If `text()` takes no placeholder argument,
    add an optional third parameter `placeholder?: string`, set on the `<input>`.
  - At the top of `AuthFields`, add `const kerberos = useKerberosAvailability();`.
  - In the option map, render
    `<option key={option.value} value={option.value} disabled={option.value === 'kerberos' && kerberos?.available === false}>`.
  - After the Basic/NTLM block:

```tsx
      {auth !== undefined && type === 'kerberos' && (
        <>
          {kerberos?.available === false && <p className="text-xs text-fg-subtle">{kerberos.reason}</p>}
          {text('spn', 'SPN', 'HTTP/<host of the request>')}
          <p className="text-xs text-fg-subtle">Leave empty unless the service is registered under another name.</p>
          {kerberos !== undefined && kerberos.platform !== 'win32' && text('principal', 'Principal', 'user@REALM')}
          {kerberos?.platform === 'win32' && (
            <details open={auth.username !== undefined}>
              <summary className="text-xs">Use another account</summary>
              {text('username', 'Username')}
              {text('domain', 'Domain')}
              {secret('passwordRef', 'Password')}
            </details>
          )}
        </>
      )}
```

- [ ] **Step 5: Definitions.** In `definition-auth.tsx`, append `'kerberos'` to
`DEFINITION_AUTH_TYPES`. In `toDefinitionAuthWire`:

```ts
    case 'kerberos':
      return {
        type: 'kerberos',
        ...(auth.spn !== undefined ? { spn: auth.spn } : {}),
        ...(auth.principal !== undefined ? { principal: auth.principal } : {}),
        ...(auth.username !== undefined ? { username: auth.username } : {}),
        ...(auth.domain !== undefined ? { domain: auth.domain } : {}),
        ...(auth.passwordRef !== undefined ? { passwordRef: auth.passwordRef } : {}),
      };
```

- [ ] **Step 6: Run the renderer tests.**
Run: `pnpm vitest run --project desktop apps/desktop/test/renderer`. Expected: PASS. If any other
option-list assertion breaks (`auth-tab.test.tsx`, `auth-inspector.test.tsx`), append `'Kerberos'` to
it.

- [ ] **Step 7: Gate and commit.**

```bash
git add apps/desktop/src/renderer apps/desktop/test/renderer
git commit -m "feat(desktop): offer Kerberos in every auth picker, disabled with the reason when unavailable"
```

### Task 15: The import dialog, the response note and the cURL export

**Files:**
- Modify: `apps/desktop/src/renderer/features/explorer/import-dialog.tsx` (≈l.248, 985–995, 1340–1370)
- Modify: `apps/desktop/src/renderer/features/request-editor/response-status.tsx:91-96`
- Modify: `packages/engine/src/http/curl.ts:36-52, 101-103`, `packages/engine/src/rest/curl.ts:86-100`, `packages/engine/src/soap/curl.ts:17`
- Modify: `apps/desktop/src/main/ipc/request.ts:418-443, 590-623`
- Test:
  - `apps/desktop/test/renderer/import-dialog-kerberos.test.tsx` (new);
  - the response-status test (`grep -ln "auth-challenge-note" apps/desktop/test`; extend it, or
    create `apps/desktop/test/renderer/response-status-kerberos.test.tsx`);
  - `packages/engine/test/unit/http/curl.test.ts` (extend);
  - `apps/desktop/test/ipc-request-curl-soap-auth.test.ts` (extend).

- [ ] **Step 1: The response note, test first.** Render the status with
`exchange.auth = { scheme: 'kerberos', challenged: true, attempts: 2, spn: 'HTTP/svc' }`, and expect
`auth-challenge-note` to read "· Authenticated with Kerberos as HTTP/svc". With `challenged: false`,
expect "· Kerberos sent preemptively as HTTP/svc". Run it, and see it fail. Then change
`response-status.tsx:91-96` to:

```tsx
      {exchange.auth?.scheme === 'kerberos' ? (
        <span data-testid="auth-challenge-note" className="text-fg-subtle">
          {' · '}
          {exchange.auth.challenged ? 'Authenticated with Kerberos' : 'Kerberos sent preemptively'}
          {exchange.auth.spn !== undefined ? ` as ${exchange.auth.spn}` : ''}
        </span>
      ) : (
        exchange.auth?.challenged === true && (
          <span data-testid="auth-challenge-note" className="text-fg-subtle">
            {' · '}
            Authenticated after 401 challenge
          </span>
        )
      )}
```

Run it, and see it pass.

- [ ] **Step 2: cURL in the engine, test first.** In `packages/engine/test/unit/http/curl.test.ts`,
build commands the way the file's existing `basic` case does, with two new cases:
  - `negotiate: {}` gives `--negotiate --user ':'`, in the file's POSIX quoting;
  - `negotiate: { username: 'u', domain: 'D' }` gives `--negotiate --user 'D\u:'`.

Run them, and see them fail. Then:
  - Add `readonly negotiate?: { readonly username?: string; readonly domain?: string };` to
    `CurlCommand`, with the doc comment "`--negotiate`: curl asks the OS for the ticket; no password
    is ever part of the command."
  - After the `basic` branch in `toCurl` (l.101–103):

```ts
  if (command.negotiate !== undefined) {
    const { username, domain } = command.negotiate;
    const user = username !== undefined ? `${domain !== undefined ? `${domain}\\` : ''}${username}` : '';
    args.push(`--negotiate --user ${quote(`${user}:`)}`);
  }
```

  - In `rest/curl.ts` `restToCurl`, where `basic` is set from `applied.transportAuth`, also set
    `negotiate` when `applied.transportAuth?.type === 'kerberos'`, from its `username` and `domain`.
  - In `soap/curl.ts`, give `soapToCurl` an optional `negotiate` input, passed into the
    `CurlCommand` it builds, the same way it receives anything else for the command (read l.17–40).

Run the engine curl tests, and see them pass.

- [ ] **Step 3: cURL in the desktop app, test first.** In `ipc-request-curl-soap-auth.test.ts`, add a
SOAP owner with `{ type: 'kerberos', username: 'u', domain: 'D', passwordRef: 'r' }`. Expect the
command to contain `--negotiate`, and to contain no password, with show-secrets both on and off. Run
it, and see it fail. Then:
  - In `ipc/request.ts` `placeholderAuth`, add:

```ts
    case 'kerberos':
      return {
        type: 'kerberos',
        ...(auth.spn !== undefined ? { spn: auth.spn } : {}),
        ...(auth.username !== undefined ? { username: auth.username } : {}),
        ...(auth.domain !== undefined ? { domain: auth.domain } : {}),
      };
```

  - In `soapCurlInput`, the early return for `basic` and `ntlm` also covers `kerberos`.
  - Where `soapToCurl` is called (l.528–538), pass `negotiate` when the effective owner auth is
    Kerberos.
  - The REST path picks up `negotiate` from `restToCurl` without change.

Run it, and see it pass.

- [ ] **Step 4: The import dialog, test first.** Find the existing import-dialog renderer test
(`grep -ln "ImportDialog" apps/desktop/test/renderer`) and copy its set-up into
`import-dialog-kerberos.test.tsx`. The flow:
  - choose a WSDL URL;
  - choose **Kerberos (signed-in ticket)** in the select labelled "Definition authentication";
  - type `HTTP/x` into "Definition SPN";
  - import.

Expect `definition.import` to have been called with an `options.auth` of
`{ type: 'kerberos', spn: 'HTTP/x' }`. Run it, and see it fail. Then, in `import-dialog.tsx`:
  - add `const [authMode, setAuthMode] = useState<'none' | 'basic' | 'kerberos'>('none');` and
    `const [spn, setSpn] = useState('');`;
  - put a `<select aria-label="Definition authentication">` with **None**, **Basic** and **Kerberos
    (signed-in ticket)** above the existing Basic credential block;
  - show that block only when `authMode === 'basic'`;
  - when `authMode === 'kerberos'`, render one `<input aria-label="Definition SPN" placeholder="HTTP/<host of the WSDL>">`;
  - build `options.auth` at l.985–995:

```tsx
        const auth =
          authMode === 'kerberos'
            ? { type: 'kerberos' as const, ...(spn.trim() !== '' ? { spn: spn.trim() } : {}) }
            : authMode === 'basic' && flushedRef !== undefined
              ? { username, passwordRef: flushedRef }
              : undefined;
```

  - keep `useForRequests` as it is; main handles Kerberos since Task 13.

Run it, and see it pass. Run the existing import-dialog tests: a test that typed a username without
choosing **Basic** now chooses it first. Update those tests only by adding that selection.

- [ ] **Step 5: Run the suites.** Run `pnpm vitest run --project desktop` and
`pnpm vitest run --project engine-unit`. Expected: PASS.

- [ ] **Step 6: Gate and commit.**

```bash
git add apps/desktop packages/engine/src/http/curl.ts packages/engine/src/rest/curl.ts packages/engine/src/soap/curl.ts packages/engine/test/unit/http/curl.test.ts
git commit -m "feat(desktop): Kerberos for WSDL import, a Kerberos-aware response note, --negotiate export"
```

### Task 16: Docs, success criteria and changelog

**Files:**
- Modify: `docs-site/src/content/docs/guides/auth.mdx` (the table at l.19–25, plus a new section after `### OAuth 2`)
- Modify: `docs-site/src/content/docs/guides/importers.mdx`, and the CLI reference page (`grep -ln "passwordEnv" docs-site/src/content/docs`)
- Modify: `docs/roadmap.md` (item 7 at l.62, and the _Authentication_ list at l.253)
- Modify: `docs/success-criteria.md` (rows SC-K1–SC-K10 after SC-S8 at l.128)
- Modify: `CHANGELOG.md` (`## [Unreleased]` → `### Added`)

- [ ] **Step 1: `auth.mdx`.**
  - Add a table row:
    `| Kerberos | Your Windows sign-in or \`kinit\` ticket; optional SPN; on Windows, another account |`.
  - Add `### Kerberos` after `### OAuth 2`, covering:
    - single sign-on;
    - `kinit user@REALM` on macOS and Linux;
    - the SPN override and when to set it (an alias, or a service registered under another name);
    - **Use another account** (Windows only);
    - no NTLM fallback ("choose NTLM if that is what the server needs");
    - availability, Windows on ARM included;
    - a troubleshooting table with one row per error code in spec D3, giving the message text from
      Task 2 and the fix.
  - The page never names another product.

- [ ] **Step 2: Importers and CLI.**
  - `importers.mdx`: a sentence each under WSDL and OpenAPI/AsyncAPI saying Kerberos is offered and
    sent only to the definition's own origin.
  - CLI reference:
    - a Kerberos request uses the runner's ticket cache;
    - `passwordEnv` applies only with a username, on Windows;
    - a request whose Kerberos cannot start is errored (exit 3).

- [ ] **Step 3: Roadmap.**
  - Item 7's status cell: "Kerberos shipped (#40, [spec](specs/2026-10-05-kerberos-spnego-auth-design.md)); WS-Trust next".
  - The _Authentication_ bullet: replace "Requires the native `kerberos` module…" with one sentence on
    what shipped, linking ADR-0019.

- [ ] **Step 4: Success criteria.** Add ten rows after SC-S8, in the main table's format
`| SC-Kn | **Title** (Kerberos spec) — criterion | evidence | Met |`. Each criterion is the spec's
SC-K text, and the evidence is:

| Row | Evidence |
| --- | --- |
| SC-K1 | `packages/engine/test/integration/auth/kerberos-real.test.ts`, [`ci.yml`](../.github/workflows/ci.yml) job `kerberos-integration` |
| SC-K2 | `packages/engine/test/unit/http/auth/kerberos-native.test.ts`, `packages/engine/test/unit/http/auth/kerberos-token.test.ts` |
| SC-K3 | `packages/engine/test/unit/http/auth/kerberos-token.test.ts`, `packages/engine/test/unit/secrets/resolve-kerberos.test.ts` |
| SC-K4 | `packages/engine/test/integration/http/document-fetch-kerberos.test.ts`, `apps/desktop/test/renderer/import-dialog-kerberos.test.tsx` |
| SC-K5 | `packages/cli/test/integration/kerberos-run.test.ts` |
| SC-K6 | `packages/engine/test/unit/http/auth/kerberos-token.test.ts` ("withNegotiate"), the ws and gRPC tests extended in Task 7 |
| SC-K7 | `packages/engine/test/unit/project/kerberos-auth-format.test.ts`, `packages/engine/test/unit/project/format-migration.test.ts`, `apps/desktop/test/kerberos-wire.test.ts` |
| SC-K8 | `scripts/vendor-kerberos.test.ts`, `scripts/check-kerberos-vendor.test.ts`, `apps/desktop/test/renderer/auth-fields-kerberos.test.tsx` |
| SC-K9 | `packages/engine/test/unit/redact/negotiate.test.ts` |
| SC-K10 | `packages/engine/test/integration/auth/kerberos-real.test.ts` ("makes a token a real acceptor accepts") |

In the SC-K6 row, name the actual ws and gRPC test files extended in Task 7. Run
`pnpm check:doc-paths`. Expected: every cited path exists.

- [ ] **Step 5: CHANGELOG.** Under `## [Unreleased]` → `### Added`:

```markdown
- **Kerberos authentication.** A request, an API, a SOAP interface or endpoint, and a definition
  fetch can authenticate with your Windows sign-in or `kinit` ticket over HTTP Negotiate, with an
  optional SPN and, on Windows, another account. Kerberos only: nothing falls back to NTLM. The
  WebSocket upgrade and gRPC calls send it preemptively; the CLI and MCP send it too (#40).
```

- [ ] **Step 6: Gate and commit.**

```bash
git add docs-site docs/roadmap.md docs/success-criteria.md CHANGELOG.md
git commit -m "docs: Kerberos authentication, its success criteria and changelog"
```

- [ ] **Step 7: Open PR 2.** Push, then open it titled
"feat(desktop): Kerberos/SPNEGO authentication (#40, 2 of 2)". The body:
  - lists D5–D8 and the docs;
  - names the one-time SignPath configuration change for `resources/kerberos/**/*.node`, as an owner
    action;
  - names the manual Windows check in `docs/release.md`.

Wait for CI to go green. Merge with `gh pr merge --merge`. Close #40 and set its board status to
**Done**.

---

## Self-review

- **Spec coverage:**
  - D1 → Tasks 1, 2, 8. D2 → Task 3. D3 → Task 4. D4 → Tasks 6, 7, 8.
  - D5 → Tasks 12, 13, 15. D6 → Tasks 12–15. D7 → Tasks 10, 11. D8 → Task 5 (masking), Task 3
    (plaintext refused), Task 6 (origin).
  - Testing → Tasks 1–9 and 10–15. Success criteria → Task 16. Docs → Tasks 11, 16. Delivery → PR 1
    and PR 2.
- **Names used across tasks:**
  - `KerberosSendAuth` (Task 2) is used in Tasks 3, 4, 6, 7 and 13.
  - `KerberosProvider` and `configureKerberos` (Task 1) are used in Tasks 2, 4, 6–9 and 12.
  - `negotiateBearer` (Task 2) is used in Task 6, and `withNegotiate` (Task 7) in Task 7.
  - `AuthSummary.spn` (Task 3) is used in Tasks 4, 13 and 15.
  - `startNegotiateServer` (Task 4) is used in Task 8.
- **Reading flagged inline, each saying what to read and what to do with it:**
  - Task 3: `requireSecret`, `resolveSoapAuth`'s parameters. Task 5: `redactHeaders` and `redactRawHttp`.
  - Task 6: `WsdlImportSource` and `FetchDocument`. Task 7: the ws and gRPC test harnesses.
  - Task 8: the CLI and MCP harnesses. Task 10: `TarEntry` field names. Task 12: `IpcChannel`'s response property.
  - Task 13: the existing import secret lookup and the `useForRequests` site.
  - Task 15: the `soapToCurl` input and the import-dialog test set-up.
