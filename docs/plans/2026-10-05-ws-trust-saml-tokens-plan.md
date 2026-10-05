# Plan: WS-Trust — STS-issued SAML tokens in WS-Security

Spec: [`docs/specs/2026-10-05-ws-trust-saml-tokens-design.md`](../specs/2026-10-05-ws-trust-saml-tokens-design.md)
Issue: [#41](https://github.com/wirebench/wirebench/issues/41)

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to carry out this plan task by task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put SAML assertions into outgoing WS-Security. The assertion either comes from a
security token service (STS) over WS-Trust, or is self-issued (built from a form, or supplied as
XML). Signatures can then refer to it, for holder-of-key and signed supporting tokens.

**Architecture:**

- **Engine** (`packages/engine/src/wss/`):
  - two new entry kinds, applied in entry order by `applyOutgoingWss`;
  - a SAML builder (`wss/saml/`) and a WS-Trust client (`wss/trust/`);
  - an STR-Transform registered with xml-crypto;
  - an issued-token source (`run/issued-token.ts`). It caches tokens per run in CLI and MCP, and
    the desktop holds one instance for the whole session.
- **Desktop main:**
  - lends that source to the send host;
  - logs each STS exchange as its own HTTP Log row;
  - serves status, fetch and clear over IPC.
- **Renderer:** edits the two kinds and shows the token status.

**Tech stack:** TypeScript (ESM, `.js` import suffixes), `@xmldom/xmldom`, `xml-crypto` 6.1, `node-forge`,
zod 4, vitest, React, Electron IPC (`defineChannel`), Playwright e2e.

## Global constraints

- **The gate**, before every commit: `WIREBENCH_SKIP_PERF=1 pnpm check`.
  - When `eslint .` runs out of heap (it does while `git-worktrees/` holds full checkouts), run
    the chain with `NODE_OPTIONS=--max-old-space-size=8192`, or replace `pnpm lint` with
    `pnpm exec eslint . --max-warnings 0 --ignore-pattern 'git-worktrees/**'`.
  - `pnpm test:perf` runs unskipped before every push.
  - CI runs e2e. Do not open local Electron windows while the owner works.
- **Commits:** one commit per task, made after the gate is green.
  - Commit as Mohammed Naami <m.naami@outlook.com>.
  - No `Co-Authored-By:` or `Claude-Session:` trailer.
  - PR descriptions have no generated-by footer.
- **Names:** never name the product that inspired a feature (`pnpm check:banned-terms`). A token
  service's endpoint shapes (`/trust/13/usernamemixed`) may appear verbatim; a vendor's product
  name may not appear in user-facing copy.
- **Engine purity:**
  - no `node:fs` in `wss/` (a file read is lent through `WssContext`);
  - no secret store;
  - no clock or entropy outside `WssContext`.
- **Secrets:**
  - Every secret is a reference (`passwordRef`, `keyPasswordRef`). A plaintext `password` key is
    rejected anywhere in an entry, nested credential objects included.
  - Issued assertions live in memory only, and are never written to disk, the keychain or History.
  - The renderer never receives an assertion unless show-secrets is on.
- **Assertions:** an assertion is never given a `wsu:Id`, and its attributes and children are
  never changed. Only its serialisation may change, and its exc-c14n form stays identical.
- **Dependencies:** no new third-party dependency. Kerberos uses #40's seam only.
- **Merging:** `gh pr merge --merge` (never squash), only after CI is green on the latest head.
  Never use `--auto`.

## Spec amendments made with this plan

This plan PR already applies these amendments to the spec, so implementation PRs do not edit it
for them. They are listed here so a reviewer sees them in one place.

1. **§3.5 The context member is bound.**
   - `WssContext.issuedTokens` is `{ get(entry), peek(entry) }`, already bound to the send's
     target: endpoint URL, scopes, TLS, proxy, timeout and signal. `wssFor` in `soap/run.ts`
     builds that binding.
   - The unbound `IssuedTokenSource` with a target parameter lives on `SendHost.issuedTokens`.
     `applyOutgoingWss` never has to know about TLS or proxies.
2. **§3.5 `IssuedToken.assertionXml` is a self-contained string, not an `Element`.**
   - An `Element` belongs to its document, and signing re-parses the envelope, so a cached
     `Element` would go stale.
   - The RSTR parser serialises the token element alone. xmldom adds every namespace declaration
     it needs, so the string is self-contained and survives caching.
3. **§3.6 and decision 10, "placed verbatim".**
   - xml-crypto only works on strings, so `signEnvelope` re-serialises the whole envelope after
     each signature. A byte-for-byte guarantee is therefore impossible.
   - The guarantee that holds is weaker but enough: the assertion is never mutated, so its
     exc-c14n form and the issuer's signature stay valid. Task 10's byte-preservation test proves
     that.
4. **§3.7 Masking keeps a token readable but unusable.**
   - The spec both replaces an assertion's content and keeps `Issuer`, `NameID` and `Conditions`
     visible, which contradict each other.
   - The engine's redaction instead masks:
     - the text of every `ds:SignatureValue` and `xenc:CipherValue` inside a `saml:Assertion`,
       `saml2:Assertion`, `saml2:EncryptedAssertion` or `wst:RequestedProofToken`;
     - the whole content of a Kerberos `BinarySecurityToken`.
   - A masked assertion cannot be replayed (its signature is gone) but can still be read.
   - The redaction does not protect an unsigned assertion, which is no credential anyway.
5. **§4.1 There is no separate desktop cache class.**
   - The desktop creates one `createIssuedTokenSource(...)` from the engine at startup and keeps
     it for the session. It has the same `status` and `clear` that CLI and MCP use.
   - `main/issued-tokens.ts` only adapts it for IPC and the send host.
6. **§4.1 The STS log row** is an `exchangeSummarySchema` row (the SOAP row shape). It gains two
   optional fields:
   - `auxiliary: 'sts'`;
   - `causedBy`, the triggering send's `sendId`.
7. **§3.1 Two context members are added.**
   - `WssContext.expand?: (text) => string` expands `${…}` in `stsUrl`, `appliesTo`, `claims` and
     an XML token whose `expandProperties` is on. It throws `unresolved-properties` on an
     unresolved reference.
   - `WssContext.projectFile?: (path) => Promise<string>` reads an XML token's file inside the
     project folder (the `insideProject` rule). It throws `saml-token-file-missing`.
8. **§3.5 Cache key.** The key uses the proof keystore and alias references, not the proof
   certificate's fingerprint. Computing the fingerprint would mean loading a keystore only to
   build a cache key.
9. **§6 Errors.** The table gains two codes:
   - `wss-proof-key-missing`: a holder-of-key or public-key token with no proof certificate;
   - `ws-trust-no-request`: Fetch now on a configuration that no request selects.

## Branches and PRs

| PR | Branch | Tasks | Spec |
| --- | --- | --- | --- |
| 1 | `feat/41-saml-tokens` | 1–7 | §3.1–3.2, §3.6 placement and form, §3.7, §4.2 SAML fields |
| 2 | `feat/41-token-signing` | 8–10 | §3.6 signature changes, holder-of-key and sender-vouches |
| 3 | `feat/41-ws-trust` | 11–18 | §3.3, §3.5, §4.1, §4.2 issued token, §5 |
| 4 | `feat/41-kerberos-sts` | 19 | §3.4 (after #40's PR 1 is merged) |

- Each PR branches from `main` after the previous one merges.
- Each PR ticks its box on #41 and adds its CHANGELOG entry under `## Unreleased`.
- Work in a worktree: `git worktree add git-worktrees/<branch-tail> -b <branch> origin/main`.

## File map

```text
packages/engine/src/xml/namespaces.ts               SAML1, SAML2, WSSE11, WST13, WST2005 (+ PREFIX)
packages/engine/src/wss/saml/uris.ts                token-profile, confirmation, WS-Trust URIs
packages/engine/src/wss/model.ts                    new entry kinds, SAML_TOKEN_PART, WssContext members
packages/engine/src/project/schema.ts               wssSamlTokenEntrySchema, wssIssuedTokenEntrySchema
packages/engine/src/wss/outgoing/saml.ts            resolveSamlToken: XML / form / issued → PlacedSamlToken
packages/engine/src/wss/saml/build.ts               buildSamlAssertion (1.1 / 2.0, optional issuer signature)
packages/engine/src/wss/saml/read.ts                readAssertion: version, ID, confirmation of an assertion string
packages/engine/src/wss/outgoing/str-transform.ts   StrTransform, registerStrTransform
packages/engine/src/wss/apply.ts                    placement, placed-token list into signEnvelope
packages/engine/src/wss/outgoing/signature.ts       saml-token key identifier, SamlToken part
packages/engine/src/wss/key-identifiers.ts          samlTokenReference
packages/engine/src/wss/trust/rst.ts                buildRst
packages/engine/src/wss/trust/rstr.ts               parseRstr
packages/engine/src/wss/trust/client.ts             requestIssuedToken, proofCertOf
packages/engine/src/run/issued-token.ts             createIssuedTokenSource, issuedCacheKey
packages/engine/src/run/host.ts                     SendHost.issuedTokens
packages/engine/src/run/send-helpers.ts             issuedTokenSourceOf, dropRejectedIssuedToken
packages/engine/src/soap/run.ts                     wssFor binding, outgoingNeeds, post-send drop
packages/engine/src/redact/index.ts                 redactSecurityTokens (called from redactXml)
packages/cli/src/mcp/server.ts, ops/redact.ts       redaction wording
packages/cli/src/ops/send.ts                        --verbose STS line
apps/desktop/src/main/issued-tokens.ts              IssuedTokensService (session source, IPC helpers)
apps/desktop/src/main/ipc/issued-tokens.ts          issuedTokens.* handlers
apps/desktop/src/main/send/host.ts                  SendHost.issuedTokens, STS log rows
apps/desktop/src/main/project-host.ts               preview peeks, issuedTokenTarget
apps/desktop/src/shared/{ipc,wire-types}.ts         wire kinds, issuedTokens channels, auxiliary row
apps/desktop/src/renderer/features/wss/saml-token-fields.tsx
apps/desktop/src/renderer/features/wss/issued-token-fields.tsx (+ issued-token-status.tsx)
apps/desktop/src/renderer/features/console/log-name.ts   "STS ·" row name
```

---

# PR 1 — SAML placement and self-issued tokens

### Task 1: Model, namespaces and project schema for both kinds

**Files:**

- Create: `packages/engine/src/wss/saml/uris.ts`
- Modify:
  - `packages/engine/src/xml/namespaces.ts` (`NS`, `PREFIX`)
  - `packages/engine/src/wss/model.ts` (types, `WSS_ENTRY_KINDS`, `SAML_TOKEN_PART`, `WssContext`)
  - `packages/engine/src/project/schema.ts:98-196` (entry schemas, union, nested-password refine)
  - `packages/engine/src/index.ts`
  - `test/unit/public-exports.test.ts` and `public-exports.types.ts`
- Modify: `packages/engine/test/unit/wss/outgoing/apply.test.ts:139`. It uses `{kind:'saml-token'}`
  as its "future kind" example, which becomes a real kind, so it switches to
  `{kind:'kerberos-ticket'}`.
- Test: `packages/engine/test/unit/wss/configs-saml.test.ts`

**Interfaces:**

- Produces:
  - `SamlVersion = '1.1' | '2.0'`
  - `WsTrustVersion = '1.3' | '2005-02'`
  - `IssuedKeyType = 'bearer' | 'public-key'`
  - `StsCredential`
  - `WssIssuedTokenEntry`
  - `SamlAttribute`
  - `SamlConfirmation`
  - `WssSamlSigning`
  - `WssSamlFormEntry`
  - `WssSamlXmlEntry`
  - `WssSamlTokenEntry`
  - `SAML_TOKEN_PART`
  - `SAML_NOT_BEFORE_SKEW_SECONDS`
  - `WssKeyIdentifierType`, which gains `'saml-token'`
  - `WssPart`, which gains `token?: true`
  - `WssContext.expand?`, `WssContext.projectFile?` and `WssContext.issuedTokens?`, as
    `BoundIssuedTokens`
  - `IssuedToken`, including `proofCertPem?`
  - `wssSamlTokenEntrySchema`, `wssIssuedTokenEntrySchema`
- The URI constants in `wss/saml/uris.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/unit/wss/configs-saml.test.ts
import { describe, expect, it } from 'vitest';
import { toWssOutgoingConfig, toWssOutgoingRef } from '../../../src/wss/configs.js';
import { wssOutgoingFileSchema } from '../../../src/project/schema.js';
import type { WssRef } from '../../../src/project/model.js';

function ref(entries: unknown[]): WssRef {
  return { id: 'w1', name: 'Federated', document: { id: 'w1', name: 'Federated', entries } } as WssRef;
}

const issued = {
  kind: 'issued-token',
  stsUrl: 'https://sts.example.test/trust/13/usernamemixed',
  soapVersion: '1.2',
  trustVersion: '1.3',
  tokenType: '2.0',
  keyType: 'bearer',
  credential: { kind: 'username', username: 'alice', passwordRef: 'sec_sts' },
  requestedLifetimeSeconds: 0,
};

describe('SAML entry kinds in the project format', () => {
  it('loads an issued-token entry typed, not as an unknown kind', () => {
    const config = toWssOutgoingConfig(ref([issued]));
    expect(config.entries[0]).toMatchObject({ kind: 'issued-token', trustVersion: '1.3', keyType: 'bearer' });
  });

  it('loads both saml-token variants', () => {
    const config = toWssOutgoingConfig(
      ref([
        { kind: 'saml-token', source: 'xml', xml: '<saml2:Assertion/>', expandProperties: false },
        {
          kind: 'saml-token',
          source: 'form',
          version: '2.0',
          issuer: 'urn:test:issuer',
          subject: 'alice',
          confirmation: 'bearer',
          lifetimeSeconds: 300,
          attributes: [{ name: 'role', values: ['admin'] }],
        },
      ]),
    );
    expect(config.entries.map((entry) => entry.kind)).toEqual(['saml-token', 'saml-token']);
  });

  it('rejects a plaintext password nested in a credential', () => {
    const parsed = wssOutgoingFileSchema.safeParse({
      id: 'w1',
      name: 'Bad',
      entries: [{ ...issued, credential: { kind: 'username', username: 'alice', password: 'hunter2' } }],
    });
    expect(parsed.success).toBe(false);
  });

  it('round-trips an issued-token entry unchanged', () => {
    const config = toWssOutgoingConfig(ref([issued]));
    expect(toWssOutgoingRef(config).document['entries']).toEqual([issued]);
  });

  it('accepts the saml-token key identifier and the SamlToken part on a signature', () => {
    const config = toWssOutgoingConfig(
      ref([
        {
          kind: 'signature',
          keystoreRef: 'ks1',
          keyIdentifierType: 'saml-token',
          parts: [{ name: 'SamlToken', namespace: '', encode: 'Element', token: true }],
        },
      ]),
    );
    expect(config.entries[0]).toMatchObject({ keyIdentifierType: 'saml-token' });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @wirebench/engine exec vitest run test/unit/wss/configs-saml.test.ts`

Expected: FAIL. The entries load as unknown kinds, so the `toMatchObject` checks fail, and the
nested password passes.

- [ ] **Step 3: Add the namespaces and URIs**

In `xml/namespaces.ts`, add the following to `NS` and to `PREFIX`, which is a `Record` over `NS`
keys, so both must change:

```ts
  SAML1: 'urn:oasis:names:tc:SAML:1.0:assertion',
  SAML2: 'urn:oasis:names:tc:SAML:2.0:assertion',
  WSSE11: 'http://docs.oasis-open.org/wss/oasis-wss-wssecurity-secext-1.1.xsd',
  WST13: 'http://docs.oasis-open.org/ws-sx/ws-trust/200512',
  WST2005: 'http://schemas.xmlsoap.org/ws/2005/02/trust',
```

```ts
  SAML1: 'saml',
  SAML2: 'saml2',
  WSSE11: 'wsse11',
  WST13: 'wst',
  WST2005: 'wst',
```

```ts
// packages/engine/src/wss/saml/uris.ts
/**
 * The URIs the SAML token profile, SAML itself and the two WS-Trust versions this build speaks
 * use as identifiers. Kept apart from `xml/namespaces.ts` because none of them is a namespace.
 */
import type { IssuedKeyType, SamlConfirmation, SamlVersion, WsTrustVersion } from '../model.js';

/** `wsse11:TokenType` / `wst:TokenType`, by SAML version (WSS SAML token profile 1.1). */
export const SAML_TOKEN_TYPE: Record<SamlVersion, string> = {
  '1.1': 'http://docs.oasis-open.org/wss/oasis-wss-saml-token-profile-1.1#SAMLV1.1',
  '2.0': 'http://docs.oasis-open.org/wss/oasis-wss-saml-token-profile-1.1#SAMLV2.0',
};

/** The `wsse:KeyIdentifier` `ValueType` that names an assertion by its id, by SAML version. */
export const SAML_KEY_IDENTIFIER_VALUE_TYPE: Record<SamlVersion, string> = {
  '1.1': 'http://docs.oasis-open.org/wss/oasis-wss-saml-token-profile-1.0#SAMLAssertionID',
  '2.0': 'http://docs.oasis-open.org/wss/oasis-wss-saml-token-profile-1.1#SAMLID',
};

/** `SubjectConfirmation` methods, by SAML version. */
export const SAML_CONFIRMATION_METHOD: Record<SamlVersion, Record<SamlConfirmation, string>> = {
  '1.1': {
    bearer: 'urn:oasis:names:tc:SAML:1.0:cm:bearer',
    'holder-of-key': 'urn:oasis:names:tc:SAML:1.0:cm:holder-of-key',
    'sender-vouches': 'urn:oasis:names:tc:SAML:1.0:cm:sender-vouches',
  },
  '2.0': {
    bearer: 'urn:oasis:names:tc:SAML:2.0:cm:bearer',
    'holder-of-key': 'urn:oasis:names:tc:SAML:2.0:cm:holder-of-key',
    'sender-vouches': 'urn:oasis:names:tc:SAML:2.0:cm:sender-vouches',
  },
};

/** The default authentication context for a form assertion's `AuthnStatement`. */
export const SAML_AUTHN_CONTEXT_UNSPECIFIED = 'urn:oasis:names:tc:SAML:2.0:ac:classes:unspecified';
export const SAML1_AUTHN_METHOD_UNSPECIFIED = 'urn:oasis:names:tc:SAML:1.0:am:unspecified';

/** The STR-Transform (WSS SOAP Message Security 1.0 §8.3). */
export const STR_TRANSFORM =
  'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#STR-Transform';

/** The Kerberos token profile's AP-REQ value type. */
export const KERBEROS_AP_REQ_VALUE_TYPE =
  'http://docs.oasis-open.org/wss/oasis-wss-kerberos-token-profile-1.1#GSS_Kerberosv5_AP_REQ';

/** What differs between WS-Trust 1.3 and the February 2005 draft. */
export interface TrustUris {
  readonly namespace: string;
  readonly issueAction: string;
  readonly requestTypeIssue: string;
  readonly keyType: Record<IssuedKeyType, string>;
}

export const TRUST_URIS: Record<WsTrustVersion, TrustUris> = {
  '1.3': {
    namespace: 'http://docs.oasis-open.org/ws-sx/ws-trust/200512',
    issueAction: 'http://docs.oasis-open.org/ws-sx/ws-trust/200512/RST/Issue',
    requestTypeIssue: 'http://docs.oasis-open.org/ws-sx/ws-trust/200512/Issue',
    keyType: {
      bearer: 'http://docs.oasis-open.org/ws-sx/ws-trust/200512/Bearer',
      'public-key': 'http://docs.oasis-open.org/ws-sx/ws-trust/200512/PublicKey',
    },
  },
  '2005-02': {
    namespace: 'http://schemas.xmlsoap.org/ws/2005/02/trust',
    issueAction: 'http://schemas.xmlsoap.org/ws/2005/02/trust/RST/Issue',
    requestTypeIssue: 'http://schemas.xmlsoap.org/ws/2005/02/trust/Issue',
    keyType: {
      // The 2005/02 draft defines no bearer key type; deployments of it use this identity URI.
      bearer: 'http://schemas.xmlsoap.org/ws/2005/05/identity/NoProofKey',
      'public-key': 'http://schemas.xmlsoap.org/ws/2005/02/trust/PublicKey',
    },
  },
};
```

- [ ] **Step 4: Add the model types**

In `wss/model.ts`:

- Add the following after `WssEncryptionEntry`.
- Widen `WssKeyIdentifierType` with `| 'saml-token'`, and `WssPart` with
  `readonly token?: true;`.
- Replace `WssEntry` and `WSS_ENTRY_KINDS` with the versions below.

```ts
export type SamlVersion = '1.1' | '2.0';
export type WsTrustVersion = '1.3' | '2005-02';
export type IssuedKeyType = 'bearer' | 'public-key';

/** How the request for a token proves who is asking. */
export type StsCredential =
  | { readonly kind: 'username'; readonly username: string; readonly passwordRef?: string }
  | { readonly kind: 'certificate'; readonly keystoreRef: string; readonly alias?: string; readonly keyPasswordRef?: string }
  | {
      readonly kind: 'kerberos';
      /** The STS's service principal: `host/sts.corp`, `HTTP@sts.corp` or a bare host (#40 normalises). */
      readonly spn: string;
      readonly principal?: string;
      /** Windows only (#40 §D1). */
      readonly username?: string;
      readonly domain?: string;
      readonly passwordRef?: string;
    };

/** A SAML assertion requested from a security token service over WS-Trust. */
export interface WssIssuedTokenEntry {
  readonly kind: 'issued-token';
  /** STS endpoint URL; `${…}` expands. */
  readonly stsUrl: string;
  readonly soapVersion: '1.1' | '1.2';
  readonly trustVersion: WsTrustVersion;
  /** `wsp:AppliesTo` address; empty means the request's own endpoint. `${…}` expands. */
  readonly appliesTo?: string;
  readonly tokenType: SamlVersion;
  readonly keyType: IssuedKeyType;
  /** For `public-key`: the alias whose certificate goes into `wst:UseKey`; `defaultAlias` when unset. */
  readonly proofKeystoreRef?: string;
  readonly proofAlias?: string;
  readonly credential: StsCredential;
  /** Requested lifetime in seconds; `0` leaves `wst:Lifetime` out. */
  readonly requestedLifetimeSeconds: number;
  /** Raw `wst:Claims` XML, copied in as it is. `${…}` expands. */
  readonly claims?: string;
  /** Client certificate for mutual TLS to the STS. */
  readonly tlsKeystoreRef?: string;
}

export interface SamlAttribute {
  readonly name: string;
  readonly nameFormat?: string;
  readonly values: readonly string[];
}

export type SamlConfirmation = 'bearer' | 'holder-of-key' | 'sender-vouches';

/** The issuer key a form assertion is signed with. */
export interface WssSamlSigning {
  readonly keystoreRef: string;
  readonly alias?: string;
  readonly keyPasswordRef?: string;
  readonly signatureAlgorithm: WssSignatureAlgorithm;
}

/** A self-issued assertion built from fields. */
export interface WssSamlFormEntry {
  readonly kind: 'saml-token';
  readonly source: 'form';
  readonly version: SamlVersion;
  readonly issuer: string;
  readonly subject: string;
  readonly subjectFormat?: string;
  readonly confirmation: SamlConfirmation;
  readonly audience?: string;
  /** Seconds valid from now; `NotBefore` is backdated by {@link SAML_NOT_BEFORE_SKEW_SECONDS}. */
  readonly lifetimeSeconds: number;
  readonly authnContext?: string;
  readonly attributes: readonly SamlAttribute[];
  readonly sign?: WssSamlSigning;
  /** For holder-of-key: the alias whose certificate goes into `SubjectConfirmationData`. */
  readonly proofKeystoreRef?: string;
  readonly proofAlias?: string;
}

/** A self-issued assertion supplied as XML, inline or as a project file. */
export interface WssSamlXmlEntry {
  readonly kind: 'saml-token';
  readonly source: 'xml';
  readonly xml?: string;
  /** Project-relative; read inside the project folder only. */
  readonly file?: string;
  /** Expand `${…}` first; off by default because it would break a signed assertion. */
  readonly expandProperties: boolean;
}

export type WssSamlTokenEntry = WssSamlFormEntry | WssSamlXmlEntry;

/** How far a form assertion's `NotBefore` is backdated, for receivers whose clocks run behind. */
export const SAML_NOT_BEFORE_SKEW_SECONDS = 60;

/** The signature part that covers the nearest earlier SAML token, through the STR-Transform. */
export const SAML_TOKEN_PART: WssPart = { name: 'SamlToken', namespace: '', encode: 'Element', token: true };

/** One element of an outgoing WS-Security configuration, applied in configuration order. */
export type WssEntry =
  | WssTimestampEntry
  | WssUsernameTokenEntry
  | WssSignatureEntry
  | WssEncryptionEntry
  | WssIssuedTokenEntry
  | WssSamlTokenEntry;

/** Every entry kind, in the order the editor offers them. */
export const WSS_ENTRY_KINDS = [
  'timestamp',
  'username-token',
  'signature',
  'encryption',
  'issued-token',
  'saml-token',
] as const;

/** A token an STS issued, as cached: self-contained, never an `Element` (plan amendment 2). */
export interface IssuedToken {
  readonly assertionXml: string;
  /** `ID` (2.0) or `AssertionID` (1.1); absent for an `EncryptedAssertion`. */
  readonly assertionId?: string;
  /** The RSTR's `RequestedAttachedReference` STR, serialised, when it had one. */
  readonly attachedReferenceXml?: string;
  readonly samlVersion: SamlVersion;
  readonly keyType: IssuedKeyType;
  readonly expiresAt?: Date;
  /** The certificate a public-key token is bound to (what `UseKey` sent). */
  readonly proofCertPem?: string;
  /** Where the token came from, for the status line and the verbose line. */
  readonly stsHost: string;
  readonly cacheKey: string;
}

/** The issued-token source, already bound to this send's endpoint, scopes, TLS and proxy. */
export interface BoundIssuedTokens {
  get(entry: WssIssuedTokenEntry): Promise<IssuedToken>;
  /** Only what is cached; never contacts the STS. */
  peek(entry: WssIssuedTokenEntry): IssuedToken | undefined;
}
```

Extend `WssContext`:

```ts
  /** Expands `${…}`; throws `unresolved-properties`. Absent: text is used as written. */
  readonly expand?: (text: string) => string;
  /** Reads a project-relative file inside the project folder; throws `saml-token-file-missing`. */
  readonly projectFile?: (path: string) => Promise<string>;
  /** Issued tokens for this send. Absent: an issued-token entry refuses with `ws-trust-unavailable`. */
  readonly issuedTokens?: BoundIssuedTokens;
```

`createWssContext` copies the three members through when they are given, and adds no defaults:

```ts
    ...(overrides?.expand !== undefined ? { expand: overrides.expand } : {}),
    ...(overrides?.projectFile !== undefined ? { projectFile: overrides.projectFile } : {}),
    ...(overrides?.issuedTokens !== undefined ? { issuedTokens: overrides.issuedTokens } : {}),
```

- [ ] **Step 5: Add the schemas**

In `project/schema.ts`, after `wssEncryptionEntrySchema`:

```ts
/** True when `value` holds a `password` key at any depth: secrets are references, everywhere. */
function hasPlaintextPassword(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasPlaintextPassword);
  return Object.entries(value).some(([key, inner]) => key === 'password' || hasPlaintextPassword(inner));
}

const stsCredentialSchema = z.discriminatedUnion('kind', [
  z.looseObject({ kind: z.literal('username'), username: z.string(), passwordRef: z.string().optional() }),
  z.looseObject({
    kind: z.literal('certificate'),
    keystoreRef: z.string().default(''),
    alias: z.string().optional(),
    keyPasswordRef: z.string().optional(),
  }),
  z.looseObject({
    kind: z.literal('kerberos'),
    spn: z.string(),
    principal: z.string().optional(),
    username: z.string().optional(),
    domain: z.string().optional(),
    passwordRef: z.string().optional(),
  }),
]);

export const wssIssuedTokenEntrySchema = z.looseObject({
  kind: z.literal('issued-token'),
  stsUrl: z.string(),
  soapVersion: z.enum(['1.1', '1.2']).default('1.2'),
  trustVersion: z.enum(['1.3', '2005-02']).default('1.3'),
  appliesTo: z.string().optional(),
  tokenType: z.enum(['1.1', '2.0']).default('2.0'),
  keyType: z.enum(['bearer', 'public-key']).default('bearer'),
  proofKeystoreRef: z.string().optional(),
  proofAlias: z.string().optional(),
  credential: stsCredentialSchema,
  requestedLifetimeSeconds: z.number().int().nonnegative().default(0),
  claims: z.string().optional(),
  tlsKeystoreRef: z.string().optional(),
});

const samlAttributeSchema = z.looseObject({
  name: z.string(),
  nameFormat: z.string().optional(),
  values: z.array(z.string()),
});

export const wssSamlTokenEntrySchema = z.discriminatedUnion('source', [
  z.looseObject({
    kind: z.literal('saml-token'),
    source: z.literal('form'),
    version: z.enum(['1.1', '2.0']).default('2.0'),
    issuer: z.string(),
    subject: z.string(),
    subjectFormat: z.string().optional(),
    confirmation: z.enum(['bearer', 'holder-of-key', 'sender-vouches']).default('bearer'),
    audience: z.string().optional(),
    lifetimeSeconds: z.number().int().positive().default(300),
    authnContext: z.string().optional(),
    attributes: z.array(samlAttributeSchema).default([]),
    sign: z
      .looseObject({
        keystoreRef: z.string(),
        alias: z.string().optional(),
        keyPasswordRef: z.string().optional(),
        signatureAlgorithm: z.enum(['rsa-sha256', 'rsa-sha1']).default('rsa-sha256'),
      })
      .optional(),
    proofKeystoreRef: z.string().optional(),
    proofAlias: z.string().optional(),
  }),
  z
    .looseObject({
      kind: z.literal('saml-token'),
      source: z.literal('xml'),
      xml: z.string().optional(),
      file: z.string().optional(),
      expandProperties: z.boolean().default(false),
    })
    .refine((value) => (value.xml === undefined) !== (value.file === undefined), {
      message: 'a SAML token gives exactly one of "xml" and "file"',
      path: ['xml'],
    }),
]);
```

zod 4 may refuse a refined object as a `discriminatedUnion` option. If it does, move the
`xml`/`file` refine onto the union itself:
`wssSamlTokenEntrySchema = z.discriminatedUnion(...).refine((v) => v.source === 'form' || (v.xml === undefined) !== (v.file === undefined), …)`.

Make these changes to the existing schemas:

- Add `wssIssuedTokenEntrySchema` and `wssSamlTokenEntrySchema` to the `wssEntrySchema` union.
- Signature entry: extend `keyIdentifierType`'s enum with `'saml-token'`.
- Encryption entry: its enum stays X.509-only.
- `wssPartSchema`: add `token: z.literal(true).optional()`.
- `wssStoredEntrySchema`: switch its refine to `(value) => !hasPlaintextPassword(value)`.
- `wssUsernameTokenEntrySchema`: its own refine stays as it is.

- [ ] **Step 6: Update the future-kind test and the exports**

In `test/unit/wss/outgoing/apply.test.ts:139`, replace `'saml-token'` with `'kerberos-ticket'`.

In `src/index.ts`, export from `./wss/model.js`:

- types: `WssIssuedTokenEntry`, `WssSamlTokenEntry`, `WssSamlFormEntry`, `WssSamlXmlEntry`,
  `StsCredential`, `IssuedToken`, `BoundIssuedTokens`, `SamlVersion`, `WsTrustVersion`,
  `IssuedKeyType`;
- the value `SAML_TOKEN_PART`.

Add `'SAML_TOKEN_PART'` to `ADDED` in `public-exports.test.ts`, and the type names to
`public-exports.types.ts`.

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @wirebench/engine exec vitest run test/unit/wss test/unit/public-exports.test.ts`

Expected: PASS.

- [ ] **Step 8: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 pnpm check
git add packages/engine
git commit -m "feat(engine): model issued-token and saml-token WS-Security entries (#41)"
```

### Task 2: Place a supplied (XML) assertion

**Files:**

- Create:
  - `packages/engine/src/wss/saml/read.ts`
  - `packages/engine/src/wss/outgoing/saml.ts`
- Modify:
  - `packages/engine/src/wss/apply.ts` (placement, the placed-token list)
  - `packages/engine/src/wss/outgoing/signature.ts` (`ResolvedSigningKey.placedTokens`)
  - `packages/engine/src/soap/run.ts` `wssFor` (lend `expand` and `projectFile`)
- Test:
  - `packages/engine/test/unit/wss/saml/read.test.ts`
  - `packages/engine/test/unit/wss/outgoing/saml-place.test.ts`

**Interfaces:**

- Consumes: Task 1 types.
- Produces:
  - `readAssertion(xml: string): ReadAssertion`, where `ReadAssertion` is
    `{ element: Element; version: SamlVersion; id?: string; encrypted: boolean; holderOfKeyCertPem?: string }`
  - `PlacedSamlToken`:
    `{ version: SamlVersion; assertionId?: string; attachedReferenceXml?: string; proofCertPem?: string; confirmation?: SamlConfirmation }`
  - `resolveSamlToken(entry: WssSamlTokenEntry | WssIssuedTokenEntry, config: WssOutgoingConfig, ctx: WssContext): Promise<ResolvedSamlToken>`,
    where `ResolvedSamlToken` is `{ assertionXml: string; placed: PlacedSamlToken }`
  - `ResolvedSigningKey.placedTokens?: readonly PlacedSamlToken[]`
  - `wssFor(selected, context, scopes, endpointUrl)`, which gains its last two parameters.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/engine/test/unit/wss/saml/read.test.ts
import { describe, expect, it } from 'vitest';
import { readAssertion } from '../../../../src/wss/saml/read.js';

const SAML2 =
  '<saml2:Assertion xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a1" Version="2.0"' +
  ' IssueInstant="2026-10-05T10:00:00Z"><saml2:Issuer>urn:test</saml2:Issuer></saml2:Assertion>';
const SAML1 =
  '<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:1.0:assertion" AssertionID="_b1" MajorVersion="1"' +
  ' MinorVersion="1" Issuer="urn:test" IssueInstant="2026-10-05T10:00:00Z"/>';

describe('readAssertion', () => {
  it('reads a SAML 2.0 assertion and its ID', () => {
    expect(readAssertion(SAML2)).toMatchObject({ version: '2.0', id: '_a1', encrypted: false });
  });

  it('reads a SAML 1.1 assertion and its AssertionID', () => {
    expect(readAssertion(SAML1)).toMatchObject({ version: '1.1', id: '_b1', encrypted: false });
  });

  it('accepts an EncryptedAssertion as opaque, with no id', () => {
    const read = readAssertion(
      '<saml2:EncryptedAssertion xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion"><x/></saml2:EncryptedAssertion>',
    );
    expect(read).toMatchObject({ version: '2.0', encrypted: true });
    expect(read.id).toBeUndefined();
  });

  it('refuses any other root with saml-token-invalid', () => {
    expect(() => readAssertion('<Envelope/>')).toThrow(expect.objectContaining({ code: 'saml-token-invalid' }));
  });

  it('refuses text that is not XML with saml-token-invalid', () => {
    expect(() => readAssertion('not xml <')).toThrow(expect.objectContaining({ code: 'saml-token-invalid' }));
  });
});
```

```ts
// packages/engine/test/unit/wss/outgoing/saml-place.test.ts
import { describe, expect, it } from 'vitest';
import { applyOutgoingWss } from '../../../../src/wss/apply.js';
import { createWssContext } from '../../../../src/wss/model.js';
import type { WssOutgoingConfig } from '../../../../src/wss/model.js';

const SOAP11 =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
  '<soapenv:Body><Ping/></soapenv:Body></soapenv:Envelope>';
const ASSERTION =
  '<saml2:Assertion xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a1" Version="2.0"' +
  ' IssueInstant="2026-10-05T10:00:00Z"><saml2:Issuer>urn:test</saml2:Issuer></saml2:Assertion>';

function config(entries: WssOutgoingConfig['entries']): WssOutgoingConfig {
  return { id: 'w1', name: 'Federated', mustUnderstand: false, entries };
}

describe('placing a supplied SAML assertion', () => {
  it('appends it to wsse:Security in entry order, unchanged', async () => {
    const xml = await applyOutgoingWss(
      SOAP11,
      config([
        { kind: 'timestamp', timeToLiveSeconds: 300, millisecondPrecision: false },
        { kind: 'saml-token', source: 'xml', xml: ASSERTION, expandProperties: false },
      ]),
      createWssContext({ clock: () => new Date('2026-10-05T10:00:00Z'), uuid: () => 'u' }),
    );
    expect(xml.indexOf('wsu:Timestamp')).toBeLessThan(xml.indexOf('saml2:Assertion'));
    expect(xml).toContain('ID="_a1"');
    expect(xml).not.toMatch(/saml2:Assertion[^>]*wsu:Id/);
  });

  it('reads the file variant through ctx.projectFile', async () => {
    const xml = await applyOutgoingWss(
      SOAP11,
      config([{ kind: 'saml-token', source: 'xml', file: 'tokens/a.xml', expandProperties: false }]),
      createWssContext({ projectFile: (path) => Promise.resolve(path === 'tokens/a.xml' ? ASSERTION : '') }),
    );
    expect(xml).toContain('ID="_a1"');
  });

  it('refuses the file variant when the host lends no file reader', async () => {
    await expect(
      applyOutgoingWss(
        SOAP11,
        config([{ kind: 'saml-token', source: 'xml', file: 'tokens/a.xml', expandProperties: false }]),
        createWssContext(),
      ),
    ).rejects.toMatchObject({ code: 'saml-token-file-missing' });
  });

  it('expands ${…} only when the entry asks for it', async () => {
    const templated = ASSERTION.replace('urn:test', '${issuer}');
    const ctx = createWssContext({ expand: (text) => text.replace('${issuer}', 'urn:expanded') });
    const kept = await applyOutgoingWss(
      SOAP11,
      config([{ kind: 'saml-token', source: 'xml', xml: templated, expandProperties: false }]),
      ctx,
    );
    const expanded = await applyOutgoingWss(
      SOAP11,
      config([{ kind: 'saml-token', source: 'xml', xml: templated, expandProperties: true }]),
      ctx,
    );
    expect(kept).toContain('${issuer}');
    expect(expanded).toContain('urn:expanded');
  });

  it('refuses an issued-token entry with ws-trust-unavailable when no source is lent', async () => {
    await expect(
      applyOutgoingWss(
        SOAP11,
        config([
          {
            kind: 'issued-token',
            stsUrl: 'https://sts.test/trust',
            soapVersion: '1.2',
            trustVersion: '1.3',
            tokenType: '2.0',
            keyType: 'bearer',
            credential: { kind: 'username', username: 'alice' },
            requestedLifetimeSeconds: 0,
          },
        ]),
        createWssContext(),
      ),
    ).rejects.toMatchObject({ code: 'ws-trust-unavailable' });
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm --filter @wirebench/engine exec vitest run test/unit/wss/saml test/unit/wss/outgoing/saml-place.test.ts`

Expected: FAIL, because `read.js` and the placement code do not exist. Applying an entry throws
`wss-entry-unsupported`.

- [ ] **Step 3: Implement `readAssertion`**

```ts
// packages/engine/src/wss/saml/read.ts
/**
 * Reads a SAML assertion supplied as text: which version it is, its id, and the holder-of-key
 * certificate it names. Parsed with the engine's hardened parser (no DTDs, no external entities).
 */
import type { Element } from '@xmldom/xmldom';
import { WssError } from '../../errors.js';
import { parseXml } from '../../xml/parse.js';
import { NS } from '../../xml/namespaces.js';
import type { SamlVersion } from '../model.js';

export interface ReadAssertion {
  readonly element: Element;
  readonly version: SamlVersion;
  /** `ID` (2.0) or `AssertionID` (1.1); absent when encrypted. */
  readonly id?: string;
  readonly encrypted: boolean;
  /** The `ds:X509Certificate` in a holder-of-key `SubjectConfirmation`, as PEM. */
  readonly holderOfKeyCertPem?: string;
}

function invalid(reason: string): WssError {
  return new WssError('saml-token-invalid', `The SAML token is not a usable assertion: ${reason}.`);
}

function firstDescendant(root: Element, namespace: string, localName: string): Element | undefined {
  const found = root.getElementsByTagNameNS(namespace, localName);
  return found.length > 0 ? (found.item(0) ?? undefined) : undefined;
}

function pemOf(base64: string): string {
  const body = base64.replace(/\s+/g, '').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN CERTIFICATE-----\n${body.trimEnd()}\n-----END CERTIFICATE-----\n`;
}

/**
 * @throws WssError `saml-token-invalid` when the text does not parse or its root is not
 * `saml:Assertion`, `saml2:Assertion` or `saml2:EncryptedAssertion`
 */
export function readAssertion(xml: string): ReadAssertion {
  let root: Element | null;
  try {
    root = parseXml(xml, { location: 'saml-token' }).documentElement;
  } catch {
    throw invalid('it is not well-formed XML');
  }
  if (root === null) throw invalid('it is empty');
  if (root.namespaceURI === NS.SAML2 && root.localName === 'EncryptedAssertion') {
    return { element: root, version: '2.0', encrypted: true };
  }
  const version: SamlVersion | undefined =
    root.namespaceURI === NS.SAML2 && root.localName === 'Assertion'
      ? '2.0'
      : root.namespaceURI === NS.SAML1 && root.localName === 'Assertion'
        ? '1.1'
        : undefined;
  if (version === undefined) throw invalid(`its root is <${root.nodeName}>`);
  const id = root.getAttribute(version === '2.0' ? 'ID' : 'AssertionID') ?? '';
  const confirmation = firstDescendant(root, version === '2.0' ? NS.SAML2 : NS.SAML1, 'SubjectConfirmation');
  const certificate = confirmation === undefined ? undefined : firstDescendant(confirmation, NS.DS, 'X509Certificate');
  const certText = certificate?.textContent?.trim();
  return {
    element: root,
    version,
    ...(id !== '' ? { id } : {}),
    encrypted: false,
    ...(certText !== undefined && certText !== '' ? { holderOfKeyCertPem: pemOf(certText) } : {}),
  };
}
```

`parseXml` may not throw on malformed input; it might only report problems. Check
`parseXmlDetailed` in `xml/parse.ts`. If it reports problems instead of throwing, call
`parseXmlDetailed` and treat any fatal problem as `invalid('it is not well-formed XML')`.

- [ ] **Step 4: Implement `resolveSamlToken`**

Here the form branch throws `wss-entry-unsupported`. Task 3 replaces it.

```ts
// packages/engine/src/wss/outgoing/saml.ts
/**
 * Resolves a SAML entry to the assertion it places: supplied XML, a form-built assertion, or a
 * token an STS issued. Whatever the source, the assertion is placed as it came: never given a
 * `wsu:Id`, never edited (spec §3.6).
 */
import { WssError } from '../../errors.js';
import { serializeXml } from '../../xml/serialize.js';
import { readAssertion } from '../saml/read.js';
import type {
  SamlConfirmation,
  SamlVersion,
  WssContext,
  WssIssuedTokenEntry,
  WssOutgoingConfig,
  WssSamlTokenEntry,
  WssSamlXmlEntry,
} from '../model.js';

/** What a later signature entry needs to know about a token placed before it. */
export interface PlacedSamlToken {
  readonly version: SamlVersion;
  readonly assertionId?: string;
  readonly attachedReferenceXml?: string;
  /** The certificate the token binds its holder to; a holder-of-key signature must use its key. */
  readonly proofCertPem?: string;
  readonly confirmation?: SamlConfirmation;
}

export interface ResolvedSamlToken {
  readonly assertionXml: string;
  readonly placed: PlacedSamlToken;
}

async function xmlOf(entry: WssSamlXmlEntry, ctx: WssContext): Promise<string> {
  let text: string;
  if (entry.file !== undefined) {
    if (ctx.projectFile === undefined) {
      throw new WssError('saml-token-file-missing', `The SAML token file "${entry.file}" cannot be read here.`, {
        details: { file: entry.file },
      });
    }
    text = await ctx.projectFile(entry.file);
  } else {
    text = entry.xml ?? '';
  }
  return entry.expandProperties && ctx.expand !== undefined ? ctx.expand(text) : text;
}

/**
 * @throws WssError `saml-token-invalid` | `saml-token-file-missing` | `ws-trust-unavailable`,
 * or what the issued-token source throws
 */
export async function resolveSamlToken(
  entry: WssSamlTokenEntry | WssIssuedTokenEntry,
  config: WssOutgoingConfig,
  ctx: WssContext,
): Promise<ResolvedSamlToken> {
  if (entry.kind === 'issued-token') {
    if (ctx.issuedTokens === undefined) {
      throw new WssError('ws-trust-unavailable', 'Issued tokens cannot be requested from here.');
    }
    const token = await ctx.issuedTokens.get(entry);
    return {
      assertionXml: token.assertionXml,
      placed: {
        version: token.samlVersion,
        ...(token.assertionId !== undefined ? { assertionId: token.assertionId } : {}),
        ...(token.attachedReferenceXml !== undefined ? { attachedReferenceXml: token.attachedReferenceXml } : {}),
        ...(token.proofCertPem !== undefined ? { proofCertPem: token.proofCertPem } : {}),
        confirmation: token.keyType === 'public-key' ? 'holder-of-key' : 'bearer',
      },
    };
  }
  if (entry.source === 'form') {
    void config;
    throw new WssError('wss-entry-unsupported', 'Form SAML tokens are not supported yet.');
  }
  const read = readAssertion(await xmlOf(entry, ctx));
  return {
    assertionXml: serializeXml(read.element),
    placed: {
      version: read.version,
      ...(read.id !== undefined ? { assertionId: read.id } : {}),
      ...(read.holderOfKeyCertPem !== undefined
        ? { proofCertPem: read.holderOfKeyCertPem, confirmation: 'holder-of-key' as const }
        : {}),
    },
  };
}
```

- [ ] **Step 5: Place it in `applyOutgoingWss`**

In `wss/apply.ts`, import `resolveSamlToken` and `PlacedSamlToken` from `./outgoing/saml.js`.
Inside `applyOutgoingWss`, before the loop:

```ts
  const placed: PlacedSamlToken[] = [];
```

In the loop, before the `signature` branch:

```ts
    if (entry.kind === 'saml-token' || entry.kind === 'issued-token') {
      const token = await resolveSamlToken(entry, config, ctx);
      const assertion = parseXml(token.assertionXml, { location: 'saml-token' }).documentElement;
      if (assertion !== null) security.appendChild(doc.importNode(assertion, true));
      placed.push(token.placed);
      continue;
    }
```

Change the signature branch to pass the list:

```ts
      await signEnvelope(doc, entry, { ...(await resolveKeystoreAlias(entry, config, ctx)), placedTokens: placed }, ctx);
```

`ResolvedSigningKey` in `outgoing/signature.ts` gains
`readonly placedTokens?: readonly PlacedSamlToken[];`. Use a type-only import of
`PlacedSamlToken` from `./saml.js`. The field is unused until Task 8.

- [ ] **Step 6: Lend `expand` and `projectFile` from `wssFor`**

In `soap/run.ts`, change `wssFor(selected, context)` to
`wssFor(selected, context, scopes, endpointUrl)`. The call site in `resolveSoap` passes `scopes`
(computed the line before) and `resolved.url`. Add to `createWssContext({...})`:

```ts
      expand: (text) => expandOrRefuse(text, scopes, 'WS-Security SAML token'),
      projectFile: async (path) => {
        const absolute = await insideProject(context, path, 'saml-token-file-missing', path);
        try {
          return await readFile(absolute, 'utf8');
        } catch (cause) {
          throw new WssError('saml-token-file-missing', `The SAML token file "${path}" could not be read.`, {
            details: { file: path },
            cause,
          });
        }
      },
```

and a new local helper next to `wssFor`:

```ts
/** `text` with `${…}` expanded; an unresolved reference refuses rather than sending it literally. */
function expandOrRefuse(text: string, scopes: PropertyScopes, what: string): string {
  const result = expand(text, scopes);
  if (result.unresolved.length > 0) {
    const exprs = result.unresolved.map((ref) => ref.expr);
    throw new WirebenchError(
      'unresolved-properties',
      `The ${what} has property references nothing resolves: ${exprs.join(', ')}`,
      { details: { unresolved: exprs } },
    );
  }
  return result.text;
}
```

Import `readFile` from `node:fs/promises` (`soap/run.ts` is a run module, where fs is allowed),
`insideProject` from `../run/send-helpers.js`, `expand` and `PropertyScopes` from
`../project/properties.js`, and `WssError` from `../errors.js`.

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @wirebench/engine exec vitest run test/unit/wss test/unit/soap`

Expected: PASS.

- [ ] **Step 8: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 pnpm check
git add packages/engine
git commit -m "feat(engine): place a supplied SAML assertion in WS-Security (#41)"
```

### Task 3: Build form assertions (SAML 1.1 and 2.0, optionally signed)

**Files:**

- Create:
  - `packages/engine/src/wss/saml/build.ts`
  - `packages/engine/test/fixtures/saml/make.ts`, which regenerates `assertion-2.0.xml`,
    `assertion-1.1.xml` and `issuer-cert.pem` for Task 10.
- Modify:
  - `packages/engine/src/wss/outgoing/saml.ts` (the form branch)
  - `packages/engine/src/wss/outgoing/signature.ts` (export `privateKeyOf`)
- Test: `packages/engine/test/unit/wss/saml/build.test.ts`

**Interfaces:**

- Consumes: `WssSamlFormEntry`, `SAML_CONFIRMATION_METHOD`, `SAML_NOT_BEFORE_SKEW_SECONDS`,
  `privateKeyOf` and `certificateBase64`.
- Produces:
  - `buildSamlAssertion(entry: WssSamlFormEntry, input: BuildSamlInput): string`
  - `BuildSamlInput`:
    `{ clock: () => Date; uuid: () => string; signing?: { alias: KeystoreAlias; passphrase?: string }; proofCertPem?: string }`

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/unit/wss/saml/build.test.ts
import { SignedXml } from 'xml-crypto';
import { describe, expect, it } from 'vitest';
import { buildSamlAssertion } from '../../../../src/wss/saml/build.js';
import { readAssertion } from '../../../../src/wss/saml/read.js';
import { generateSigningCert, generateTestCa } from '../../../helpers/test-certs.js';
import type { KeystoreAlias } from '../../../../src/keystore/model.js';
import type { WssSamlFormEntry } from '../../../../src/wss/model.js';

const ca = generateTestCa();
const issuerCert = generateSigningCert(ca);
const alias = {
  alias: 'issuer',
  certPem: issuerCert.certPem,
  keyPem: issuerCert.keyPem,
  chainPem: [ca.certPem],
} as unknown as KeystoreAlias;

const clock = () => new Date('2026-10-05T10:00:00.000Z');
const uuid = () => '1b2c';

function form(overrides: Partial<WssSamlFormEntry> = {}): WssSamlFormEntry {
  return {
    kind: 'saml-token',
    source: 'form',
    version: '2.0',
    issuer: 'urn:test:issuer',
    subject: 'alice',
    confirmation: 'bearer',
    audience: 'https://service.test/',
    lifetimeSeconds: 300,
    attributes: [{ name: 'role', values: ['admin', 'ops'] }],
    ...overrides,
  };
}

const signed = form({ sign: { keystoreRef: 'ks', signatureAlgorithm: 'rsa-sha256' } });

describe('buildSamlAssertion', () => {
  it('builds a SAML 2.0 bearer assertion with the clock and uuid it is given', () => {
    const xml = buildSamlAssertion(form(), { clock, uuid });
    expect(readAssertion(xml)).toMatchObject({ version: '2.0', id: '_1b2c' });
    expect(xml).toContain('IssueInstant="2026-10-05T10:00:00.000Z"');
    expect(xml).toContain('NotBefore="2026-10-05T09:59:00.000Z"');
    expect(xml).toContain('NotOnOrAfter="2026-10-05T10:05:00.000Z"');
    expect(xml).toContain('Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"');
    expect(xml).toContain('<saml2:Audience>https://service.test/</saml2:Audience>');
    expect(xml).toContain('<saml2:AttributeValue>ops</saml2:AttributeValue>');
  });

  it('builds a SAML 1.1 assertion with AssertionID', () => {
    const xml = buildSamlAssertion(form({ version: '1.1' }), { clock, uuid });
    expect(readAssertion(xml)).toMatchObject({ version: '1.1', id: '_1b2c' });
    expect(xml).toContain('<saml:ConfirmationMethod>urn:oasis:names:tc:SAML:1.0:cm:bearer</saml:ConfirmationMethod>');
  });

  it('escapes field text', () => {
    const xml = buildSamlAssertion(form({ subject: 'a<b&"c' }), { clock, uuid });
    expect(xml).toContain('a&lt;b&amp;"c');
  });

  it('puts the proof certificate into a holder-of-key confirmation', () => {
    const xml = buildSamlAssertion(form({ confirmation: 'holder-of-key' }), {
      clock,
      uuid,
      proofCertPem: issuerCert.certPem,
    });
    expect(readAssertion(xml).holderOfKeyCertPem?.replace(/\s/g, '')).toBe(issuerCert.certPem.replace(/\s/g, ''));
  });

  it('signs the assertion as its issuer with an enveloped signature over ID', () => {
    const xml = buildSamlAssertion(signed, { clock, uuid, signing: { alias } });
    const verifier = new SignedXml({ publicCert: issuerCert.certPem, idAttributes: ['ID'], getCertFromKeyInfo: () => null });
    const signature = /<ds:Signature[\s\S]*<\/ds:Signature>/.exec(xml)?.[0] ?? '';
    verifier.loadSignature(signature);
    expect(verifier.checkSignature(xml)).toBe(true);
  });

  it('places the issuer signature right after saml2:Issuer, as the schema requires', () => {
    const xml = buildSamlAssertion(signed, { clock, uuid, signing: { alias } });
    expect(xml.indexOf('</saml2:Issuer>')).toBeLessThan(xml.indexOf('<ds:Signature'));
    expect(xml.indexOf('<ds:Signature')).toBeLessThan(xml.indexOf('<saml2:Subject>'));
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @wirebench/engine exec vitest run test/unit/wss/saml/build.test.ts`

Expected: FAIL, because `build.js` does not exist.

- [ ] **Step 3: Implement**

```ts
// packages/engine/src/wss/saml/build.ts
/**
 * Builds a self-issued SAML assertion from a form entry, as a self-contained string that
 * declares every prefix it uses on its root, optionally signed by its issuer (an enveloped
 * signature over `ID`/`AssertionID`, exc-c14n, RSA).
 */
import { SignedXml } from 'xml-crypto';
import { certificateBase64 } from '../key-identifiers.js';
import { privateKeyOf } from '../outgoing/signature.js';
import { NS } from '../../xml/namespaces.js';
import { SAML1_AUTHN_METHOD_UNSPECIFIED, SAML_AUTHN_CONTEXT_UNSPECIFIED, SAML_CONFIRMATION_METHOD } from './uris.js';
import { SAML_NOT_BEFORE_SKEW_SECONDS } from '../model.js';
import type { KeystoreAlias } from '../../keystore/model.js';
import type { WssSamlFormEntry } from '../model.js';

const EXC_C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';
const SIGNATURE_URIS = {
  'rsa-sha256': 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  'rsa-sha1': 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
} as const;
const DIGEST_URIS = {
  'rsa-sha256': 'http://www.w3.org/2001/04/xmlenc#sha256',
  'rsa-sha1': 'http://www.w3.org/2000/09/xmldsig#sha1',
} as const;

export interface BuildSamlInput {
  readonly clock: () => Date;
  readonly uuid: () => string;
  readonly signing?: { readonly alias: KeystoreAlias; readonly passphrase?: string };
  readonly proofCertPem?: string;
}

/** Attribute value escaping. */
function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Text content escaping: `"` stays literal, as serializers write it. */
function text(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function keyInfo(certPem: string): string {
  return (
    `<ds:KeyInfo xmlns:ds="${NS.DS}"><ds:X509Data><ds:X509Certificate>${certificateBase64(certPem)}` +
    `</ds:X509Certificate></ds:X509Data></ds:KeyInfo>`
  );
}

function window(now: Date, lifetimeSeconds: number): { notBefore: string; notOnOrAfter: string } {
  return {
    notBefore: new Date(now.getTime() - SAML_NOT_BEFORE_SKEW_SECONDS * 1000).toISOString(),
    notOnOrAfter: new Date(now.getTime() + lifetimeSeconds * 1000).toISOString(),
  };
}

function saml2(entry: WssSamlFormEntry, id: string, now: Date, input: BuildSamlInput): string {
  const { notBefore, notOnOrAfter } = window(now, entry.lifetimeSeconds);
  const method = SAML_CONFIRMATION_METHOD['2.0'][entry.confirmation];
  const confirmationData =
    entry.confirmation === 'holder-of-key' && input.proofCertPem !== undefined
      ? `<saml2:SubjectConfirmationData xmlns:xsi="${NS.XSI}" xsi:type="saml2:KeyInfoConfirmationDataType">${keyInfo(input.proofCertPem)}</saml2:SubjectConfirmationData>`
      : `<saml2:SubjectConfirmationData NotOnOrAfter="${notOnOrAfter}"/>`;
  const format = entry.subjectFormat !== undefined ? ` Format="${esc(entry.subjectFormat)}"` : '';
  const audience =
    entry.audience !== undefined && entry.audience !== ''
      ? `<saml2:AudienceRestriction><saml2:Audience>${text(entry.audience)}</saml2:Audience></saml2:AudienceRestriction>`
      : '';
  const attributes =
    entry.attributes.length === 0
      ? ''
      : `<saml2:AttributeStatement>${entry.attributes
          .map(
            (attribute) =>
              `<saml2:Attribute Name="${esc(attribute.name)}"` +
              `${attribute.nameFormat !== undefined ? ` NameFormat="${esc(attribute.nameFormat)}"` : ''}>` +
              attribute.values.map((value) => `<saml2:AttributeValue>${text(value)}</saml2:AttributeValue>`).join('') +
              `</saml2:Attribute>`,
          )
          .join('')}</saml2:AttributeStatement>`;
  return (
    `<saml2:Assertion xmlns:saml2="${NS.SAML2}" ID="${id}" Version="2.0" IssueInstant="${now.toISOString()}">` +
    `<saml2:Issuer>${text(entry.issuer)}</saml2:Issuer>` +
    `<saml2:Subject><saml2:NameID${format}>${text(entry.subject)}</saml2:NameID>` +
    `<saml2:SubjectConfirmation Method="${method}">${confirmationData}</saml2:SubjectConfirmation></saml2:Subject>` +
    `<saml2:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">${audience}</saml2:Conditions>` +
    `<saml2:AuthnStatement AuthnInstant="${now.toISOString()}"><saml2:AuthnContext>` +
    `<saml2:AuthnContextClassRef>${text(entry.authnContext ?? SAML_AUTHN_CONTEXT_UNSPECIFIED)}</saml2:AuthnContextClassRef>` +
    `</saml2:AuthnContext></saml2:AuthnStatement>${attributes}</saml2:Assertion>`
  );
}

function saml1(entry: WssSamlFormEntry, id: string, now: Date, input: BuildSamlInput): string {
  const { notBefore, notOnOrAfter } = window(now, entry.lifetimeSeconds);
  const method = SAML_CONFIRMATION_METHOD['1.1'][entry.confirmation];
  const proof = entry.confirmation === 'holder-of-key' && input.proofCertPem !== undefined ? keyInfo(input.proofCertPem) : '';
  const format = entry.subjectFormat !== undefined ? ` Format="${esc(entry.subjectFormat)}"` : '';
  const subject =
    `<saml:Subject><saml:NameIdentifier${format}>${text(entry.subject)}</saml:NameIdentifier>` +
    `<saml:SubjectConfirmation><saml:ConfirmationMethod>${method}</saml:ConfirmationMethod>${proof}` +
    `</saml:SubjectConfirmation></saml:Subject>`;
  const audience =
    entry.audience !== undefined && entry.audience !== ''
      ? `<saml:AudienceRestrictionCondition><saml:Audience>${text(entry.audience)}</saml:Audience></saml:AudienceRestrictionCondition>`
      : '';
  const attributes =
    entry.attributes.length === 0
      ? ''
      : `<saml:AttributeStatement>${subject}${entry.attributes
          .map(
            (attribute) =>
              `<saml:Attribute AttributeName="${esc(attribute.name)}" AttributeNamespace="${esc(attribute.nameFormat ?? 'urn:wirebench:attributes')}">` +
              attribute.values.map((value) => `<saml:AttributeValue>${text(value)}</saml:AttributeValue>`).join('') +
              `</saml:Attribute>`,
          )
          .join('')}</saml:AttributeStatement>`;
  return (
    `<saml:Assertion xmlns:saml="${NS.SAML1}" MajorVersion="1" MinorVersion="1" AssertionID="${id}"` +
    ` Issuer="${esc(entry.issuer)}" IssueInstant="${now.toISOString()}">` +
    `<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">${audience}</saml:Conditions>` +
    `<saml:AuthenticationStatement AuthenticationMethod="${esc(entry.authnContext ?? SAML1_AUTHN_METHOD_UNSPECIFIED)}"` +
    ` AuthenticationInstant="${now.toISOString()}">${subject}</saml:AuthenticationStatement>${attributes}</saml:Assertion>`
  );
}

/** The assertion `entry` describes, signed as its issuer when `entry.sign` and `input.signing` are both given. */
export function buildSamlAssertion(entry: WssSamlFormEntry, input: BuildSamlInput): string {
  const now = input.clock();
  const id = `_${input.uuid()}`;
  const unsigned = entry.version === '2.0' ? saml2(entry, id, now, input) : saml1(entry, id, now, input);
  const signing = input.signing;
  if (signing === undefined || entry.sign === undefined) return unsigned;
  const algorithm = entry.sign.signatureAlgorithm;
  const idAttribute = entry.version === '2.0' ? 'ID' : 'AssertionID';
  const signer = new SignedXml({
    privateKey: privateKeyOf(signing.alias, signing.passphrase),
    publicCert: signing.alias.certPem,
    canonicalizationAlgorithm: EXC_C14N,
    signatureAlgorithm: SIGNATURE_URIS[algorithm],
    idAttributes: [idAttribute],
    getKeyInfoContent: () =>
      `<ds:X509Data><ds:X509Certificate>${certificateBase64(signing.alias.certPem)}</ds:X509Certificate></ds:X509Data>`,
  });
  signer.addReference({
    xpath: `/*[@${idAttribute}='${id}']`,
    transforms: [ENVELOPED, EXC_C14N],
    digestAlgorithm: DIGEST_URIS[algorithm],
  });
  // SAML 2.0's schema puts ds:Signature right after Issuer; SAML 1.1 puts it last.
  const location =
    entry.version === '2.0'
      ? { reference: `/*/*[local-name()='Issuer']`, action: 'after' as const }
      : { reference: '/*', action: 'append' as const };
  signer.computeSignature(unsigned, { prefix: 'ds', location });
  return signer.getSignedXml();
}
```

In `outgoing/signature.ts`, export `privateKeyOf`, which is file-local today. Change
`function privateKeyOf` to `export function privateKeyOf`.

- [ ] **Step 4: Wire the form branch in `outgoing/saml.ts`**

Replace the form `throw` (and the `void config;`) with:

```ts
  if (entry.source === 'form') {
    const signing = entry.sign === undefined ? undefined : await signingKeyOf(entry.sign, config, ctx);
    const proofCertPem = entry.confirmation === 'holder-of-key' ? await formProofCertOf(entry, config, ctx) : undefined;
    const xml = buildSamlAssertion(entry, {
      clock: ctx.clock,
      uuid: ctx.uuid,
      ...(signing !== undefined ? { signing } : {}),
      ...(proofCertPem !== undefined ? { proofCertPem } : {}),
    });
    const read = readAssertion(xml);
    return {
      assertionXml: xml,
      placed: {
        version: read.version,
        ...(read.id !== undefined ? { assertionId: read.id } : {}),
        ...(proofCertPem !== undefined ? { proofCertPem } : {}),
        confirmation: entry.confirmation,
      },
    };
  }
```

with these helpers in the same file:

```ts
async function aliasOf(keystoreRef: string, alias: string | undefined, config: WssOutgoingConfig, ctx: WssContext) {
  const keystore = await ctx.keystores(keystoreRef);
  if (keystore === undefined) {
    throw new WssError('wss-keystore-missing', 'The keystore this entry needs is not available.', {
      details: { keystoreRef },
    });
  }
  return selectAlias(keystore, alias ?? config.defaultAlias);
}

async function signingKeyOf(sign: WssSamlSigning, config: WssOutgoingConfig, ctx: WssContext) {
  const alias = await aliasOf(sign.keystoreRef, sign.alias, config, ctx);
  const passphrase = sign.keyPasswordRef === undefined ? undefined : await ctx.secrets(sign.keyPasswordRef);
  return { alias, ...(passphrase !== undefined ? { passphrase } : {}) };
}

/** @throws WssError `wss-proof-key-missing` when a holder-of-key entry names no proof keystore */
async function formProofCertOf(entry: WssSamlFormEntry, config: WssOutgoingConfig, ctx: WssContext): Promise<string> {
  if (entry.proofKeystoreRef === undefined || entry.proofKeystoreRef === '') {
    throw new WssError('wss-proof-key-missing', 'A holder-of-key SAML token needs a proof certificate.');
  }
  return (await aliasOf(entry.proofKeystoreRef, entry.proofAlias, config, ctx)).certPem;
}
```

Import `selectAlias` from `../../keystore/index.js`, `buildSamlAssertion` from `../saml/build.js`,
and the types `WssSamlFormEntry` and `WssSamlSigning`.

- [ ] **Step 5: Generate the fixtures**

```ts
// packages/engine/test/fixtures/saml/make.ts
/** Regenerates the signed assertion fixtures: `node packages/engine/test/fixtures/saml/make.ts`. */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSamlAssertion } from '../../../src/wss/saml/build.ts';
import { generateSigningCert, generateTestCa } from '../../helpers/test-certs.ts';

const ca = generateTestCa();
const issuer = generateSigningCert(ca);
const alias = { alias: 'issuer', certPem: issuer.certPem, keyPem: issuer.keyPem, chainPem: [ca.certPem] } as never;
const here = (name: string) => fileURLToPath(new URL(name, import.meta.url));
for (const version of ['2.0', '1.1'] as const) {
  const xml = buildSamlAssertion(
    {
      kind: 'saml-token',
      source: 'form',
      version,
      issuer: 'urn:sts:fixture',
      subject: 'alice',
      confirmation: 'bearer',
      lifetimeSeconds: 3600,
      attributes: [],
      sign: { keystoreRef: 'x', signatureAlgorithm: 'rsa-sha256' },
    },
    { clock: () => new Date('2026-10-05T10:00:00.000Z'), uuid: () => `fixture-${version}`, signing: { alias } },
  );
  writeFileSync(here(`assertion-${version}.xml`), xml);
}
writeFileSync(here('issuer-cert.pem'), issuer.certPem);
```

Run `node packages/engine/test/fixtures/saml/make.ts`, then commit the three generated files.
Node 24 runs `.ts` directly; the scripts folder already relies on that.

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @wirebench/engine exec vitest run test/unit/wss`

Expected: PASS.

- [ ] **Step 7: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 pnpm check
git add packages/engine
git commit -m "feat(engine): build and sign form SAML assertions (#41)"
```

### Task 4: Mask SAML tokens and Kerberos tokens

**Files:**

- Modify:
  - `packages/engine/src/redact/index.ts` (`redactXml` calls a new `redactSecurityTokens`)
  - `packages/cli/src/mcp/server.ts:28` and `packages/cli/src/ops/redact.ts:107` (wording)
- Test: `packages/engine/test/unit/redact/saml.test.ts`

**Interfaces:**

- Produces: `redactSecurityTokens(text: string): string`. It is exported from `redact/index.ts`
  and applied inside `redactXml` after the password pass. It does not run when `show` is set,
  because `redactXml` returns early.

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/unit/redact/saml.test.ts
import { describe, expect, it } from 'vitest';
import { redactXml, REDACTED } from '../../../src/redact/index.js';

const SIGNED =
  '<saml2:Assertion xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a1">' +
  '<saml2:Issuer>urn:sts</saml2:Issuer>' +
  '<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignedInfo/>' +
  '<ds:SignatureValue>c2lnbmF0dXJl</ds:SignatureValue></ds:Signature>' +
  '<saml2:Subject><saml2:NameID>alice</saml2:NameID></saml2:Subject></saml2:Assertion>';

describe('redactXml on security tokens', () => {
  it("masks an assertion's signature value and keeps the rest readable", () => {
    const out = redactXml(SIGNED);
    expect(out).not.toContain('c2lnbmF0dXJl');
    expect(out).toContain(`<ds:SignatureValue>${REDACTED}</ds:SignatureValue>`);
    expect(out).toContain('<saml2:NameID>alice</saml2:NameID>');
    expect(out).toContain('urn:sts');
  });

  it('leaves a message signature outside any assertion alone', () => {
    const message = '<ds:Signature xmlns:ds="x"><ds:SignatureValue>bWVzc2FnZQ==</ds:SignatureValue></ds:Signature>';
    expect(redactXml(message)).toContain('bWVzc2FnZQ==');
  });

  it('masks cipher values inside an EncryptedAssertion', () => {
    const encrypted =
      '<saml2:EncryptedAssertion xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion">' +
      '<xenc:EncryptedData xmlns:xenc="http://www.w3.org/2001/04/xmlenc#"><xenc:CipherData>' +
      '<xenc:CipherValue>Y2lwaGVy</xenc:CipherValue></xenc:CipherData></xenc:EncryptedData></saml2:EncryptedAssertion>';
    expect(redactXml(encrypted)).not.toContain('Y2lwaGVy');
  });

  it('masks a Kerberos BinarySecurityToken and keeps an X.509 one', () => {
    const kerberos =
      '<wsse:BinarySecurityToken ValueType="http://docs.oasis-open.org/wss/oasis-wss-kerberos-token-profile-1.1#GSS_Kerberosv5_AP_REQ">' +
      'YXByZXE=</wsse:BinarySecurityToken>';
    const x509 =
      '<wsse:BinarySecurityToken ValueType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3">' +
      'Y2VydA==</wsse:BinarySecurityToken>';
    expect(redactXml(kerberos)).not.toContain('YXByZXE=');
    expect(redactXml(x509)).toContain('Y2VydA==');
  });

  it('masks nothing when show is set', () => {
    expect(redactXml(SIGNED, { show: true })).toBe(SIGNED);
  });

  it('stays linear on an unclosed assertion in a large response', () => {
    const text = '<saml2:Assertion>' + '<saml2:Assertion>'.repeat(2000) + 'x'.repeat(256 * 1024);
    const started = performance.now();
    redactXml(text);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @wirebench/engine exec vitest run test/unit/redact/saml.test.ts`

Expected: FAIL, because the signature value is still visible.

- [ ] **Step 3: Implement**

The implementation is a forward scanner like the password pass, never a backtracking regex.
CodeQL flags those, and responses are untrusted. Each container is closed by a single
nesting-aware forward search, and the scan resumes past it, so the work is linear in the text.

Add to `redact/index.ts`:

```ts
/** Open tags of the token containers whose secrets are masked (any prefix). */
const TOKEN_OPEN_RE = /<(?:[\w-]+:)?(Assertion|EncryptedAssertion|RequestedProofToken)\b/g;
/** Values inside a token that make it usable: its signature, or its ciphertext. */
const TOKEN_SECRET_RE = /<((?:[\w-]+:)?(?:SignatureValue|CipherValue))\b[^>]*>/g;
/** A Kerberos BinarySecurityToken's open tag (its ValueType names the Kerberos profile). */
const KERBEROS_BST_OPEN_RE = /<((?:[\w-]+:)?BinarySecurityToken)\b[^>]*Kerberosv5_AP_REQ[^>]*>/g;

/**
 * The index just past the element whose open tag ended at `from`, counting nested elements of
 * the same local name; -1 when it never closes. One forward pass: each step moves past either an
 * open or a close tag.
 */
function closeOf(text: string, from: number, name: string): number {
  const tag = new RegExp(`<(/?)(?:[\\w-]+:)?${name}\\b[^>]*>`, 'g');
  let depth = 1;
  tag.lastIndex = from;
  for (;;) {
    const found = tag.exec(text);
    if (found === null) return -1;
    if (found[1] === '/') {
      depth -= 1;
      if (depth === 0) return found.index + found[0].length;
    } else if (!found[0].endsWith('/>')) {
      depth += 1;
    }
  }
}

/** `region` with every SignatureValue/CipherValue's text masked. */
function maskTokenSecrets(region: string): string {
  let out = '';
  let from = 0;
  const secret = new RegExp(TOKEN_SECRET_RE.source, 'g');
  for (;;) {
    secret.lastIndex = from;
    const found = secret.exec(region);
    if (found === null) break;
    const closeTag = `</${found[1] ?? ''}>`;
    const contentStart = found.index + found[0].length;
    const closeAt = region.indexOf(closeTag, contentStart);
    if (closeAt === -1) break;
    out += `${region.slice(from, contentStart)}${REDACTED}${closeTag}`;
    from = closeAt + closeTag.length;
  }
  return out + region.slice(from);
}

/**
 * Masks what makes a security token usable while keeping it readable (spec §3.7, plan amendment
 * 4): the signature and ciphertext inside SAML assertions and proof tokens, and the whole content
 * of a Kerberos `BinarySecurityToken`. X.509 tokens are public and stay.
 */
export function redactSecurityTokens(text: string): string {
  let out = '';
  let from = 0;
  const open = new RegExp(TOKEN_OPEN_RE.source, 'g');
  for (;;) {
    open.lastIndex = from;
    const found = open.exec(text);
    if (found === null) break;
    const tagEnd = text.indexOf('>', found.index);
    if (tagEnd === -1) break;
    const end = closeOf(text, tagEnd + 1, found[1] ?? 'Assertion');
    if (end === -1) break;
    out += text.slice(from, found.index) + maskTokenSecrets(text.slice(found.index, end));
    from = end;
  }
  const masked = out + text.slice(from);
  let result = '';
  let at = 0;
  const bst = new RegExp(KERBEROS_BST_OPEN_RE.source, 'g');
  for (;;) {
    bst.lastIndex = at;
    const found = bst.exec(masked);
    if (found === null) break;
    const closeTag = `</${found[1] ?? ''}>`;
    const contentStart = found.index + found[0].length;
    const closeAt = masked.indexOf(closeTag, contentStart);
    if (closeAt === -1) break;
    result += `${masked.slice(at, contentStart)}${REDACTED}${closeTag}`;
    at = closeAt + closeTag.length;
  }
  return result + masked.slice(at);
}
```

In `redactXml`, change the final `return out + text.slice(from);` to
`return redactSecurityTokens(out + text.slice(from));`.

`closeOf` builds its regex from a fixed name chosen from the `TOKEN_OPEN_RE` capture. That
capture is one of three literals, so there is no injection.

The linear-time test checks the scanner. If the test with 2000 unclosed nested opens is slow,
`closeOf` is rescanning. In that case cap the depth: give up past depth 64 and return -1, which
leaves the text unmasked, the same outcome as an unclosed element.

- [ ] **Step 4: Update the CLI wording**

In `packages/cli/src/mcp/server.ts:28` and `packages/cli/src/ops/redact.ts:107`, extend the
sentence that names the WS-Security password so it also covers:

> SAML token signatures and Kerberos tokens are masked the same way.

Update any test that snapshots the wording; find them with
`grep -rn "WS-Security password" packages/cli/test`.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @wirebench/engine exec vitest run test/unit/redact && pnpm --filter @wirebench/cli exec vitest run test/unit`

Expected: PASS.

- [ ] **Step 6: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 pnpm check
git add packages/engine packages/cli
git commit -m "feat(engine): mask SAML token signatures and Kerberos tokens in logs (#41)"
```

### Task 5: Secret needs and import wording for the new kinds

**Files:**

- Modify:
  - `packages/engine/src/soap/run.ts` `outgoingNeeds` (lines 432–450)
  - `packages/engine/src/soap/legacy-project/map.ts:184`
  - `docs/cli.md`, around lines 277–278
  - `packages/engine/test/helpers/fixtures.ts` (new `projectWithWss`)
- Test: `packages/engine/test/unit/soap/secret-needs-saml.test.ts`

**Interfaces:**

- Consumes: Task 1 types and `keystoreNeeds(project, ref)` from `run/send-helpers.ts`.
- Produces:
  - `outgoingNeeds` lists every reference that a SAML or issued-token entry resolves;
  - `projectWithWss(entries)` returns `{ project, selected }` (used again in Tasks 15 and 18).

- [ ] **Step 1: Write the failing test**

The facet's `secretNeeds` is how the CLI asks; check its name with
`grep -n "secretNeeds" packages/engine/src/soap/run.ts`.

```ts
// packages/engine/test/unit/soap/secret-needs-saml.test.ts
import { describe, expect, it } from 'vitest';
import { soapRun } from '../../../src/soap/run.js';
import { projectWithWss } from '../../helpers/fixtures.js';

describe('secret needs of SAML entries', () => {
  it('lists the STS password and the form signing key password', () => {
    const { project, selected } = projectWithWss([
      {
        kind: 'issued-token',
        stsUrl: 'https://sts.test',
        soapVersion: '1.2',
        trustVersion: '1.3',
        tokenType: '2.0',
        keyType: 'public-key',
        proofKeystoreRef: 'ks-proof',
        credential: { kind: 'username', username: 'alice', passwordRef: 'sec_sts' },
        requestedLifetimeSeconds: 0,
        tlsKeystoreRef: 'ks-tls',
      },
      {
        kind: 'saml-token',
        source: 'form',
        version: '2.0',
        issuer: 'i',
        subject: 's',
        confirmation: 'bearer',
        lifetimeSeconds: 300,
        attributes: [],
        sign: { keystoreRef: 'ks-issuer', keyPasswordRef: 'sec_issuer_key', signatureAlgorithm: 'rsa-sha256' },
      },
    ]);
    const refs = soapRun.secretNeeds!(selected, project).map((need) => need.ref);
    expect(refs).toEqual(expect.arrayContaining(['sec_sts', 'sec_issuer_key']));
  });

  it('lists the certificate credential key password', () => {
    const { project, selected } = projectWithWss([
      {
        kind: 'issued-token',
        stsUrl: 'https://sts.test',
        soapVersion: '1.2',
        trustVersion: '1.3',
        tokenType: '2.0',
        keyType: 'bearer',
        credential: { kind: 'certificate', keystoreRef: 'ks-proof', keyPasswordRef: 'sec_client_key' },
        requestedLifetimeSeconds: 0,
      },
    ]);
    expect(soapRun.secretNeeds!(selected, project).map((need) => need.ref)).toContain('sec_client_key');
  });
});
```

`projectWithWss(entries)` builds a project with:

- one SOAP request whose `wssOutgoingRef` is `w1`;
- an outgoing configuration `w1` with `entries`;
- keystore entries `ks-proof`, `ks-tls` and `ks-issuer` (PEM type, `passwordSecretRef` unset).

Add it beside the existing fixture builders in `test/helpers/fixtures.ts`, and reuse their
project skeleton. The `selected` it returns has the shape `soapRun` takes. Copy how existing
SOAP run tests build one: `grep -rn "SoapSelected\|selectRequests" packages/engine/test/unit/soap | head`.

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @wirebench/engine exec vitest run test/unit/soap/secret-needs-saml.test.ts`

Expected: FAIL, because `sec_sts`, `sec_issuer_key` and `sec_client_key` are missing.

- [ ] **Step 3: Implement**

Add these branches to `outgoingNeeds`:

```ts
    } else if (entry.kind === 'issued-token') {
      const credential = entry.credential;
      if (credential.kind === 'username' && present(credential.passwordRef)) {
        needs.push({ ref: credential.passwordRef, purpose: `STS password for "${credential.username}"` });
      }
      if (credential.kind === 'kerberos' && present(credential.passwordRef)) {
        needs.push({ ref: credential.passwordRef, purpose: `Kerberos password for "${credential.username ?? credential.spn}"` });
      }
      if (credential.kind === 'certificate') {
        needs.push(...keystoreNeeds(project, credential.keystoreRef));
        if (present(credential.keyPasswordRef)) {
          needs.push({ ref: credential.keyPasswordRef, purpose: `STS client certificate key password ("${config.name}")` });
        }
      }
      needs.push(...keystoreNeeds(project, entry.proofKeystoreRef), ...keystoreNeeds(project, entry.tlsKeystoreRef));
    } else if (entry.kind === 'saml-token' && entry.source === 'form') {
      if (entry.sign !== undefined) {
        needs.push(...keystoreNeeds(project, entry.sign.keystoreRef));
        if (present(entry.sign.keyPasswordRef)) {
          needs.push({ ref: entry.sign.keyPasswordRef, purpose: `SAML issuer key password ("${config.name}")` });
        }
      }
      needs.push(...keystoreNeeds(project, entry.proofKeystoreRef));
    }
```

`keystoreNeeds(project, undefined)` must return `[]`. Check its first line in `send-helpers.ts`.
If it does not accept `undefined`, guard each call with `present(...)`.

- [ ] **Step 4: Update the import wording and the CLI docs**

In `soap/legacy-project/map.ts:184`, change the warning text to name what is lost:

> WS-Security configuration "X" was not imported, including any SAML or issued-token entries.

Update the matching test expectation; find it with
`grep -rn "was not imported" packages/engine/test`.

In `docs/cli.md`, extend the WS-Security secrets paragraph with:

- the STS password and the client certificate key password;
- the SAML issuer key password;
- the proof and TLS keystores' passwords.

Each resolves through its ref-derived variable, as WS-Security passwords already do.

- [ ] **Step 5: Run the tests, gate and commit**

```bash
pnpm --filter @wirebench/engine exec vitest run test/unit/soap
WIREBENCH_SKIP_PERF=1 pnpm check
git add packages/engine docs/cli.md
git commit -m "feat(engine): resolve SAML and issued-token secrets in headless runs (#41)"
```

### Task 6: SAML token entries in the desktop editor

**Files:**

- Modify:
  - `apps/desktop/src/shared/wire-types.ts:1393-1446` (`wssEntryWireSchema`)
  - `apps/desktop/src/renderer/features/wss/outgoing-config-editor.tsx` (`NewEntryKind`, `newEntry`,
    `ENTRY_LABEL`, the Add select, `EntryRow`)
  - `apps/desktop/src/renderer/features/wss/outgoing-entry-fields.tsx` (export a shared
    `KeystorePicker`)
- Create: `apps/desktop/src/renderer/features/wss/saml-token-fields.tsx`
- Test: `apps/desktop/test/renderer/wss-saml-token-fields.test.tsx`

**Interfaces:**

- Consumes: `SecretField` (`components/secret-field.js`), `useKeystoreAliases` and
  `WSS_FIELD_CLASS`.
- Produces:
  - the wire kinds `issued-token` and `saml-token`;
  - `SamlTokenFields({ entry, onChange, idPrefix })`;
  - `newSamlFormEntry()`, `newSamlXmlEntry()`;
  - `KeystorePicker({ label, keystoreRef, alias, onChange })`, exported from
    `outgoing-entry-fields.tsx`.

  The issued-token kind is on the wire now, so that projects holding one still load and mirror.
  Its editor is Task 17. Until then `EntryRow` shows a placeholder line for it.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/desktop/test/renderer/wss-saml-token-fields.test.tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SamlTokenFields } from '../../src/renderer/features/wss/saml-token-fields.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import type { WssEntryWire } from '../../src/shared/wire-types.js';

type SamlEntry = Extract<WssEntryWire, { kind: 'saml-token' }>;

const xmlEntry: SamlEntry = { kind: 'saml-token', source: 'xml', xml: '<saml2:Assertion/>', expandProperties: false };
const formEntry: SamlEntry = {
  kind: 'saml-token',
  source: 'form',
  version: '2.0',
  issuer: 'urn:i',
  subject: '',
  confirmation: 'bearer',
  lifetimeSeconds: 300,
  attributes: [],
};

afterEach(cleanup);

describe('SamlTokenFields', () => {
  it('switches from XML to a fresh form entry', () => {
    installWirebenchApi({});
    const onChange = vi.fn();
    render(<SamlTokenFields entry={xmlEntry} onChange={onChange} idPrefix="e0" />);
    fireEvent.click(screen.getByRole('radio', { name: 'Form' }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'form', version: '2.0', confirmation: 'bearer', attributes: [] }),
    );
  });

  it('warns that expanding properties breaks a signed assertion', () => {
    installWirebenchApi({});
    render(<SamlTokenFields entry={{ ...xmlEntry, expandProperties: true }} onChange={vi.fn()} idPrefix="e0" />);
    expect(screen.getByText(/breaks a signed assertion/i)).toBeTruthy();
  });

  it('edits the subject of a form entry', () => {
    installWirebenchApi({});
    const onChange = vi.fn();
    render(<SamlTokenFields entry={formEntry} onChange={onChange} idPrefix="e0" />);
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'alice' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ subject: 'alice' }));
  });

  it('adds an attribute row', () => {
    installWirebenchApi({});
    const onChange = vi.fn();
    render(<SamlTokenFields entry={formEntry} onChange={onChange} idPrefix="e0" />);
    fireEvent.click(screen.getByRole('button', { name: 'Add attribute' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ attributes: [{ name: '', values: [''] }] }));
  });

  it('turns issuer signing on with an empty keystore and RSA-SHA256', () => {
    installWirebenchApi({});
    const onChange = vi.fn();
    render(<SamlTokenFields entry={formEntry} onChange={onChange} idPrefix="e0" />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Sign as issuer' }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ sign: { keystoreRef: '', signatureAlgorithm: 'rsa-sha256' } }),
    );
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @wirebench/desktop exec vitest run test/renderer/wss-saml-token-fields.test.tsx`

Expected: FAIL, because the module cannot be found.

- [ ] **Step 3: Add the wire kinds**

In `wire-types.ts`, extract the X.509 key-identifier values once:

```ts
const X509_KEY_IDENTIFIERS = [
  'BinarySecurityToken',
  'IssuerSerial',
  'SubjectKeyIdentifier',
  'X509KeyIdentifier',
  'Thumbprint',
] as const;
```

Make these changes to the existing kinds:

- Signature object: `keyIdentifierType: z.enum([...X509_KEY_IDENTIFIERS, 'saml-token'])`, and
  its part object gains `token: z.literal(true).optional()`.
- Encryption object: `keyIdentifierType: z.enum(X509_KEY_IDENTIFIERS)`.

Append to `wssEntryWireSchema`'s array:

```ts
  z.object({
    kind: z.literal('issued-token'),
    stsUrl: z.string(),
    soapVersion: z.enum(['1.1', '1.2']),
    trustVersion: z.enum(['1.3', '2005-02']),
    appliesTo: z.string().optional(),
    tokenType: z.enum(['1.1', '2.0']),
    keyType: z.enum(['bearer', 'public-key']),
    proofKeystoreRef: z.string().optional(),
    proofAlias: z.string().optional(),
    credential: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('username'), username: z.string(), passwordRef: z.string().optional() }),
      z.object({
        kind: z.literal('certificate'),
        keystoreRef: z.string(),
        alias: z.string().optional(),
        keyPasswordRef: z.string().optional(),
      }),
      z.object({
        kind: z.literal('kerberos'),
        spn: z.string(),
        principal: z.string().optional(),
        username: z.string().optional(),
        domain: z.string().optional(),
        passwordRef: z.string().optional(),
      }),
    ]),
    requestedLifetimeSeconds: z.number().int().nonnegative(),
    claims: z.string().optional(),
    tlsKeystoreRef: z.string().optional(),
  }),
  /** One object for both SAML sources: the outer union is discriminated by `kind` alone. */
  z.object({
    kind: z.literal('saml-token'),
    source: z.enum(['form', 'xml']),
    version: z.enum(['1.1', '2.0']).optional(),
    issuer: z.string().optional(),
    subject: z.string().optional(),
    subjectFormat: z.string().optional(),
    confirmation: z.enum(['bearer', 'holder-of-key', 'sender-vouches']).optional(),
    audience: z.string().optional(),
    lifetimeSeconds: z.number().int().positive().optional(),
    authnContext: z.string().optional(),
    attributes: z
      .array(z.object({ name: z.string(), nameFormat: z.string().optional(), values: z.array(z.string()) }))
      .optional(),
    sign: z
      .object({
        keystoreRef: z.string(),
        alias: z.string().optional(),
        keyPasswordRef: z.string().optional(),
        signatureAlgorithm: z.enum(['rsa-sha256', 'rsa-sha1']),
      })
      .optional(),
    proofKeystoreRef: z.string().optional(),
    proofAlias: z.string().optional(),
    xml: z.string().optional(),
    file: z.string().optional(),
    expandProperties: z.boolean().optional(),
  }),
```

Check that `grep -n "wssEntryWireSchema\|WssEntryWire" apps/desktop/src/main` shows no per-kind
hand mapping between wire and engine. The main-process mutation writes entries through
`toWssOutgoingRef`, so the engine schema (Task 1) validates what lands in the file. If a per-kind
mapping exists, add both kinds there in this task.

- [ ] **Step 4: Move `KeystorePicker` into the shared fields file**

Add to `outgoing-entry-fields.tsx`:

```tsx
/** A keystore select plus, once one is chosen, its alias select ("Default" = the config's default alias). */
export function KeystorePicker(props: {
  readonly label: string;
  readonly keystoreRef: string | undefined;
  readonly alias: string | undefined;
  readonly onChange: (keystoreRef: string | undefined, alias: string | undefined) => void;
}) {
  const keystores = useProjectStore((state) => state.keystores);
  const aliases = useKeystoreAliases(props.keystoreRef ?? '');
  return (
    <>
      <label className="flex items-center gap-1 text-xs text-fg-subtle">
        <span className="w-24 shrink-0">{props.label}</span>
        <select
          aria-label={props.label}
          className={WSS_FIELD_CLASS}
          value={props.keystoreRef ?? ''}
          onChange={(event) => {
            props.onChange(event.target.value === '' ? undefined : event.target.value, undefined);
          }}
        >
          <option value="">None</option>
          {keystores.map((keystore) => (
            <option key={keystore.id} value={keystore.id}>
              {keystore.name}
            </option>
          ))}
        </select>
      </label>
      {props.keystoreRef !== undefined && (
        <label className="flex items-center gap-1 text-xs text-fg-subtle">
          <span className="w-24 shrink-0">{`${props.label} alias`}</span>
          <select
            aria-label={`${props.label} alias`}
            className={WSS_FIELD_CLASS}
            value={props.alias ?? ''}
            onChange={(event) => {
              props.onChange(props.keystoreRef, event.target.value === '' ? undefined : event.target.value);
            }}
          >
            <option value="">Default</option>
            {aliases.map((alias) => (
              <option key={alias.alias} value={alias.alias}>
                {alias.alias}
              </option>
            ))}
          </select>
        </label>
      )}
    </>
  );
}
```

`state.keystores` items must have `id` and `name`. Check the store's `keystores` element type with
`grep -n "keystores:" apps/desktop/src/renderer/state/project.ts`, and use its field names.

- [ ] **Step 5: Implement the fields**

```tsx
// apps/desktop/src/renderer/features/wss/saml-token-fields.tsx
/**
 * A SAML token entry's fields: Form (build an assertion) or XML (supply one). The assertion
 * itself never crosses to main as anything but this entry: main builds or reads it at send.
 */
import type { ReactNode } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { IconButton } from '../../components/icon-button.js';
import { SecretField } from '../../components/secret-field.js';
import { KeystorePicker, WSS_FIELD_CLASS } from './outgoing-entry-fields.js';
import type { WssEntryWire } from '../../../shared/wire-types.js';

type SamlEntry = Extract<WssEntryWire, { kind: 'saml-token' }>;

interface Props {
  readonly entry: SamlEntry;
  readonly onChange: (entry: SamlEntry) => void;
  /** Unique per entry row: the radio group's `name`. */
  readonly idPrefix: string;
}

/** A fresh form entry: SAML 2.0 bearer, five minutes. */
export function newSamlFormEntry(): SamlEntry {
  return {
    kind: 'saml-token',
    source: 'form',
    version: '2.0',
    issuer: '',
    subject: '',
    confirmation: 'bearer',
    lifetimeSeconds: 300,
    attributes: [],
  };
}

export function newSamlXmlEntry(): SamlEntry {
  return { kind: 'saml-token', source: 'xml', xml: '', expandProperties: false };
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <label className="flex items-center gap-1 text-xs text-fg-subtle">
      <span className="w-24 shrink-0">{label}</span>
      {children}
    </label>
  );
}

type TextKey = 'issuer' | 'subject' | 'subjectFormat' | 'audience' | 'authnContext';

function FormFields({ entry, onChange }: Omit<Props, 'idPrefix'>) {
  const attributes = entry.attributes ?? [];
  const text = (key: TextKey, label: string) => (
    <Row label={label}>
      <input
        aria-label={label}
        className={WSS_FIELD_CLASS}
        value={entry[key] ?? ''}
        onChange={(event) => {
          onChange({ ...entry, [key]: event.target.value });
        }}
      />
    </Row>
  );
  const setAttributes = (next: NonNullable<SamlEntry['attributes']>) => {
    onChange({ ...entry, attributes: next });
  };
  return (
    <>
      <Row label="SAML version">
        <select
          aria-label="SAML version"
          className={WSS_FIELD_CLASS}
          value={entry.version ?? '2.0'}
          onChange={(event) => {
            onChange({ ...entry, version: event.target.value as '1.1' | '2.0' });
          }}
        >
          <option value="2.0">2.0</option>
          <option value="1.1">1.1</option>
        </select>
      </Row>
      {text('issuer', 'Issuer')}
      {text('subject', 'Subject')}
      {text('subjectFormat', 'Subject format')}
      <Row label="Confirmation">
        <select
          aria-label="Confirmation"
          className={WSS_FIELD_CLASS}
          value={entry.confirmation ?? 'bearer'}
          onChange={(event) => {
            onChange({ ...entry, confirmation: event.target.value as 'bearer' | 'holder-of-key' | 'sender-vouches' });
          }}
        >
          <option value="bearer">Bearer</option>
          <option value="holder-of-key">Holder of key</option>
          <option value="sender-vouches">Sender vouches</option>
        </select>
      </Row>
      {entry.confirmation === 'holder-of-key' && (
        <KeystorePicker
          label="Proof keystore"
          keystoreRef={entry.proofKeystoreRef}
          alias={entry.proofAlias}
          onChange={(proofKeystoreRef, proofAlias) => {
            const { proofKeystoreRef: _k, proofAlias: _a, ...rest } = entry;
            onChange({
              ...rest,
              ...(proofKeystoreRef !== undefined ? { proofKeystoreRef } : {}),
              ...(proofAlias !== undefined ? { proofAlias } : {}),
            });
          }}
        />
      )}
      {text('audience', 'Audience')}
      <Row label="Lifetime (s)">
        <input
          aria-label="Lifetime"
          type="number"
          min={1}
          className={WSS_FIELD_CLASS}
          value={entry.lifetimeSeconds ?? 300}
          onChange={(event) => {
            onChange({ ...entry, lifetimeSeconds: Math.max(1, Number(event.target.value) || 1) });
          }}
        />
      </Row>
      {text('authnContext', 'Authentication context')}
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 text-xs text-fg-subtle">Attributes</span>
        <IconButton
          label="Add attribute"
          onClick={() => {
            setAttributes([...attributes, { name: '', values: [''] }]);
          }}
        >
          <Plus size={12} aria-hidden="true" />
        </IconButton>
      </div>
      <ul aria-label="Attributes" className="flex flex-col gap-1">
        {attributes.map((attribute, index) => (
          // Attributes have no ids; the whole list is replaced on each edit, so position is identity.
          <li key={index} className="flex items-center gap-1">
            <input
              aria-label={`Attribute ${String(index + 1)} name`}
              className={WSS_FIELD_CLASS}
              value={attribute.name}
              onChange={(event) => {
                setAttributes(attributes.map((item, at) => (at === index ? { ...item, name: event.target.value } : item)));
              }}
            />
            <input
              aria-label={`Attribute ${String(index + 1)} values`}
              placeholder="value, value"
              className={WSS_FIELD_CLASS}
              value={attribute.values.join(', ')}
              onChange={(event) => {
                const values = event.target.value.split(',').map((value) => value.trim());
                setAttributes(attributes.map((item, at) => (at === index ? { ...item, values } : item)));
              }}
            />
            <IconButton
              label={`Remove attribute ${String(index + 1)}`}
              onClick={() => {
                setAttributes(attributes.filter((_item, at) => at !== index));
              }}
            >
              <Trash2 size={12} aria-hidden="true" />
            </IconButton>
          </li>
        ))}
      </ul>
      <label className="flex items-center gap-1 text-xs text-fg-subtle">
        <input
          type="checkbox"
          aria-label="Sign as issuer"
          checked={entry.sign !== undefined}
          onChange={(event) => {
            const { sign: _dropped, ...rest } = entry;
            onChange(event.target.checked ? { ...rest, sign: { keystoreRef: '', signatureAlgorithm: 'rsa-sha256' } } : rest);
          }}
        />
        Sign as issuer
      </label>
      {entry.sign !== undefined && (
        <>
          <KeystorePicker
            label="Issuer keystore"
            keystoreRef={entry.sign.keystoreRef === '' ? undefined : entry.sign.keystoreRef}
            alias={entry.sign.alias}
            onChange={(keystoreRef, alias) => {
              const { alias: _a, ...sign } = entry.sign!;
              onChange({ ...entry, sign: { ...sign, keystoreRef: keystoreRef ?? '', ...(alias !== undefined ? { alias } : {}) } });
            }}
          />
          <SecretField
            label="Issuer key password"
            value={entry.sign.keyPasswordRef}
            onChange={(ref) => {
              const { keyPasswordRef: _p, ...sign } = entry.sign!;
              onChange({ ...entry, sign: { ...sign, ...(ref !== undefined ? { keyPasswordRef: ref } : {}) } });
            }}
          />
        </>
      )}
    </>
  );
}

function XmlFields({ entry, onChange }: Omit<Props, 'idPrefix'>) {
  const fromFile = entry.file !== undefined;
  return (
    <>
      <Row label="Source">
        <select
          aria-label="XML source"
          className={WSS_FIELD_CLASS}
          value={fromFile ? 'file' : 'inline'}
          onChange={(event) => {
            const { xml: _x, file: _f, ...rest } = entry;
            onChange(event.target.value === 'file' ? { ...rest, file: '' } : { ...rest, xml: '' });
          }}
        >
          <option value="inline">Inline</option>
          <option value="file">Project file</option>
        </select>
      </Row>
      {fromFile ? (
        <Row label="File">
          <input
            aria-label="Assertion file"
            placeholder="tokens/assertion.xml"
            className={WSS_FIELD_CLASS}
            value={entry.file ?? ''}
            onChange={(event) => {
              onChange({ ...entry, file: event.target.value });
            }}
          />
        </Row>
      ) : (
        <textarea
          aria-label="Assertion XML"
          spellCheck={false}
          rows={6}
          className={`${WSS_FIELD_CLASS} font-mono`}
          value={entry.xml ?? ''}
          onChange={(event) => {
            onChange({ ...entry, xml: event.target.value });
          }}
        />
      )}
      <label className="flex items-center gap-1 text-xs text-fg-subtle">
        <input
          type="checkbox"
          checked={entry.expandProperties === true}
          onChange={(event) => {
            onChange({ ...entry, expandProperties: event.target.checked });
          }}
        />
        Expand properties
      </label>
      {entry.expandProperties === true && (
        <p className="text-xs text-fg-subtle">Expanding properties breaks a signed assertion.</p>
      )}
    </>
  );
}

/** The SAML token entry: a Form/XML switch over the two field sets. */
export function SamlTokenFields({ entry, onChange, idPrefix }: Props) {
  return (
    <div className="mt-1 flex flex-col gap-1">
      <div role="radiogroup" aria-label="SAML token source" className="flex gap-2 text-xs text-fg-subtle">
        {(['form', 'xml'] as const).map((source) => (
          <label key={source} className="flex items-center gap-1">
            <input
              type="radio"
              name={`${idPrefix}-saml-source`}
              aria-label={source === 'form' ? 'Form' : 'XML'}
              checked={entry.source === source}
              onChange={() => {
                if (entry.source !== source) onChange(source === 'form' ? newSamlFormEntry() : newSamlXmlEntry());
              }}
            />
            {source === 'form' ? 'Form' : 'XML'}
          </label>
        ))}
      </div>
      {entry.source === 'form' ? <FormFields entry={entry} onChange={onChange} /> : <XmlFields entry={entry} onChange={onChange} />}
    </div>
  );
}
```

If the project has a warning text token (`grep -rn "text-fg-warn\|text-warning" apps/desktop/src/renderer | head -3`),
use it for the expansion warning instead of `text-fg-subtle`.

In `outgoing-config-editor.tsx`:

- `NewEntryKind` gains `'saml-token'`. `newEntry('saml-token')` returns `newSamlFormEntry()`.
- `ENTRY_LABEL` gains `'saml-token': 'SAML Token'` and `'issued-token': 'Issued Token (WS-Trust)'`.
- The Add select gains `<option value="saml-token">SAML Token</option>`. Extend its `kind ===`
  guard to match.
- `EntryRow` gains the two branches below. Task 17 replaces the issued-token placeholder.

```tsx
      {entry.kind === 'saml-token' && <SamlTokenFields entry={entry} onChange={onChange} idPrefix={`e${String(index)}`} />}

      {entry.kind === 'issued-token' && (
        <p className="mt-1 text-xs text-fg-faint">Issued tokens can be edited in a later version.</p>
      )}
```

- [ ] **Step 6: Run the tests, gate and commit**

```bash
pnpm --filter @wirebench/desktop exec vitest run test/renderer/wss-saml-token-fields.test.tsx test/renderer/wss-outgoing-editor.test.tsx
WIREBENCH_SKIP_PERF=1 pnpm check
git add apps/desktop
git commit -m "feat(desktop): edit SAML token entries in outgoing WS-Security (#41)"
```

### Task 7: PR 1 docs, criteria and e2e

**Files:**

- Modify:
  - the WS-Security guide (find it with `ls docs-site/src/content/docs/guides | grep -i secur`);
  - `docs/success-criteria.md` (add `SC-WT4`, `SC-WT5`);
  - `CHANGELOG.md` (`## Unreleased`);
  - `docs/roadmap.md` (the "SAML tokens" line under Authentication).
- Create: `e2e/wss-saml-token.spec.ts`

- [ ] **Step 1: Write the e2e test**

Base it on the existing WS-Security e2e spec. Find it with `ls e2e | grep -i wss`, and copy its
project fixture, launch helper and SOAP stub.

The test:

1. adds an outgoing configuration and a **SAML Token** entry (Form, Issuer `urn:e2e`, Subject `alice`);
2. selects the configuration on the fixture SOAP request;
3. sends to the in-process SOAP stub;
4. opens the HTTP Log row's request tab;
5. asserts that the raw request contains `<saml2:Assertion` and `urn:e2e`.

- [ ] **Step 2: Write the docs**

**WS-Security guide.** Add a "SAML tokens" section covering:

- Form versus XML;
- each form field;
- "Sign as issuer";
- the warning about expanding properties;
- that the assertion goes into the header unchanged;
- that its signature is masked in the HTTP Log unless secrets are shown.

**Success criteria.** Add rows in the table's existing format, citing the spec section and the
proving tests:

| Criterion | Proved by |
| --- | --- |
| **SC-WT4** A form SAML token (1.1 and 2.0), optionally signed as issuer, is placed in `wsse:Security` | `build.test.ts`, `saml-place.test.ts`, `e2e/wss-saml-token.spec.ts` |
| **SC-WT5** A supplied SAML token (inline or project file) is placed unchanged | `saml-place.test.ts` |

**CHANGELOG** under `## Unreleased`, Added:

> SAML tokens in outgoing WS-Security, built from a form (SAML 1.1 or 2.0, optionally signed as
> issuer) or supplied as XML. Token signatures in the HTTP Log are masked.

**Roadmap.** Mark the "SAML tokens" line *shipped with #41 PR 1*.

- [ ] **Step 3: Gate, commit and open PR 1**

```bash
WIREBENCH_SKIP_PERF=1 pnpm check
pnpm test:perf
git add docs docs-site e2e CHANGELOG.md
git commit -m "docs: SAML tokens in WS-Security, criteria and e2e (#41)"
git push -u origin feat/41-saml-tokens
gh pr create --base main --title "feat: SAML tokens in outgoing WS-Security (#41 1/4)" --body-file <(printf '%s\n' "Part 1 of #41: self-issued SAML tokens (form and XML), placement, masking, editor. Spec §3.1–3.2, §3.6, §3.7.")
```

---

# PR 2 — Token references and STR-Transform signing

### Task 8: The `saml-token` key identifier

**Files:**

- Modify:
  - `packages/engine/src/wss/key-identifiers.ts` (`samlTokenReference`)
  - `packages/engine/src/wss/outgoing/signature.ts` (choose the identifier, check the proof key)
- Test: `packages/engine/test/unit/wss/outgoing/signature-saml.test.ts`

**Interfaces:**

- Consumes: `PlacedSamlToken`, `ResolvedSigningKey.placedTokens`,
  `SAML_KEY_IDENTIFIER_VALUE_TYPE`, `SAML_TOKEN_TYPE` and `thumbprintSha1Base64`.
- Produces:
  - `samlTokenReference(token: PlacedSamlToken, options?: { id?: string }): string`, an STR that
    declares its own prefixes;
  - `nearestToken(resolved, signingCertPem): PlacedSamlToken`, file-local in `signature.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/unit/wss/outgoing/signature-saml.test.ts
import { describe, expect, it } from 'vitest';
import { applyOutgoingWss } from '../../../../src/wss/apply.js';
import { verifySignature } from '../../../../src/wss/outgoing/signature.js';
import { createWssContext } from '../../../../src/wss/model.js';
import { generateSigningCert, generateTestCa } from '../../../helpers/test-certs.js';
import type { Keystore } from '../../../../src/keystore/model.js';
import type { WssContext, WssOutgoingConfig, WssSignatureEntry } from '../../../../src/wss/model.js';

const ca = generateTestCa();
const user = generateSigningCert(ca);
const other = generateSigningCert(ca);
const keystore = (cert: { certPem: string; keyPem: string }): Keystore =>
  ({ type: 'pem', aliases: [{ alias: 'me', certPem: cert.certPem, keyPem: cert.keyPem, chainPem: [] }] }) as unknown as Keystore;

const SOAP11 =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><Ping/></soapenv:Body></soapenv:Envelope>';

function signature(overrides: Partial<WssSignatureEntry> = {}): WssSignatureEntry {
  return {
    kind: 'signature',
    keystoreRef: 'user',
    keyIdentifierType: 'saml-token',
    signatureAlgorithm: 'rsa-sha256',
    digestAlgorithm: 'sha256',
    canonicalization: 'exc-c14n',
    useSingleCertificate: true,
    parts: [{ name: 'Body', namespace: 'http://schemas.xmlsoap.org/soap/envelope/', encode: 'Content' }],
    ...overrides,
  };
}

function context(overrides: Partial<WssContext> = {}): WssContext {
  let n = 0;
  return createWssContext({
    keystores: (ref) => Promise.resolve(keystore(ref === 'other' ? other : user)),
    clock: () => new Date('2026-10-05T10:00:00Z'),
    uuid: () => `u${String((n += 1))}`,
    ...overrides,
  });
}

function holderOfKey(proofKeystoreRef: string, signingKeystoreRef: string): WssOutgoingConfig {
  return {
    id: 'w1',
    name: 'HoK',
    mustUnderstand: false,
    entries: [
      {
        kind: 'saml-token',
        source: 'form',
        version: '2.0',
        issuer: 'urn:i',
        subject: 'alice',
        confirmation: 'holder-of-key',
        lifetimeSeconds: 300,
        attributes: [],
        proofKeystoreRef,
      },
      signature({ keystoreRef: signingKeystoreRef }),
    ],
  };
}

describe('the saml-token key identifier', () => {
  it('puts an STR naming the assertion by SAMLID into KeyInfo, and the signature verifies', async () => {
    const xml = await applyOutgoingWss(SOAP11, holderOfKey('user', 'user'), context());
    expect(xml).toMatch(/<ds:KeyInfo>.*<wsse:SecurityTokenReference[^>]*wsse11:TokenType="[^"]*#SAMLV2\.0"/s);
    expect(xml).toMatch(/ValueType="[^"]*#SAMLID"[^>]*>_u\d+<\/wsse:KeyIdentifier>/);
    expect(verifySignature(xml, { certPem: user.certPem }).ok).toBe(true);
  });

  it('refuses a holder-of-key signature made with a key other than the proof key', async () => {
    await expect(applyOutgoingWss(SOAP11, holderOfKey('user', 'other'), context())).rejects.toMatchObject({
      code: 'wss-proof-key-mismatch',
    });
  });

  it('refuses when no SAML entry comes before the signature', async () => {
    await expect(
      applyOutgoingWss(SOAP11, { id: 'w1', name: 'x', mustUnderstand: false, entries: [signature()] }, context()),
    ).rejects.toMatchObject({ code: 'wss-saml-token-missing' });
  });

  it("uses the RSTR's attached reference when the token brought one", async () => {
    const attached =
      '<wsse:SecurityTokenReference xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">' +
      '<wsse:KeyIdentifier ValueType="urn:attached">_given</wsse:KeyIdentifier></wsse:SecurityTokenReference>';
    const ctx = context({
      issuedTokens: {
        get: () =>
          Promise.resolve({
            assertionXml: '<saml2:Assertion xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion" ID="_given"/>',
            assertionId: '_given',
            attachedReferenceXml: attached,
            samlVersion: '2.0',
            keyType: 'bearer',
            stsHost: 'sts.test',
            cacheKey: 'k',
          }),
        peek: () => undefined,
      },
    });
    const xml = await applyOutgoingWss(
      SOAP11,
      {
        id: 'w1',
        name: 'x',
        mustUnderstand: false,
        entries: [
          {
            kind: 'issued-token',
            stsUrl: 'https://sts.test',
            soapVersion: '1.2',
            trustVersion: '1.3',
            tokenType: '2.0',
            keyType: 'bearer',
            credential: { kind: 'username', username: 'a' },
            requestedLifetimeSeconds: 0,
          },
          signature(),
        ],
      },
      ctx,
    );
    expect(xml).toContain('ValueType="urn:attached"');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @wirebench/engine exec vitest run test/unit/wss/outgoing/signature-saml.test.ts`

Expected: FAIL. TypeScript reports that `buildKeyIdentifier`'s switch is not exhaustive, and at
run time there is no KeyInfo.

- [ ] **Step 3: Implement**

In `key-identifiers.ts`, add the code below. Use type-only imports of `PlacedSamlToken` from
`./outgoing/saml.js`, and of the URI constants from `./saml/uris.js`.

```ts
/**
 * A `wsse:SecurityTokenReference` to a SAML token placed earlier in the same header: the RSTR's
 * own attached reference when it gave one, else a `KeyIdentifier` naming the assertion's id
 * (WSS SAML token profile 1.1 §3.4) with the `wsse11:TokenType` that profile requires.
 *
 * @throws WssError `wss-saml-token-missing` for a token with neither (an encrypted assertion
 * whose service sent no reference)
 */
export function samlTokenReference(token: PlacedSamlToken, options: { readonly id?: string } = {}): string {
  if (token.attachedReferenceXml !== undefined) {
    if (options.id === undefined) return token.attachedReferenceXml;
    return token.attachedReferenceXml.replace(
      /^<([\w-]+:)?SecurityTokenReference\b/,
      (open) => `${open} xmlns:wsu="${NS.WSU}" wsu:Id="${options.id}"`,
    );
  }
  if (token.assertionId === undefined) {
    throw new WssError(
      'wss-saml-token-missing',
      'The SAML token has no id to refer to; an encrypted assertion needs the token service to send a reference.',
    );
  }
  const idAttribute = options.id !== undefined ? ` wsu:Id="${options.id}"` : '';
  return (
    `<wsse:SecurityTokenReference xmlns:wsse="${NS.WSSE}" xmlns:wsu="${NS.WSU}" xmlns:wsse11="${NS.WSSE11}"` +
    `${idAttribute} wsse11:TokenType="${SAML_TOKEN_TYPE[token.version]}">` +
    `<wsse:KeyIdentifier ValueType="${SAML_KEY_IDENTIFIER_VALUE_TYPE[token.version]}">${escapeXml(token.assertionId)}</wsse:KeyIdentifier>` +
    `</wsse:SecurityTokenReference>`
  );
}
```

In `buildKeyIdentifier`, add:

```ts
    case 'saml-token':
      // signEnvelope builds this form itself from the placed tokens; it never reaches here.
      throw new WssError('wss-saml-token-missing', 'A SAML token reference needs the token it refers to.');
```

In `signEnvelope`, replace the `const keyIdentifier = buildKeyIdentifier(...)` statement with:

```ts
  const keyIdentifier =
    entry.keyIdentifierType === 'saml-token'
      ? { keyInfoXml: samlTokenReference(nearestToken(resolved, resolved.alias.certPem)) }
      : buildKeyIdentifier(entry.keyIdentifierType, {
          certPem: resolved.alias.certPem,
          chainPem: resolved.alias.chainPem,
          useSingleCertificate: entry.useSingleCertificate,
          tokenId: `X509-${ctx.uuid()}`,
        });
```

Then check that the `if (keyIdentifier.binarySecurityTokenXml !== undefined)` line still compiles.
The object literal has no such property, so TypeScript narrows it as an optional property of the
union, and it does. If TypeScript complains, type the variable as `KeyIdentifier`.

Add this helper above `signEnvelope`:

```ts
/**
 * The SAML token placed most recently before this signature entry.
 *
 * @throws WssError `wss-saml-token-missing` when there is none, `wss-proof-key-mismatch` when a
 * holder-of-key token binds a certificate other than the signing one
 */
function nearestToken(resolved: ResolvedSigningKey, signingCertPem: string): PlacedSamlToken {
  const token = resolved.placedTokens?.at(-1);
  if (token === undefined) {
    throw new WssError('wss-saml-token-missing', 'This signature refers to a SAML token, but no SAML entry comes before it.');
  }
  if (
    token.confirmation === 'holder-of-key' &&
    token.proofCertPem !== undefined &&
    thumbprintSha1Base64(token.proofCertPem) !== thumbprintSha1Base64(signingCertPem)
  ) {
    throw new WssError('wss-proof-key-mismatch', 'A holder-of-key SAML token must be signed with its proof key.');
  }
  return token;
}
```

Import `samlTokenReference` and `thumbprintSha1Base64` from `../key-identifiers.js`.

- [ ] **Step 4: Run the tests, gate and commit**

```bash
pnpm --filter @wirebench/engine exec vitest run test/unit/wss
WIREBENCH_SKIP_PERF=1 pnpm check
git add packages/engine
git commit -m "feat(engine): sign with a SAML token reference in KeyInfo (#41)"
```

### Task 9: The STR-Transform and the `SamlToken` part

**Files:**

- Create: `packages/engine/src/wss/outgoing/str-transform.ts`
- Modify: `packages/engine/src/wss/outgoing/signature.ts` (token part in `signEnvelope`;
  `registerStrTransform` in `signEnvelope` and `verifySignature`)
- Test: `packages/engine/test/unit/wss/outgoing/str-transform.test.ts`

**Interfaces:**

- Consumes: `samlTokenReference` and `nearestToken` (Task 8), and `STR_TRANSFORM`.
- Produces:
  - `StrTransform`, which implements xml-crypto's `CanonicalizationOrTransformationAlgorithm`;
  - `registerStrTransform(signed: SignedXml): void`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/unit/wss/outgoing/str-transform.test.ts
import { describe, expect, it } from 'vitest';
import { applyOutgoingWss } from '../../../../src/wss/apply.js';
import { verifySignature } from '../../../../src/wss/outgoing/signature.js';
import { createWssContext, SAML_TOKEN_PART } from '../../../../src/wss/model.js';
import { generateSigningCert, generateTestCa } from '../../../helpers/test-certs.js';
import type { Keystore } from '../../../../src/keystore/model.js';
import type { WssOutgoingConfig } from '../../../../src/wss/model.js';

const ca = generateTestCa();
const user = generateSigningCert(ca);
const keystore = {
  type: 'pem',
  aliases: [{ alias: 'me', certPem: user.certPem, keyPem: user.keyPem, chainPem: [] }],
} as unknown as Keystore;
const SOAP11 =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><Ping/></soapenv:Body></soapenv:Envelope>';
const ASSERTION =
  '<saml2:Assertion xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a1" Version="2.0" IssueInstant="2026-10-05T10:00:00Z">' +
  '<saml2:Issuer>urn:sts</saml2:Issuer></saml2:Assertion>';

function ctx() {
  let n = 0;
  return createWssContext({
    keystores: () => Promise.resolve(keystore),
    uuid: () => `u${String((n += 1))}`,
    clock: () => new Date('2026-10-05T10:00:00Z'),
  });
}

const senderVouches: WssOutgoingConfig = {
  id: 'w1',
  name: 'SV',
  mustUnderstand: false,
  entries: [
    { kind: 'saml-token', source: 'xml', xml: ASSERTION, expandProperties: false },
    {
      kind: 'signature',
      keystoreRef: 'ks',
      keyIdentifierType: 'BinarySecurityToken',
      signatureAlgorithm: 'rsa-sha256',
      digestAlgorithm: 'sha256',
      canonicalization: 'exc-c14n',
      useSingleCertificate: true,
      parts: [{ name: 'Body', namespace: 'http://schemas.xmlsoap.org/soap/envelope/', encode: 'Content' }, SAML_TOKEN_PART],
    },
  ],
};

describe('the STR-Transform', () => {
  it('covers the assertion through an STR, with TransformationParameters, and verifies', async () => {
    const xml = await applyOutgoingWss(SOAP11, senderVouches, ctx());
    expect(xml).toContain('#STR-Transform"><wsse:TransformationParameters');
    expect(xml).toContain('Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/></wsse:TransformationParameters>');
    expect(xml).not.toMatch(/<saml2:Assertion[^>]*wsu:Id/);
    expect(verifySignature(xml, { certPem: user.certPem }).ok).toBe(true);
  });

  it('fails verification when the assertion is altered after signing', async () => {
    const xml = await applyOutgoingWss(SOAP11, senderVouches, ctx());
    expect(verifySignature(xml.replace('urn:sts', 'urn:evil'), { certPem: user.certPem }).ok).toBe(false);
  });

  it('refuses to dereference when two assertions share the id (wrapping)', async () => {
    const xml = await applyOutgoingWss(SOAP11, senderVouches, ctx());
    const wrapped = xml.replace('<Ping/>', `<Ping>${ASSERTION}</Ping>`);
    expect(verifySignature(wrapped, { certPem: user.certPem }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @wirebench/engine exec vitest run test/unit/wss/outgoing/str-transform.test.ts`

Expected: FAIL with `wss-part-missing`, because there is no element named `SamlToken`.

- [ ] **Step 3: Implement the transform**

```ts
// packages/engine/src/wss/outgoing/str-transform.ts
/**
 * The STR-Transform (WSS SOAP Message Security 1.0 §8.3) for xml-crypto: a reference to a
 * `wsse:SecurityTokenReference` digests the token the STR points at, canonicalised with exc-c14n,
 * instead of the STR itself. That is how a signature covers a SAML assertion without giving the
 * assertion a `wsu:Id`, which would break its issuer's signature.
 *
 * xml-crypto emits `<ds:Transform Algorithm="…"/>` with no children, but the STR-Transform needs
 * `wsse:TransformationParameters`. `registerStrTransform` wraps the instance's `createReferences`:
 * the string it returns is what SignedInfo is built, canonicalised and signed from, so the
 * parameters are inside the signature. Verification ignores the parameters (this transform always
 * applies exc-c14n), as xml-crypto's reference loader ignores a transform's unknown children.
 */
import { ExclusiveCanonicalization } from 'xml-crypto';
import type { SignedXml } from 'xml-crypto';
import type { Element, Node } from '@xmldom/xmldom';
import { NS } from '../../xml/namespaces.js';
import { STR_TRANSFORM } from '../saml/uris.js';

const EXC_C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';

function elementsNamed(root: Node, localName: string): Element[] {
  const found: Element[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === 1 && (node as Element).localName === localName) found.push(node as Element);
    for (let child = node.firstChild; child !== null; child = child.nextSibling) walk(child);
  };
  walk(root);
  return found;
}

/** The id the STR names: a KeyIdentifier's text, or a `wsse:Reference`'s `#id`. */
function referencedId(str: Element): string {
  const identifier = elementsNamed(str, 'KeyIdentifier')[0];
  if (identifier !== undefined) return (identifier.textContent ?? '').trim();
  const uri = elementsNamed(str, 'Reference')[0]?.getAttribute('URI') ?? '';
  if (uri.startsWith('#')) return uri.slice(1);
  throw new Error('The SecurityTokenReference names no token this build can dereference.');
}

/** The one assertion in `doc` whose `ID`/`AssertionID`/`wsu:Id` is `id`; more than one is an attack. */
function dereference(doc: Node, id: string): Element {
  const matches = elementsNamed(doc, 'Assertion').filter(
    (assertion) =>
      assertion.getAttribute('ID') === id ||
      assertion.getAttribute('AssertionID') === id ||
      assertion.getAttributeNS(NS.WSU, 'Id') === id,
  );
  if (matches.length !== 1) {
    throw new Error(`The SecurityTokenReference matches ${String(matches.length)} tokens, not one.`);
  }
  return matches[0]!;
}

export class StrTransform {
  process(node: Node, options: Record<string, unknown>): string {
    const doc = (node as Element).ownerDocument;
    if (doc === null) throw new Error('The SecurityTokenReference is not in a document.');
    const token = dereference(doc, referencedId(node as Element));
    return new ExclusiveCanonicalization().process(token as never, {
      ...options,
      inclusiveNamespacesPrefixList: [],
      ancestorNamespaces: [],
    } as never) as string;
  }

  getAlgorithmName(): string {
    return STR_TRANSFORM;
  }
}

const PARAMETERS =
  `<wsse:TransformationParameters xmlns:wsse="${NS.WSSE}">` +
  `<ds:CanonicalizationMethod xmlns:ds="${NS.DS}" Algorithm="${EXC_C14N}"/></wsse:TransformationParameters>`;

/** Registers {@link StrTransform} on `signed`, and gives every STR-Transform it emits its parameters. */
export function registerStrTransform(signed: SignedXml): void {
  (signed.CanonicalizationAlgorithms as Record<string, unknown>)[STR_TRANSFORM] = StrTransform;
  const target = signed as unknown as { createReferences: (doc: unknown, prefix: string) => string };
  const original = target.createReferences.bind(signed);
  target.createReferences = (doc, prefix) =>
    original(doc, prefix).replaceAll(
      `<${prefix}Transform Algorithm="${STR_TRANSFORM}" />`,
      `<${prefix}Transform Algorithm="${STR_TRANSFORM}">${PARAMETERS}</${prefix}Transform>`,
    );
}
```

**Three traps to check before relying on this:**

1. **The clone.** `getCanonXml` clones the node before calling `process`. A clone keeps its
   `ownerDocument`, so `dereference` searches the live document. The wrapping test proves it.
2. **The prefix.** xml-crypto 6.1.2's `createReferences` writes `${prefix}Transform`. Check
   whether `prefix` already carries its colon (`'ds:'`) by reading
   `node_modules/xml-crypto/lib/signed-xml.js` near line 806.
   - If it does, the replacement above matches.
   - If not, build the literal from `prefix ? `${prefix}:` : ''`.
   - The first test's `toContain('#STR-Transform"><wsse:TransformationParameters')` catches a
     mismatch.
3. **The `ExclusiveCanonicalization` export.** Confirm that xml-crypto exports it, which
   `lib/index.js` does. If its `process` has a different option shape, pass only
   `{ inclusiveNamespacesPrefixList: [] }`.

- [ ] **Step 4: Use the token part in `signEnvelope`, and register in `verifySignature`**

In `signEnvelope`, change the parts loop so token parts become STR references:

```ts
  const references: { readonly id: string; readonly element: Element }[] = [];
  const strReferences: string[] = [];
  for (const part of entry.parts) {
    if (part.token === true) {
      const token = nearestToken(resolved, resolved.alias.certPem);
      const strId = `STR-${ctx.uuid()}`;
      const str = parseXml(samlTokenReference(token, { id: strId }), { location: 'envelope' }).documentElement;
      if (str !== null) security.appendChild(doc.importNode(str, true));
      strReferences.push(strId);
      continue;
    }
    // … the existing resolvePart / wsu:Id code, unchanged …
  }
```

After the existing `for (const { id, element } of references) signer.addReference(...)` loop:

```ts
  if (strReferences.length > 0) registerStrTransform(signer);
  for (const id of strReferences) {
    signer.addReference({
      xpath: `//*[@*[local-name(.)='Id']='${id}']`,
      transforms: [STR_TRANSFORM],
      digestAlgorithm: DIGEST_ALGORITHM_URIS[entry.digestAlgorithm],
    });
  }
```

`nearestToken`'s holder-of-key check also fires for a token part. That is correct: a signature
over a holder-of-key token must use its key.

In `verifySignature`, call `registerStrTransform(verifier)` right after constructing the
verifier. Registering does nothing to a signature that does not use the transform.

Import `registerStrTransform` from `./str-transform.js` and `STR_TRANSFORM` from
`../saml/uris.js`.

- [ ] **Step 5: Run the tests, gate and commit**

```bash
pnpm --filter @wirebench/engine exec vitest run test/unit/wss
WIREBENCH_SKIP_PERF=1 pnpm check
git add packages/engine
git commit -m "feat(engine): cover SAML tokens in signatures with the STR-Transform (#41)"
```

### Task 10: Byte preservation, incoming verification, interop, editor and docs

**Files:**

- Test:
  - `packages/engine/test/unit/wss/outgoing/saml-preservation.test.ts`
  - `packages/engine/test/unit/wss/incoming/verify-str.test.ts`
- Modify:
  - `packages/engine/src/wss/incoming/verify.ts`, only if its sanitising drops STR-Transform
    references (Step 1 says how to tell)
  - `scripts/wss-xmlsec-check.ts` (a form-assertion signature case with `--id-attr:ID`)
  - `apps/desktop/src/renderer/features/wss/outgoing-entry-fields.tsx` (`SignatureFields`, `PartsTable`)
  - the WS-Security guide, `docs/success-criteria.md` (`SC-WT3`) and `CHANGELOG.md`
- Test: `apps/desktop/test/renderer/wss-outgoing-editor.test.tsx` (new cases)

- [ ] **Step 1: Write the byte-preservation and incoming tests**

```ts
// packages/engine/test/unit/wss/outgoing/saml-preservation.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SignedXml } from 'xml-crypto';
import { describe, expect, it } from 'vitest';
import { applyOutgoingWss } from '../../../../src/wss/apply.js';
import { createWssContext, SAML_TOKEN_PART } from '../../../../src/wss/model.js';
import { parseXml } from '../../../../src/xml/parse.js';
import { serializeXml } from '../../../../src/xml/serialize.js';
import { generateSigningCert, generateTestCa } from '../../../helpers/test-certs.js';
import type { Keystore } from '../../../../src/keystore/model.js';

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../../fixtures/saml/${name}`, import.meta.url)), 'utf8');
const issuerCert = fixture('issuer-cert.pem');
const ca = generateTestCa();
const user = generateSigningCert(ca);
const keystore = {
  type: 'pem',
  aliases: [{ alias: 'me', certPem: user.certPem, keyPem: user.keyPem, chainPem: [] }],
} as unknown as Keystore;
const SOAP11 =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><Ping/></soapenv:Body></soapenv:Envelope>';

/** Verifies the assertion's own (issuer) signature as it now sits inside the envelope. */
function issuerSignatureHolds(envelope: string, version: '2.0' | '1.1'): boolean {
  const doc = parseXml(envelope, { location: 'envelope' });
  const namespace = version === '2.0' ? 'urn:oasis:names:tc:SAML:2.0:assertion' : 'urn:oasis:names:tc:SAML:1.0:assertion';
  const assertion = doc.getElementsByTagNameNS(namespace, 'Assertion').item(0)!;
  const signature = assertion.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature').item(0)!;
  const verifier = new SignedXml({
    publicCert: issuerCert,
    idAttributes: [version === '2.0' ? 'ID' : 'AssertionID'],
    getCertFromKeyInfo: () => null,
  });
  verifier.loadSignature(serializeXml(signature));
  return verifier.checkSignature(serializeXml(assertion));
}

describe.each(['2.0', '1.1'] as const)('an STS-signed SAML %s assertion', (version) => {
  it('keeps its issuer signature after placement and a message signature over it', async () => {
    let n = 0;
    const xml = await applyOutgoingWss(
      SOAP11,
      {
        id: 'w1',
        name: 'x',
        mustUnderstand: false,
        entries: [
          { kind: 'saml-token', source: 'xml', xml: fixture(`assertion-${version}.xml`), expandProperties: false },
          {
            kind: 'signature',
            keystoreRef: 'ks',
            keyIdentifierType: 'BinarySecurityToken',
            signatureAlgorithm: 'rsa-sha256',
            digestAlgorithm: 'sha256',
            canonicalization: 'exc-c14n',
            useSingleCertificate: true,
            parts: [{ name: 'Body', namespace: 'http://schemas.xmlsoap.org/soap/envelope/', encode: 'Content' }, SAML_TOKEN_PART],
          },
        ],
      },
      createWssContext({ keystores: () => Promise.resolve(keystore), uuid: () => `u${String((n += 1))}` }),
    );
    expect(issuerSignatureHolds(xml, version)).toBe(true);
  });
});
```

`verify-str.test.ts` calls `verifyIncoming` (export of `wss/incoming/verify.ts`; check its
options with `grep -n "export async function verifyIncoming\|export function verifyIncoming" -A12 packages/engine/src/wss/incoming/verify.ts`).
It runs on the Task 9 sender-vouches envelope, treated as a response, with an incoming
configuration that:

- requires a signature;
- trusts a keystore holding the user certificate.

It asserts:

- the `signature` action passes;
- its references include the STR's id (`STR-…`).

`verifyIncoming` sanitises the XML before calling `verifySignature`, at line 522. If this test
fails while Task 9's `verifySignature` test passes, the sanitising is dropping or rewriting the
STR-Transform reference. Allow the STR-Transform algorithm in whatever transform allow-list it
keeps (`grep -n "Transform\|Algorithm" packages/engine/src/wss/incoming/verify.ts`).

- [ ] **Step 2: Run them**

Run: `pnpm --filter @wirebench/engine exec vitest run test/unit/wss`

Expected: PASS once Tasks 8–9 are right, and with any allow-list fix from Step 1. A preservation
failure is a real defect: fix it in `str-transform.ts` or `signature.ts`, never in the test.

- [ ] **Step 3: Add the xmlsec interop case**

In `scripts/wss-xmlsec-check.ts`, add one case. It builds a signed SAML 2.0 form assertion through
the engine's dist build, then runs:

```text
xmlsec1 --verify --id-attr:ID urn:oasis:names:tc:SAML:2.0:assertion:Assertion --pubkey-cert-pem issuer.pem assertion.xml
```

xmlsec1 has no STR-Transform, so message signatures with a token part are not cross-checked here
(spec §12). Leave a comment saying so.

- [ ] **Step 4: Update the signature editor**

In `SignatureFields`:

- Add `<option value="saml-token">SAML token reference</option>` to the key identifier select.
- Under the parts table, add a checkbox labelled **Cover the SAML token (STR-Transform)**. It adds
  or removes `{ name: 'SamlToken', namespace: '', encode: 'Element', token: true }`.
- `PartsTable` filters `part.token === true` out of the rows it shows, and keeps it in the list it
  writes back.

New cases in `wss-outgoing-editor.test.tsx`:

- picking "SAML token reference" patches `keyIdentifierType: 'saml-token'`;
- ticking the checkbox appends the token part;
- the parts table does not list it.

- [ ] **Step 5: Write the docs**

**WS-Security guide.** Add "Holder-of-key and signing over a token", which explains:

- the SAML token reference key identifier;
- the STR-Transform part;
- that holder-of-key must be signed with the proof key;
- that sender-vouches is a signature by your own key over the body and the token.

**Success criteria:** **SC-WT3**. A holder-of-key or sender-vouches signature refers to the SAML
token, and covers it through the STR-Transform without altering it. Proved by
`signature-saml.test.ts`, `str-transform.test.ts`, `saml-preservation.test.ts` and
`verify-str.test.ts`.

**CHANGELOG:**

> Signatures can refer to a SAML token (holder-of-key) and cover it through the STR-Transform.

- [ ] **Step 6: Gate, commit and open PR 2**

```bash
WIREBENCH_SKIP_PERF=1 pnpm check
pnpm test:perf
git add packages/engine scripts apps/desktop docs docs-site CHANGELOG.md
git commit -m "feat: holder-of-key and STR-Transform signing over SAML tokens (#41)"
git push -u origin feat/41-token-signing
gh pr create --base main --title "feat: sign with and over SAML tokens (#41 2/4)" --body-file <(printf '%s\n' "Part 2 of #41: the saml-token key identifier and the STR-Transform part. xmlsec1 has no STR-Transform, so that interop stays open (spec §12).")
```

---

# PR 3 — WS-Trust client

### Task 11: Build the RST (username and certificate credentials)

**Files:**

- Create: `packages/engine/src/wss/trust/rst.ts`
- Test: `packages/engine/test/unit/wss/trust/rst.test.ts` (+ `__snapshots__`)

**Interfaces:**

- Consumes:
  - `applyOutgoingWss`, with a synthetic config that builds the RST's own security header;
  - `TRUST_URIS`, `SAML_TOKEN_TYPE`, `KERBEROS_AP_REQ_VALUE_TYPE`, `certificateBase64`,
    `WSS_TOKEN_TYPES` and `DEFAULT_WSS_SIGNATURE_PARTS`.
- Produces:
  - `buildRst(entry: WssIssuedTokenEntry, input: RstInput): Promise<BuiltRst>`
  - `RstInput`:
    `{ stsUrl: string; appliesTo: string; claims?: string; ctx: WssContext; proofCertPem?: string; kerberosToken?: Uint8Array }`
  - `BuiltRst`: `{ xml: string; action: string; contentType: string }`

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/unit/wss/trust/rst.test.ts
import { describe, expect, it } from 'vitest';
import { buildRst } from '../../../../src/wss/trust/rst.js';
import { createWssContext } from '../../../../src/wss/model.js';
import { generateSigningCert, generateTestCa } from '../../../helpers/test-certs.js';
import type { Keystore } from '../../../../src/keystore/model.js';
import type { WssIssuedTokenEntry } from '../../../../src/wss/model.js';

const ca = generateTestCa();
const client = generateSigningCert(ca);
const keystore = {
  type: 'pem',
  aliases: [{ alias: 'me', certPem: client.certPem, keyPem: client.keyPem, chainPem: [] }],
} as unknown as Keystore;

function ctx() {
  let n = 0;
  return createWssContext({
    clock: () => new Date('2026-10-05T10:00:00.000Z'),
    uuid: () => `u${String((n += 1))}`,
    nonce: () => new Uint8Array(16),
    secrets: (ref) => Promise.resolve(ref === 'sec_sts' ? 'hunter2' : undefined),
    keystores: () => Promise.resolve(keystore),
  });
}

function entry(overrides: Partial<WssIssuedTokenEntry> = {}): WssIssuedTokenEntry {
  return {
    kind: 'issued-token',
    stsUrl: 'https://sts.test/trust/13/usernamemixed',
    soapVersion: '1.2',
    trustVersion: '1.3',
    tokenType: '2.0',
    keyType: 'bearer',
    credential: { kind: 'username', username: 'alice', passwordRef: 'sec_sts' },
    requestedLifetimeSeconds: 0,
    ...overrides,
  };
}

const input = () => ({ stsUrl: 'https://sts.test/trust/13/usernamemixed', appliesTo: 'https://service.test/', ctx: ctx() });

describe('buildRst', () => {
  it('WS-Trust 1.3, SOAP 1.2, username: WS-A headers, a timestamp, a text password and a bearer RST', async () => {
    const rst = await buildRst(entry(), input());
    expect(rst.action).toBe('http://docs.oasis-open.org/ws-sx/ws-trust/200512/RST/Issue');
    expect(rst.contentType).toBe(
      'application/soap+xml; charset=utf-8; action="http://docs.oasis-open.org/ws-sx/ws-trust/200512/RST/Issue"',
    );
    expect(rst.xml).toContain('<wsa:To');
    expect(rst.xml).toContain('#PasswordText">hunter2</wsse:Password>');
    expect(rst.xml).toContain('<wst:KeyType>http://docs.oasis-open.org/ws-sx/ws-trust/200512/Bearer</wst:KeyType>');
    expect(rst.xml).toContain('<wsa:Address>https://service.test/</wsa:Address>');
    expect(rst.xml).toMatchSnapshot();
  });

  it('WS-Trust 2005/02, SOAP 1.1: the draft namespace and action, text/xml', async () => {
    const rst = await buildRst(entry({ trustVersion: '2005-02', soapVersion: '1.1' }), input());
    expect(rst.action).toBe('http://schemas.xmlsoap.org/ws/2005/02/trust/RST/Issue');
    expect(rst.contentType).toBe('text/xml; charset=utf-8');
    expect(rst.xml).toContain('xmlns:wst="http://schemas.xmlsoap.org/ws/2005/02/trust"');
    expect(rst.xml).toMatchSnapshot();
  });

  it('certificate credential: a BinarySecurityToken and a signature, no username token', async () => {
    const rst = await buildRst(entry({ credential: { kind: 'certificate', keystoreRef: 'ks' } }), input());
    expect(rst.xml).toContain('<wsse:BinarySecurityToken');
    expect(rst.xml).toContain('<ds:Signature');
    expect(rst.xml).not.toContain('<wsse:UsernameToken');
  });

  it('public-key: UseKey carries the proof certificate', async () => {
    const rst = await buildRst(entry({ keyType: 'public-key' }), { ...input(), proofCertPem: client.certPem });
    expect(rst.xml).toContain('/PublicKey</wst:KeyType>');
    expect(rst.xml).toMatch(/<wst:UseKey><wsse:BinarySecurityToken[^>]*X509v3/);
  });

  it('Lifetime and Claims only when set', async () => {
    const plain = await buildRst(entry(), input());
    expect(plain.xml).not.toContain('<wst:Lifetime>');
    const rst = await buildRst(entry({ requestedLifetimeSeconds: 3600 }), {
      ...input(),
      claims: '<wst:Claims Dialect="urn:d"><c/></wst:Claims>',
    });
    expect(rst.xml).toContain('<wsu:Expires>2026-10-05T11:00:00.000Z</wsu:Expires>');
    expect(rst.xml).toContain('<wst:Claims Dialect="urn:d"><c/></wst:Claims>');
  });

  it('refuses a username credential over plain http', async () => {
    await expect(buildRst(entry(), { ...input(), stsUrl: 'http://sts.test/trust' })).rejects.toMatchObject({
      code: 'ws-trust-insecure-transport',
    });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @wirebench/engine exec vitest run test/unit/wss/trust/rst.test.ts`

Expected: FAIL, because `rst.js` does not exist.

- [ ] **Step 3: Implement**

```ts
// packages/engine/src/wss/trust/rst.ts
/**
 * The WS-Trust `RequestSecurityToken` (Issue) an issued-token entry sends: a SOAP envelope with
 * WS-Addressing 1.0 headers, a `wsse:Security` header proving the credential (built by the same
 * builders the message's own header uses), and a `wst:RequestSecurityToken` body.
 */
import { WssError } from '../../errors.js';
import { NS } from '../../xml/namespaces.js';
import { applyOutgoingWss } from '../apply.js';
import { certificateBase64, WSS_TOKEN_TYPES } from '../key-identifiers.js';
import { DEFAULT_WSS_SIGNATURE_PARTS } from '../model.js';
import { KERBEROS_AP_REQ_VALUE_TYPE, SAML_TOKEN_TYPE, TRUST_URIS } from '../saml/uris.js';
import type { WssContext, WssEntry, WssIssuedTokenEntry, WssOutgoingConfig } from '../model.js';

export interface RstInput {
  /** Expanded. */
  readonly stsUrl: string;
  /** Expanded; the request's endpoint when the entry gives none. */
  readonly appliesTo: string;
  /** Expanded. */
  readonly claims?: string;
  readonly ctx: WssContext;
  readonly proofCertPem?: string;
  /** The #40 seam's AP-REQ, for a Kerberos credential (Task 19). */
  readonly kerberosToken?: Uint8Array;
}

export interface BuiltRst {
  readonly xml: string;
  readonly action: string;
  /** The Content-Type header. SOAP 1.2 carries the action in it; SOAP 1.1 uses a SOAPAction header. */
  readonly contentType: string;
}

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function securityEntries(entry: WssIssuedTokenEntry): WssEntry[] {
  const timestamp: WssEntry = { kind: 'timestamp', timeToLiveSeconds: 300, millisecondPrecision: true };
  const credential = entry.credential;
  if (credential.kind === 'username') {
    return [
      timestamp,
      {
        kind: 'username-token',
        username: credential.username,
        ...(credential.passwordRef !== undefined ? { passwordRef: credential.passwordRef } : {}),
        passwordType: 'text',
        addNonce: false,
        addCreated: false,
      },
    ];
  }
  if (credential.kind === 'certificate') {
    return [
      timestamp,
      {
        kind: 'signature',
        keystoreRef: credential.keystoreRef,
        ...(credential.alias !== undefined ? { alias: credential.alias } : {}),
        ...(credential.keyPasswordRef !== undefined ? { keyPasswordRef: credential.keyPasswordRef } : {}),
        keyIdentifierType: 'BinarySecurityToken',
        signatureAlgorithm: 'rsa-sha256',
        digestAlgorithm: 'sha256',
        canonicalization: 'exc-c14n',
        useSingleCertificate: true,
        parts: [...DEFAULT_WSS_SIGNATURE_PARTS],
      },
    ];
  }
  // Kerberos: the AP-REQ goes in as a raw BinarySecurityToken after this Timestamp (buildRst).
  return [timestamp];
}

/**
 * @throws WssError `ws-trust-insecure-transport` for a username credential over `http:`; what the
 * WS-Security builders throw for a missing keystore, alias or secret
 */
export async function buildRst(entry: WssIssuedTokenEntry, input: RstInput): Promise<BuiltRst> {
  if (entry.credential.kind === 'username' && !input.stsUrl.toLowerCase().startsWith('https:')) {
    throw new WssError('ws-trust-insecure-transport', 'A username and password are only sent to a token service over https.', {
      details: { stsUrl: input.stsUrl },
    });
  }
  const trust = TRUST_URIS[entry.trustVersion];
  const envNs = entry.soapVersion === '1.2' ? NS.SOAP12_ENV : NS.SOAP11_ENV;
  const mustUnderstand = entry.soapVersion === '1.2' ? 'true' : '1';
  const ctx = input.ctx;
  const messageId = `urn:uuid:${ctx.uuid()}`;
  const now = ctx.clock();
  const lifetime =
    entry.requestedLifetimeSeconds > 0
      ? `<wst:Lifetime><wsu:Created>${now.toISOString()}</wsu:Created>` +
        `<wsu:Expires>${new Date(now.getTime() + entry.requestedLifetimeSeconds * 1000).toISOString()}</wsu:Expires></wst:Lifetime>`
      : '';
  const useKey =
    entry.keyType === 'public-key' && input.proofCertPem !== undefined
      ? `<wst:UseKey><wsse:BinarySecurityToken ValueType="${WSS_TOKEN_TYPES.X509V3}" EncodingType="${WSS_TOKEN_TYPES.BASE64_BINARY}">` +
        `${certificateBase64(input.proofCertPem)}</wsse:BinarySecurityToken></wst:UseKey>`
      : '';
  const envelope =
    `<s:Envelope xmlns:s="${envNs}" xmlns:wsa="${NS.WSA_200508}" xmlns:wst="${trust.namespace}"` +
    ` xmlns:wsp="${NS.WSP_2004}" xmlns:wsse="${NS.WSSE}" xmlns:wsu="${NS.WSU}">` +
    `<s:Header><wsa:Action s:mustUnderstand="${mustUnderstand}">${trust.issueAction}</wsa:Action>` +
    `<wsa:MessageID>${messageId}</wsa:MessageID>` +
    `<wsa:ReplyTo><wsa:Address>http://www.w3.org/2005/08/addressing/anonymous</wsa:Address></wsa:ReplyTo>` +
    `<wsa:To s:mustUnderstand="${mustUnderstand}">${esc(input.stsUrl)}</wsa:To></s:Header>` +
    `<s:Body><wst:RequestSecurityToken>` +
    `<wst:TokenType>${SAML_TOKEN_TYPE[entry.tokenType]}</wst:TokenType>` +
    `<wst:RequestType>${trust.requestTypeIssue}</wst:RequestType>` +
    `<wsp:AppliesTo><wsa:EndpointReference><wsa:Address>${esc(input.appliesTo)}</wsa:Address></wsa:EndpointReference></wsp:AppliesTo>` +
    `<wst:KeyType>${trust.keyType[entry.keyType]}</wst:KeyType>${useKey}${lifetime}${input.claims ?? ''}` +
    `</wst:RequestSecurityToken></s:Body></s:Envelope>`;
  const config: WssOutgoingConfig = { id: 'rst', name: 'RST', mustUnderstand: true, entries: securityEntries(entry) };
  let xml = await applyOutgoingWss(envelope, config, ctx);
  if (entry.credential.kind === 'kerberos' && input.kerberosToken !== undefined) {
    const token =
      `<wsse:BinarySecurityToken wsu:Id="Kerberos-${ctx.uuid()}" ValueType="${KERBEROS_AP_REQ_VALUE_TYPE}"` +
      ` EncodingType="${WSS_TOKEN_TYPES.BASE64_BINARY}">${Buffer.from(input.kerberosToken).toString('base64')}</wsse:BinarySecurityToken>`;
    xml = xml.replace(/(<\/wsu:Timestamp>)/, `$1${token}`);
  }
  return {
    xml,
    action: trust.issueAction,
    contentType:
      entry.soapVersion === '1.2'
        ? `application/soap+xml; charset=utf-8; action="${trust.issueAction}"`
        : 'text/xml; charset=utf-8',
  };
}
```

Three notes:

- `DEFAULT_WSS_SIGNATURE_PARTS` names the SOAP 1.1 `Body`. `resolvePart` already maps it to the
  SOAP 1.2 namespace, so one list serves both versions.
- A `Claims` block written with a `wst:` prefix only works when the configured `trustVersion`
  matches the prefix's namespace. The guide says so in Task 18.
- `applyOutgoingWss` may write the `wsu:Timestamp` close tag with a different prefix. Read the
  snapshot. If the Kerberos insertion regex misses, anchor it on the first `</` …`Timestamp>` with
  a prefix-agnostic pattern, `/(<\/(?:[\w-]+:)?Timestamp>)/`.

- [ ] **Step 4: Run the tests, review the snapshots, gate and commit**

```bash
pnpm --filter @wirebench/engine exec vitest run test/unit/wss/trust/rst.test.ts
WIREBENCH_SKIP_PERF=1 pnpm check
git add packages/engine
git commit -m "feat(engine): build WS-Trust RequestSecurityToken messages (#41)"
```

Read both snapshots before committing. Each must hold exactly one `wsse:Security` with its
Timestamp first, and no repeated `xmlns` declarations on children.

### Task 12: Parse the RSTR

**Files:**

- Create: `packages/engine/src/wss/trust/rstr.ts`
- Test: `packages/engine/test/unit/wss/trust/rstr.test.ts`
- Fixtures in `packages/engine/test/fixtures/ws-trust/`, all hand-written minimal responses:
  - `rstrc-1.3-saml2.xml`, a SOAP 1.2 envelope holding a `wst:RequestSecurityTokenResponseCollection`
    (1.3 namespace). It contains:
    - one `RequestSecurityTokenResponse` with `wst:Lifetime`, whose `wsu:Expires` is
      `2026-10-05T11:00:00.000Z`;
    - `wst:RequestedSecurityToken`, holding the contents of `test/fixtures/saml/assertion-2.0.xml`;
    - `wst:RequestedAttachedReference`, holding an STR whose KeyIdentifier is `_fixture-2.0`.
  - `rstr-2005-saml11.xml`, a SOAP 1.1 envelope with a single 2005/02
    `RequestSecurityTokenResponse`. It has no lifetime; it holds `assertion-1.1.xml`, edited so
    `Conditions/@NotOnOrAfter="2026-10-05T10:30:00.000Z"`.

    Editing a signed assertion breaks its signature. That is fine here, because only parsing is
    tested.
  - `rstr-none.xml`, like the previous one but with neither `Lifetime` nor `NotOnOrAfter`.
  - `rstr-encrypted.xml`, a 1.3 response whose token is a
    `saml2:EncryptedAssertion` wrapping an `xenc:EncryptedData` with a dummy `CipherValue`.
  - `rstr-proof-token.xml`, `rstrc-1.3-saml2.xml` plus a `wst:RequestedProofToken`.
  - `fault-1.2.xml`, a SOAP 1.2 fault with Code `s:Sender`, Subcode `a:FailedAuthentication`, and
    Reason "ID3242: The security token could not be authenticated or authorized."

**Interfaces:**

- Consumes: `readAssertion` and `parseFault` (`soap/fault.ts`).
- Produces:
  - `parseRstr(body: string, status: number): ParsedRstr`
  - `ParsedRstr`:
    `{ assertionXml: string; assertionId?: string; attachedReferenceXml?: string; samlVersion: SamlVersion; expiresAt?: Date }`

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/unit/wss/trust/rstr.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseRstr } from '../../../../src/wss/trust/rstr.js';
import { readAssertion } from '../../../../src/wss/saml/read.js';

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../../fixtures/ws-trust/${name}`, import.meta.url)), 'utf8');

describe('parseRstr', () => {
  it('reads a WS-Trust 1.3 collection: token, attached reference, lifetime', () => {
    const parsed = parseRstr(fixture('rstrc-1.3-saml2.xml'), 200);
    expect(parsed.samlVersion).toBe('2.0');
    expect(parsed.assertionId).toBe('_fixture-2.0');
    expect(parsed.attachedReferenceXml).toContain('SecurityTokenReference');
    expect(parsed.expiresAt?.toISOString()).toBe('2026-10-05T11:00:00.000Z');
    // self-contained: parses on its own and declares its namespace
    expect(readAssertion(parsed.assertionXml).id).toBe('_fixture-2.0');
  });

  it("falls back to the assertion's NotOnOrAfter in a 2005/02 single response", () => {
    expect(parseRstr(fixture('rstr-2005-saml11.xml'), 200).expiresAt?.toISOString()).toBe('2026-10-05T10:30:00.000Z');
  });

  it('leaves expiresAt unset when neither gives one', () => {
    expect(parseRstr(fixture('rstr-none.xml'), 200).expiresAt).toBeUndefined();
  });

  it('keeps an EncryptedAssertion opaque', () => {
    const parsed = parseRstr(fixture('rstr-encrypted.xml'), 200);
    expect(parsed.assertionXml).toContain('EncryptedAssertion');
    expect(parsed.assertionId).toBeUndefined();
  });

  it('refuses a symmetric proof token', () => {
    expect(() => parseRstr(fixture('rstr-proof-token.xml'), 200)).toThrow(
      expect.objectContaining({ code: 'ws-trust-symmetric-key-unsupported' }),
    );
  });

  it('turns a SOAP fault into ws-trust-sts-fault with code, reason and status', () => {
    expect(() => parseRstr(fixture('fault-1.2.xml'), 500)).toThrow(
      expect.objectContaining({
        code: 'ws-trust-sts-fault',
        details: expect.objectContaining({ status: 500, faultCode: expect.stringContaining('Sender') }),
      }),
    );
  });

  it('refuses a body with no token with ws-trust-response-invalid', () => {
    expect(() =>
      parseRstr('<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body/></s:Envelope>', 200),
    ).toThrow(expect.objectContaining({ code: 'ws-trust-response-invalid' }));
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @wirebench/engine exec vitest run test/unit/wss/trust/rstr.test.ts`

Expected: FAIL, because the module cannot be found.

- [ ] **Step 3: Implement**

```ts
// packages/engine/src/wss/trust/rstr.ts
/**
 * Reads a WS-Trust response (1.3 `RequestSecurityTokenResponseCollection` or a single
 * `RequestSecurityTokenResponse`, either version): the token, its attached reference and its
 * lifetime. The token is serialised on its own, so it carries every namespace it needs.
 */
import type { Element } from '@xmldom/xmldom';
import { WssError } from '../../errors.js';
import { parseXml } from '../../xml/parse.js';
import { serializeXml } from '../../xml/serialize.js';
import { NS } from '../../xml/namespaces.js';
import { parseFault } from '../../soap/fault.js';
import { readAssertion } from '../saml/read.js';
import type { SamlVersion } from '../model.js';

export interface ParsedRstr {
  readonly assertionXml: string;
  readonly assertionId?: string;
  readonly attachedReferenceXml?: string;
  readonly samlVersion: SamlVersion;
  readonly expiresAt?: Date;
}

const TRUST_NAMESPACES: readonly string[] = [NS.WST13, NS.WST2005];

function trustChild(parent: Element, localName: string): Element | undefined {
  for (let node = parent.firstChild; node !== null; node = node.nextSibling) {
    const element = node as Element;
    if (node.nodeType === 1 && element.localName === localName && TRUST_NAMESPACES.includes(element.namespaceURI ?? '')) {
      return element;
    }
  }
  return undefined;
}

function firstTrust(root: Element, localName: string): Element | undefined {
  for (const namespace of TRUST_NAMESPACES) {
    const found = root.getElementsByTagNameNS(namespace, localName).item(0);
    if (found !== null) return found;
  }
  return undefined;
}

function onlyElementChild(parent: Element): Element | undefined {
  let found: Element | undefined;
  for (let node = parent.firstChild; node !== null; node = node.nextSibling) {
    if (node.nodeType === 1) {
      if (found !== undefined) return undefined;
      found = node as Element;
    }
  }
  return found;
}

function invalid(reason: string): WssError {
  return new WssError('ws-trust-response-invalid', `The token service's answer is not a token: ${reason}.`);
}

function dateOf(text: string | null | undefined): Date | undefined {
  if (text === null || text === undefined || text.trim() === '') return undefined;
  const date = new Date(text.trim());
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** @throws WssError `ws-trust-sts-fault` | `ws-trust-response-invalid` | `ws-trust-symmetric-key-unsupported` */
export function parseRstr(body: string, status: number): ParsedRstr {
  let doc;
  try {
    doc = parseXml(body, { location: 'ws-trust' });
  } catch {
    throw new WssError('ws-trust-sts-fault', `The token service answered ${String(status)} with a body that is not XML.`, {
      details: { status },
    });
  }
  const fault = parseFault(doc);
  if (fault !== undefined || status < 200 || status >= 300) {
    throw new WssError(
      'ws-trust-sts-fault',
      fault !== undefined ? `The token service refused: ${fault.reason}` : `The token service answered ${String(status)}.`,
      {
        details: {
          status,
          ...(fault !== undefined ? { faultCode: fault.code, subcodes: fault.subcodes, reason: fault.reason } : {}),
        },
      },
    );
  }
  const root = doc.documentElement;
  if (root === null) throw invalid('it is empty');
  const response = firstTrust(root, 'RequestSecurityTokenResponse');
  if (response === undefined) throw invalid('it has no RequestSecurityTokenResponse');
  if (trustChild(response, 'RequestedProofToken') !== undefined) {
    throw new WssError(
      'ws-trust-symmetric-key-unsupported',
      'The token service issued a symmetric proof key; only bearer and public-key tokens are supported.',
    );
  }
  const requested = trustChild(response, 'RequestedSecurityToken');
  const tokenElement = requested === undefined ? undefined : onlyElementChild(requested);
  if (tokenElement === undefined) throw invalid('RequestedSecurityToken does not hold exactly one token');
  const read = readAssertion(serializeXml(tokenElement));
  const attached = trustChild(response, 'RequestedAttachedReference');
  const attachedStr = attached === undefined ? undefined : onlyElementChild(attached);
  const lifetime = trustChild(response, 'Lifetime');
  const expires = lifetime?.getElementsByTagNameNS(NS.WSU, 'Expires').item(0)?.textContent;
  const conditions = read.element.getElementsByTagNameNS(read.version === '2.0' ? NS.SAML2 : NS.SAML1, 'Conditions').item(0);
  const expiresAt = dateOf(expires) ?? dateOf(conditions?.getAttribute('NotOnOrAfter'));
  return {
    assertionXml: serializeXml(read.element),
    ...(read.id !== undefined ? { assertionId: read.id } : {}),
    ...(attachedStr !== undefined ? { attachedReferenceXml: serializeXml(attachedStr) } : {}),
    samlVersion: read.version,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}
```

**Check the serialiser.** xmldom's `XMLSerializer` must declare an ancestor's namespace on the
serialised child. The first test's `readAssertion(parsed.assertionXml)` proves it.

If it does not, add the missing declarations before serialising: walk the token element's used
prefixes, and `setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:p', uri)` for each one the
element does not declare itself. Do the same for the attached STR.

- [ ] **Step 4: Run the tests, gate and commit**

```bash
pnpm --filter @wirebench/engine exec vitest run test/unit/wss/trust
WIREBENCH_SKIP_PERF=1 pnpm check
git add packages/engine
git commit -m "feat(engine): read WS-Trust responses (#41)"
```

### Task 13: Request a token from an STS

**Files:**

- Create:
  - `packages/engine/src/wss/trust/client.ts`
  - `packages/engine/test/helpers/test-sts-server.ts`
- Test: `packages/engine/test/integration/ws-trust-client.test.ts`

**Interfaces:**

- Consumes: `buildRst`, `parseRstr`, `sendHttp` and `selectAlias`.
- Produces:
  - `requestIssuedToken(entry: WssIssuedTokenEntry, target: IssuedTokenTarget, deps: TrustDeps): Promise<IssuedToken>`.
    The returned token's `cacheKey` is `''`; the source fills it in.
  - `IssuedTokenTarget`:
    `{ endpointUrl: string; expand: (text: string) => string; tls?: TlsOptions; proxy?: (url: string) => Promise<ProxyOptions | undefined>; timeoutMs?: number; signal?: AbortSignal }`
  - `TrustDeps`:
    `{ ctx: WssContext; send?: (request: HttpRequest) => Promise<HttpExchange>; kerberosToken?: KerberosTokenFn; onExchange?: (exchange: HttpExchange) => void }`
  - `KerberosTokenFn`:
    `(spn: string, credentials: { principal?: string; username?: string; domain?: string; password?: string }) => Promise<Uint8Array>`
  - `startTestSts(answer)`, returning `TestSts`

- [ ] **Step 1: Write the test server helper and the failing test**

```ts
// packages/engine/test/helpers/test-sts-server.ts
/** An HTTPS token service for tests: hands each RST to `answer`, records what it was sent. */
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { generateServerCert, generateTestCa } from './test-certs.js';

export interface StsAnswer {
  readonly status: number;
  readonly body: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface TestSts {
  readonly url: string;
  readonly caPem: string;
  readonly requests: { readonly headers: Record<string, string | string[] | undefined>; readonly body: string }[];
  close(): Promise<void>;
}

export async function startTestSts(answer: (body: string) => StsAnswer): Promise<TestSts> {
  const ca = generateTestCa();
  const cert = generateServerCert(ca, ['localhost', '127.0.0.1']);
  const requests: TestSts['requests'] = [];
  const server = createServer({ cert: cert.certPem, key: cert.keyPem }, (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ headers: request.headers, body });
      const reply = answer(body);
      response.writeHead(reply.status, { 'content-type': 'application/soap+xml; charset=utf-8', ...reply.headers });
      response.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `https://127.0.0.1:${String(port)}/trust/13/usernamemixed`,
    caPem: ca.certPem,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
```

Match `generateServerCert`'s real parameters, from `test-certs.ts:131`.

```ts
// packages/engine/test/integration/ws-trust-client.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { requestIssuedToken } from '../../src/wss/trust/client.js';
import { createWssContext } from '../../src/wss/model.js';
import { startTestSts } from '../helpers/test-sts-server.js';
import type { TestSts } from '../helpers/test-sts-server.js';
import type { WssIssuedTokenEntry } from '../../src/wss/model.js';

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../fixtures/ws-trust/${name}`, import.meta.url)), 'utf8');

let sts: TestSts | undefined;
afterEach(async () => {
  await sts?.close();
  sts = undefined;
});

const ctx = createWssContext({ secrets: () => Promise.resolve('hunter2') });

function entry(stsUrl: string): WssIssuedTokenEntry {
  return {
    kind: 'issued-token',
    stsUrl,
    soapVersion: '1.2',
    trustVersion: '1.3',
    tokenType: '2.0',
    keyType: 'bearer',
    credential: { kind: 'username', username: 'alice', passwordRef: 'sec' },
    requestedLifetimeSeconds: 0,
  };
}

describe('requestIssuedToken', () => {
  it('posts the RST and returns the token with its lifetime and host', async () => {
    sts = await startTestSts(() => ({ status: 200, body: fixture('rstrc-1.3-saml2.xml') }));
    const seen: number[] = [];
    const token = await requestIssuedToken(
      entry(sts.url),
      { endpointUrl: 'https://service.test/', expand: (t) => t, tls: { ca: [sts.caPem] } },
      { ctx, onExchange: (exchange) => seen.push(exchange.status) },
    );
    expect(token.assertionId).toBe('_fixture-2.0');
    expect(token.stsHost).toBe('127.0.0.1');
    expect(token.expiresAt?.toISOString()).toBe('2026-10-05T11:00:00.000Z');
    expect(sts.requests[0]?.headers['content-type']).toContain(
      'action="http://docs.oasis-open.org/ws-sx/ws-trust/200512/RST/Issue"',
    );
    expect(sts.requests[0]?.body).toContain('<wsa:Address>https://service.test/</wsa:Address>');
    expect(seen).toEqual([200]);
  });

  it('uses the entry AppliesTo, expanded, over the endpoint', async () => {
    sts = await startTestSts(() => ({ status: 200, body: fixture('rstrc-1.3-saml2.xml') }));
    await requestIssuedToken(
      { ...entry(sts.url), appliesTo: '${realm}' },
      { endpointUrl: 'https://service.test/', expand: (t) => t.replace('${realm}', 'urn:realm'), tls: { ca: [sts.caPem] } },
      { ctx },
    );
    expect(sts.requests[0]?.body).toContain('<wsa:Address>urn:realm</wsa:Address>');
  });

  it('refuses a redirect instead of following it', async () => {
    sts = await startTestSts(() => ({ status: 302, body: '', headers: { location: 'https://elsewhere.test/' } }));
    await expect(
      requestIssuedToken(entry(sts.url), { endpointUrl: 'https://s/', expand: (t) => t, tls: { ca: [sts.caPem] } }, { ctx }),
    ).rejects.toMatchObject({ code: 'ws-trust-sts-fault' });
  });

  it('passes a fault through as ws-trust-sts-fault', async () => {
    sts = await startTestSts(() => ({ status: 500, body: fixture('fault-1.2.xml') }));
    await expect(
      requestIssuedToken(entry(sts.url), { endpointUrl: 'https://s/', expand: (t) => t, tls: { ca: [sts.caPem] } }, { ctx }),
    ).rejects.toMatchObject({ code: 'ws-trust-sts-fault' });
  });

  it('refuses a Kerberos credential with kerberos-unavailable when no seam is lent', async () => {
    await expect(
      requestIssuedToken(
        { ...entry('https://sts.test/'), credential: { kind: 'kerberos', spn: 'HTTP@sts.test' } },
        { endpointUrl: 'https://s/', expand: (t) => t },
        { ctx },
      ),
    ).rejects.toMatchObject({ code: 'kerberos-unavailable' });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @wirebench/engine exec vitest run test/integration/ws-trust-client.test.ts`

Expected: FAIL, because the module cannot be found.

- [ ] **Step 3: Implement**

```ts
// packages/engine/src/wss/trust/client.ts
/**
 * One WS-Trust Issue round trip: build the RST, send it (no redirects — credentials never travel
 * to a second host), read the RSTR. The caller caches; this never does.
 */
import { WssError } from '../../errors.js';
import { sendHttp } from '../../http/client.js';
import { selectAlias } from '../../keystore/index.js';
import { buildRst } from './rst.js';
import { parseRstr } from './rstr.js';
import type { HttpExchange, HttpRequest, ProxyOptions, TlsOptions } from '../../http/types.js';
import type { IssuedToken, WssContext, WssIssuedTokenEntry } from '../model.js';

export interface IssuedTokenTarget {
  /** The request's endpoint: the default AppliesTo. */
  readonly endpointUrl: string;
  readonly expand: (text: string) => string;
  readonly tls?: TlsOptions;
  readonly proxy?: (url: string) => Promise<ProxyOptions | undefined>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export type KerberosTokenFn = (
  spn: string,
  credentials: { readonly principal?: string; readonly username?: string; readonly domain?: string; readonly password?: string },
) => Promise<Uint8Array>;

export interface TrustDeps {
  readonly ctx: WssContext;
  readonly send?: (request: HttpRequest) => Promise<HttpExchange>;
  /** #40's seam, for a Kerberos credential (Task 19). Absent: such a credential refuses. */
  readonly kerberosToken?: KerberosTokenFn;
  /** Told about the exchange with the STS, for the host's log. */
  readonly onExchange?: (exchange: HttpExchange) => void;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** The proof certificate a public-key request sends in `UseKey`; undefined for bearer. */
export async function proofCertOf(entry: WssIssuedTokenEntry, ctx: WssContext): Promise<string | undefined> {
  if (entry.keyType !== 'public-key') return undefined;
  if (entry.proofKeystoreRef === undefined || entry.proofKeystoreRef === '') {
    throw new WssError('wss-proof-key-missing', 'A public-key token needs a proof certificate.');
  }
  const keystore = await ctx.keystores(entry.proofKeystoreRef);
  if (keystore === undefined) {
    throw new WssError('wss-keystore-missing', 'The keystore this entry needs is not available.', {
      details: { keystoreRef: entry.proofKeystoreRef },
    });
  }
  return selectAlias(keystore, entry.proofAlias).certPem;
}

/** @throws WssError `ws-trust-*`, `wss-*`, `kerberos-unavailable`, or the transport's own error */
export async function requestIssuedToken(
  entry: WssIssuedTokenEntry,
  target: IssuedTokenTarget,
  deps: TrustDeps,
): Promise<IssuedToken> {
  const stsUrl = target.expand(entry.stsUrl);
  const appliesTo = entry.appliesTo !== undefined && entry.appliesTo !== '' ? target.expand(entry.appliesTo) : target.endpointUrl;
  const proofCertPem = await proofCertOf(entry, deps.ctx);
  let kerberosToken: Uint8Array | undefined;
  if (entry.credential.kind === 'kerberos') {
    if (deps.kerberosToken === undefined) {
      throw new WssError('kerberos-unavailable', 'Kerberos is not available in this build.');
    }
    const { spn, principal, username, domain, passwordRef } = entry.credential;
    const password = passwordRef === undefined ? undefined : await deps.ctx.secrets(passwordRef);
    kerberosToken = await deps.kerberosToken(spn, {
      ...(principal !== undefined ? { principal } : {}),
      ...(username !== undefined ? { username } : {}),
      ...(domain !== undefined ? { domain } : {}),
      ...(password !== undefined ? { password } : {}),
    });
  }
  const rst = await buildRst(entry, {
    stsUrl,
    appliesTo,
    ...(entry.claims !== undefined ? { claims: target.expand(entry.claims) } : {}),
    ctx: deps.ctx,
    ...(proofCertPem !== undefined ? { proofCertPem } : {}),
    ...(kerberosToken !== undefined ? { kerberosToken } : {}),
  });
  const proxy = await target.proxy?.(stsUrl);
  const send = deps.send ?? sendHttp;
  const exchange = await send({
    url: stsUrl,
    method: 'POST',
    headers: {
      'content-type': rst.contentType,
      ...(entry.soapVersion === '1.1' ? { soapaction: `"${rst.action}"` } : {}),
    },
    body: new TextEncoder().encode(rst.xml),
    timeoutMs: target.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    followRedirects: false,
    ...(target.tls !== undefined ? { tls: target.tls } : {}),
    ...(proxy !== undefined ? { proxy } : {}),
    ...(target.signal !== undefined ? { signal: target.signal } : {}),
  });
  deps.onExchange?.(exchange);
  if (exchange.status >= 300 && exchange.status < 400) {
    throw new WssError(
      'ws-trust-sts-fault',
      `The token service redirected (${String(exchange.status)}); redirects are not followed.`,
      { details: { status: exchange.status } },
    );
  }
  const parsed = parseRstr(new TextDecoder().decode(exchange.body), exchange.status);
  return {
    ...parsed,
    keyType: entry.keyType,
    stsHost: new URL(stsUrl).hostname,
    cacheKey: '',
    ...(proofCertPem !== undefined ? { proofCertPem } : {}),
  };
}
```

`HttpRequest` may name its abort signal differently, and `tls` and `proxy` may be typed
differently. Check with `grep -n "signal\|tls?\|proxy?" packages/engine/src/http/types.ts`, and
match the fields `oauth2-token.ts` passes, since it calls `sendHttp` with TLS and a proxy already.

- [ ] **Step 4: Run the tests, gate and commit**

```bash
pnpm --filter @wirebench/engine exec vitest run test/integration/ws-trust-client.test.ts test/unit/wss/trust
WIREBENCH_SKIP_PERF=1 pnpm check
git add packages/engine
git commit -m "feat(engine): request SAML tokens from a WS-Trust token service (#41)"
```

### Task 14: The issued-token source and cache

**Files:**

- Create: `packages/engine/src/run/issued-token.ts`
- Modify:
  - `packages/engine/src/run/host.ts` (`SendHost.issuedTokens`)
  - `packages/engine/src/index.ts`
  - `test/unit/public-exports.test.ts` and `public-exports.types.ts`
- Test: `packages/engine/test/unit/run/issued-token.test.ts`

**Interfaces:**

- Consumes: `requestIssuedToken`, `IssuedTokenTarget` and `TrustDeps`.
- Produces:
  - `IssuedTokenSource`:
    `{ get(entry, target, deps): Promise<IssuedToken>; peek(entry, target): IssuedToken | undefined; reject(token): void; status(entry, target): IssuedTokenStatus; clear(entry, target): void }`
  - `IssuedTokenStatus`:
    `{ state: 'none' | 'valid' | 'expired'; expiresAt?: string; samlVersion?: SamlVersion; keyType?: IssuedKeyType; stsHost?: string; lastError?: string }`
  - `createIssuedTokenSource(options?: { now?; request?; onSecretValue? }): IssuedTokenSource`
  - `issuedCacheKey(entry, target): string`
  - `ISSUED_TOKEN_REFRESH_MARGIN_MS = 60_000`

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/unit/run/issued-token.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createIssuedTokenSource, issuedCacheKey } from '../../../src/run/issued-token.js';
import { createWssContext } from '../../../src/wss/model.js';
import type { IssuedToken, WssIssuedTokenEntry } from '../../../src/wss/model.js';
import type { IssuedTokenTarget } from '../../../src/wss/trust/client.js';

const entry: WssIssuedTokenEntry = {
  kind: 'issued-token',
  stsUrl: 'https://sts.test/trust',
  soapVersion: '1.2',
  trustVersion: '1.3',
  tokenType: '2.0',
  keyType: 'bearer',
  credential: { kind: 'username', username: 'alice', passwordRef: 'sec' },
  requestedLifetimeSeconds: 0,
};
const target: IssuedTokenTarget = { endpointUrl: 'https://service.test/', expand: (t) => t };
const deps = { ctx: createWssContext() };

function token(expiresAt?: string, id = '_t1'): IssuedToken {
  return {
    assertionXml: `<saml2:Assertion xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}"/>`,
    assertionId: id,
    samlVersion: '2.0',
    keyType: 'bearer',
    stsHost: 'sts.test',
    cacheKey: '',
    ...(expiresAt !== undefined ? { expiresAt: new Date(expiresAt) } : {}),
  };
}

describe('createIssuedTokenSource', () => {
  it('fetches once and reuses the token until it is within a minute of expiry', async () => {
    let now = new Date('2026-10-05T10:00:00Z');
    const request = vi.fn().mockResolvedValue(token('2026-10-05T11:00:00Z'));
    const source = createIssuedTokenSource({ now: () => now, request });
    await source.get(entry, target, deps);
    await source.get(entry, target, deps);
    expect(request).toHaveBeenCalledTimes(1);
    now = new Date('2026-10-05T10:59:30Z');
    await source.get(entry, target, deps);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('shares one STS call between concurrent sends', async () => {
    const request = vi.fn().mockResolvedValue(token('2026-10-05T11:00:00Z'));
    const source = createIssuedTokenSource({ now: () => new Date('2026-10-05T10:00:00Z'), request });
    await Promise.all([source.get(entry, target, deps), source.get(entry, target, deps)]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('never caches a token with no lifetime, and says so in status', async () => {
    const request = vi.fn().mockResolvedValue(token(undefined));
    const source = createIssuedTokenSource({ request });
    await source.get(entry, target, deps);
    await source.get(entry, target, deps);
    expect(request).toHaveBeenCalledTimes(2);
    expect(source.status(entry, target)).toMatchObject({ state: 'none' });
  });

  it('never caches a failure, and keeps its message for status', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error('refused'))
      .mockResolvedValue(token('2026-10-05T11:00:00Z'));
    const source = createIssuedTokenSource({ now: () => new Date('2026-10-05T10:00:00Z'), request });
    await expect(source.get(entry, target, deps)).rejects.toThrow('refused');
    expect(source.status(entry, target).lastError).toBe('refused');
    await source.get(entry, target, deps);
    expect(request).toHaveBeenCalledTimes(2);
    expect(source.status(entry, target).lastError).toBeUndefined();
  });

  it('reject and clear drop the token; peek never fetches', async () => {
    const request = vi.fn().mockResolvedValue(token('2026-10-05T11:00:00Z'));
    const source = createIssuedTokenSource({ now: () => new Date('2026-10-05T10:00:00Z'), request });
    expect(source.peek(entry, target)).toBeUndefined();
    const first = await source.get(entry, target, deps);
    expect(source.peek(entry, target)?.assertionId).toBe('_t1');
    source.reject(first);
    expect(source.peek(entry, target)).toBeUndefined();
    await source.get(entry, target, deps);
    source.clear(entry, target);
    expect(source.status(entry, target).state).toBe('none');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('reports each token to onSecretValue', async () => {
    const seen: string[] = [];
    const source = createIssuedTokenSource({
      request: vi.fn().mockResolvedValue(token('2026-10-05T11:00:00Z')),
      onSecretValue: (value) => seen.push(value),
    });
    await source.get(entry, target, deps);
    expect(seen[0]).toContain('saml2:Assertion');
  });

  it('keys on what identifies a token, and not on a secret', () => {
    const base = issuedCacheKey(entry, target);
    expect(issuedCacheKey({ ...entry, keyType: 'public-key' }, target)).not.toBe(base);
    expect(issuedCacheKey(entry, { ...target, endpointUrl: 'https://other.test/' })).not.toBe(base);
    expect(
      issuedCacheKey({ ...entry, credential: { kind: 'username', username: 'alice', passwordRef: 'other' } }, target),
    ).toBe(base);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @wirebench/engine exec vitest run test/unit/run/issued-token.test.ts`

Expected: FAIL, because the module cannot be found.

- [ ] **Step 3: Implement**

```ts
// packages/engine/src/run/issued-token.ts
/**
 * Issued SAML tokens, cached in memory for their lifetime (owner ruling 3). A run creates one per
 * run; the desktop creates one for the whole session. A token with no lifetime is used once; a
 * failure is never cached; two sends that need the same token share one STS call.
 */
import { createHash } from 'node:crypto';
import { requestIssuedToken } from '../wss/trust/client.js';
import type { IssuedTokenTarget, TrustDeps } from '../wss/trust/client.js';
import type { IssuedKeyType, IssuedToken, SamlVersion, WssIssuedTokenEntry } from '../wss/model.js';

/** A token this close to expiry counts as expired, as OAuth2's `needsRefresh` does. */
export const ISSUED_TOKEN_REFRESH_MARGIN_MS = 60_000;

export interface IssuedTokenStatus {
  readonly state: 'none' | 'valid' | 'expired';
  readonly expiresAt?: string;
  readonly samlVersion?: SamlVersion;
  readonly keyType?: IssuedKeyType;
  readonly stsHost?: string;
  /** The last failure's message for this key, until a fetch succeeds. */
  readonly lastError?: string;
}

export interface IssuedTokenSource {
  get(entry: WssIssuedTokenEntry, target: IssuedTokenTarget, deps: TrustDeps): Promise<IssuedToken>;
  peek(entry: WssIssuedTokenEntry, target: IssuedTokenTarget): IssuedToken | undefined;
  /** Drops `token` after the service refused it. Never re-sends. */
  reject(token: IssuedToken): void;
  status(entry: WssIssuedTokenEntry, target: IssuedTokenTarget): IssuedTokenStatus;
  clear(entry: WssIssuedTokenEntry, target: IssuedTokenTarget): void;
}

export interface IssuedTokenSourceOptions {
  readonly now?: () => Date;
  readonly request?: typeof requestIssuedToken;
  readonly onSecretValue?: (value: string) => void;
}

function credentialIdentity(entry: WssIssuedTokenEntry): string {
  const credential = entry.credential;
  if (credential.kind === 'username') return `u:${credential.username}`;
  if (credential.kind === 'certificate') return `c:${credential.keystoreRef}:${credential.alias ?? ''}`;
  return `k:${credential.spn}:${credential.principal ?? ''}:${credential.username ?? ''}`;
}

/**
 * The key a token is cached under (spec §3.5, plan amendment 8). URLs are expanded, so switching
 * environments gets a different token. No secret goes in; a changed password is what Clear is for.
 */
export function issuedCacheKey(entry: WssIssuedTokenEntry, target: IssuedTokenTarget): string {
  const appliesTo = entry.appliesTo !== undefined && entry.appliesTo !== '' ? target.expand(entry.appliesTo) : target.endpointUrl;
  const identity = [
    target.expand(entry.stsUrl),
    entry.trustVersion,
    entry.soapVersion,
    entry.tokenType,
    entry.keyType,
    appliesTo,
    `${entry.proofKeystoreRef ?? ''}:${entry.proofAlias ?? ''}`,
    credentialIdentity(entry),
    createHash('sha256').update(entry.claims ?? '').digest('hex'),
  ].join('\u0000');
  return createHash('sha256').update(identity).digest('hex').slice(0, 32);
}

export function createIssuedTokenSource(options: IssuedTokenSourceOptions = {}): IssuedTokenSource {
  const now = options.now ?? ((): Date => new Date());
  const request = options.request ?? requestIssuedToken;
  const tokens = new Map<string, IssuedToken>();
  const inFlight = new Map<string, Promise<IssuedToken>>();
  const errors = new Map<string, string>();
  const fresh = (token: IssuedToken | undefined): token is IssuedToken =>
    token?.expiresAt !== undefined && token.expiresAt.getTime() - ISSUED_TOKEN_REFRESH_MARGIN_MS > now().getTime();

  return {
    async get(entry, target, deps) {
      const key = issuedCacheKey(entry, target);
      const cached = tokens.get(key);
      if (fresh(cached)) return cached;
      const pending = inFlight.get(key);
      if (pending !== undefined) return await pending;
      const fetching = (async () => {
        try {
          const fetched = await request(entry, target, deps);
          const token: IssuedToken = { ...fetched, cacheKey: key };
          options.onSecretValue?.(token.assertionXml);
          errors.delete(key);
          if (token.expiresAt !== undefined) tokens.set(key, token);
          else tokens.delete(key);
          return token;
        } catch (error) {
          errors.set(key, error instanceof Error ? error.message : String(error));
          tokens.delete(key);
          throw error;
        } finally {
          inFlight.delete(key);
        }
      })();
      inFlight.set(key, fetching);
      return await fetching;
    },
    peek(entry, target) {
      const cached = tokens.get(issuedCacheKey(entry, target));
      return fresh(cached) ? cached : undefined;
    },
    reject(token) {
      if (tokens.get(token.cacheKey)?.assertionXml === token.assertionXml) tokens.delete(token.cacheKey);
    },
    status(entry, target) {
      const key = issuedCacheKey(entry, target);
      const token = tokens.get(key);
      const lastError = errors.get(key);
      if (token === undefined) return { state: 'none', ...(lastError !== undefined ? { lastError } : {}) };
      return {
        state: fresh(token) ? 'valid' : 'expired',
        ...(token.expiresAt !== undefined ? { expiresAt: token.expiresAt.toISOString() } : {}),
        samlVersion: token.samlVersion,
        keyType: token.keyType,
        stsHost: token.stsHost,
      };
    },
    clear(entry, target) {
      const key = issuedCacheKey(entry, target);
      tokens.delete(key);
      errors.delete(key);
    },
  };
}
```

In `run/host.ts`, add to `SendHost`:

```ts
  /** Issued SAML tokens; a run creates one per run when the host brings none. */
  readonly issuedTokens?: IssuedTokenSource;
```

Export `createIssuedTokenSource`, `issuedCacheKey`, `ISSUED_TOKEN_REFRESH_MARGIN_MS` and
`requestIssuedToken` from `src/index.ts`, along with the types `IssuedTokenSource`,
`IssuedTokenStatus`, `IssuedTokenTarget` and `TrustDeps`. Add them to the public-exports lists.

- [ ] **Step 4: Run the tests, gate and commit**

```bash
pnpm --filter @wirebench/engine exec vitest run test/unit/run/issued-token.test.ts test/unit/public-exports.test.ts
WIREBENCH_SKIP_PERF=1 pnpm check
git add packages/engine
git commit -m "feat(engine): cache issued SAML tokens for their lifetime (#41)"
```

### Task 15: Wire issued tokens into the SOAP send

**Files:**

- Modify:
  - `packages/engine/src/soap/run.ts` (`wssFor` binds `issuedTokens`; post-send drop)
  - `packages/engine/src/soap/types.ts` (`SoapSendWss.issuedUsed`)
  - `packages/engine/src/run/send-helpers.ts` (`issuedTokenSourceOf`, `dropRejectedIssuedToken`)
  - the run entry point that creates a run's shared OAuth2 source, so it also creates a shared
    issued-token source (Step 3 says how to find it)
- Test: `packages/engine/test/integration/ws-trust-send.test.ts`

**Interfaces:**

- Consumes: Task 14's source, `tlsFor(context, keystoreId, trustInvalid)`,
  `context.host.proxyFor`, `expandOrRefuse` (Task 2) and `projectWithWss` (Task 5).
- Produces:
  - `issuedTokenSourceOf(context: RunContext): IssuedTokenSource`
  - `dropRejectedIssuedToken(context: RunContext, used: readonly IssuedToken[], fault: SoapFault | undefined): void`
  - `SoapSendWss.issuedUsed?: IssuedToken[]`

- [ ] **Step 1: Write the failing test**

Model this test on the closest existing run integration test with an OAuth2 client-credentials
token, which has the same per-run cache behaviour. Find it with
`grep -rln "client-credentials" packages/engine/test/integration`, and copy its setup, its
`runRequests` (or `createRunSender`) call and its host. Then swap the OAuth2 owner auth for
`projectWithWss([...])`, with these changes:

- the endpoint is the SOAP test server's URL;
- the issued-token entry's `stsUrl` is the test STS URL;
- the host's `tls.anchors` include `sts.caPem`.

Use the SOAP test server (`packages/engine/test/helpers/test-soap-server.ts`; check its API with
`grep -n "export" packages/engine/test/helpers/test-soap-server.ts`). It needs to record request
bodies, and to answer a SOAP fault with code `wsse:InvalidSecurityToken` when asked.

The test asserts four things:

1. The service received `<saml2:Assertion` with `ID="_fixture-2.0"` inside `wsse:Security`.
2. Two requests in one run make **one** STS call (`sts.requests.length === 1`).
3. A second run makes a new STS call, because each run gets its own source.
4. After the service answers `wsse:InvalidSecurityToken`, the next request in the same run makes
   a new STS call.

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @wirebench/engine exec vitest run test/integration/ws-trust-send.test.ts`

Expected: FAIL with `ws-trust-unavailable`.

- [ ] **Step 3: Implement**

**Share one source per run.** Find where a run creates its shared OAuth2 token source
(`grep -rn "createRunTokenSource" packages/engine/src/run`). Create
`createIssuedTokenSource({ onSecretValue: host.onSecretValue })` beside it, and pass it as
`host.issuedTokens` in the same way, unless the caller's host already brings one.

In `run/send-helpers.ts`:

```ts
/** The run's shared issued-token source, or a fresh one for a send outside a run. */
export function issuedTokenSourceOf(context: RunContext): IssuedTokenSource {
  return (
    context.host.issuedTokens ??
    createIssuedTokenSource(context.host.onSecretValue !== undefined ? { onSecretValue: context.host.onSecretValue } : {})
  );
}

/** WS-Security fault codes that mean a token was refused (spec §3.5). */
const TOKEN_REFUSED = /(?:^|:)(?:InvalidSecurityToken|FailedAuthentication|SecurityTokenUnavailable|MessageExpired)$/;

/** Drops the issued tokens a refused send carried, so the next send fetches anew. Never re-sends. */
export function dropRejectedIssuedToken(
  context: RunContext,
  used: readonly IssuedToken[],
  fault: SoapFault | undefined,
): void {
  if (fault === undefined || used.length === 0) return;
  if (![fault.code, ...fault.subcodes].some((code) => TOKEN_REFUSED.test(code))) return;
  const source = issuedTokenSourceOf(context);
  for (const token of used) source.reject(token);
}
```

In `soap/run.ts` `wssFor(selected, context, scopes, endpointUrl)`:

```ts
  const used: IssuedToken[] = [];
  const source = issuedTokenSourceOf(context);
  const expandText = (text: string) => expandOrRefuse(text, scopes, 'WS-Security issued token');
  const targetFor = async (entry: WssIssuedTokenEntry): Promise<IssuedTokenTarget> => {
    const tls = await tlsFor(context, entry.tlsKeystoreRef, false);
    return {
      endpointUrl,
      expand: expandText,
      ...(tls !== undefined ? { tls } : {}),
      ...(context.host.proxyFor !== undefined ? { proxy: context.host.proxyFor } : {}),
      ...(context.timeoutMs !== undefined ? { timeoutMs: context.timeoutMs } : {}),
      ...(context.signal !== undefined ? { signal: context.signal } : {}),
    };
  };
  const base = createWssContext({
    keystores: (ref) => keystoreFor(context, ref),
    secrets: (ref) => requiredSecret(ref, context.host.getSecret),
    expand: (text) => expandOrRefuse(text, scopes, 'WS-Security SAML token'),
    projectFile: /* unchanged from Task 2 */,
  });
  const ctx = createWssContext({
    ...base,
    issuedTokens: {
      get: async (entry) => {
        const token = await source.get(entry, await targetFor(entry), { ctx: base });
        used.push(token);
        return token;
      },
      peek: (entry) => source.peek(entry, { endpointUrl, expand: expandText }),
    },
  });
```

Return `ctx` as the `SoapSendWss.ctx`, and `issuedUsed: used` alongside it. `SoapSendWss` (in
`soap/types.ts`) gains `readonly issuedUsed?: IssuedToken[];`.

The `projectFile` comment in the snippet above means: keep the Task 2 implementation, but move it
into `base`.

`tlsFor`'s third argument is `trustInvalid`. The STS is never trusted blindly, so pass `false`;
`context.insecure` still applies inside `tlsFor`.

After the send in `sendSoapItem` (next to `dropRefusedToken`, around line 563):

```ts
  dropRejectedIssuedToken(context, connected.wss?.issuedUsed ?? [], exchange.response?.fault);
```

Check which field of `SoapExchange` holds the parsed `SoapFault`
(`grep -n "fault" packages/engine/src/soap/types.ts`), and use it.

- [ ] **Step 4: Run the tests, gate and commit**

```bash
pnpm --filter @wirebench/engine exec vitest run test/integration/ws-trust-send.test.ts test/unit/soap test/unit/run
WIREBENCH_SKIP_PERF=1 pnpm check
git add packages/engine
git commit -m "feat(engine): send SOAP requests with STS-issued SAML tokens (#41)"
```

### Task 16: Desktop main — session cache, log rows, IPC, preview

**Files:**

- Create:
  - `apps/desktop/src/main/issued-tokens.ts`
  - `apps/desktop/src/main/ipc/issued-tokens.ts`
- Modify:
  - `apps/desktop/src/main/index.ts`: create the service next to `oauth2Service` (line 179), pass
    it into the send deps (lines 565 and 593), and register the channels
  - `apps/desktop/src/main/send/host.ts` (`DesktopSendDeps.issuedTokens`, `SendHost.issuedTokens`,
    `reportStsExchange`)
  - `apps/desktop/src/main/engine-wire.ts` (export `toHttpExchangeWire`)
  - `apps/desktop/src/main/project-host.ts` (`issuedTokenTarget`; `previewOutgoingWss`, line 2244,
    peeks only)
  - `apps/desktop/src/shared/ipc.ts` (`issuedTokens` channels)
  - `apps/desktop/src/shared/wire-types.ts` (locator and status schemas;
    `exchangeSummarySchema.auxiliary` and `.causedBy`)
- Test:
  - `apps/desktop/test/main/issued-tokens.test.ts`
  - `apps/desktop/test/main/send-host-sts-row.test.ts`

**Interfaces:**

- Consumes: `createIssuedTokenSource`, `IssuedTokenSource`, `TrustDeps.onExchange`,
  `toHttpExchangeWire` and `recordSecretValue`.
- Produces:
  - `IssuedTokensService`, with `source`, `status(locator, show)`, `fetch(locator, show)` and
    `clear(locator, show)`;
  - IPC channels `issuedTokens.status`, `issuedTokens.fetch` and `issuedTokens.clear`;
  - `ProjectHost.issuedTokenTarget(projectId, configId, entryIndex, requestId?)`;
  - the STS log row.

- [ ] **Step 1: Write the failing tests**

Model both tests on the desktop OAuth2 tests (`ls apps/desktop/test/main | grep -i oauth`), and
copy their dependency stubs.

`issued-tokens.test.ts` builds an `IssuedTokensService` with a stub `resolve`, which returns a
fixed entry, target and deps. Its `source` is replaced through a test-only constructor parameter
whose `request` returns a token expiring in an hour. It asserts that:

1. `status` returns `none`, then `valid` after `fetch`, then `none` after `clear`;
2. `status` carries `assertion` only when `showSecrets` is `true`;
3. a `fetch` whose request rejects returns `state: 'none'` with that `lastError`.

`send-host-sts-row.test.ts` builds the desktop send host (as the existing send-host tests do,
`ls apps/desktop/test/main | grep -i send-host`) with an `onExchange` spy, an `IssuedTokensService`
whose source's `request` calls `deps.onExchange?.(fakeExchange)` and resolves a token. It calls
`host.issuedTokens!.get(entry, target, { ctx })` and asserts:

- exactly one `LogEntryWire` was emitted;
- `entry.exchange.auxiliary === 'sts'`;
- `entry.exchange.causedBy === <the send's sendId>`;
- with show-secrets off, a `ds:SignatureValue` inside an assertion in `fakeExchange`'s body comes
  out as `REDACTED`.

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm --filter @wirebench/desktop exec vitest run test/main/issued-tokens.test.ts test/main/send-host-sts-row.test.ts`

Expected: FAIL, because the modules cannot be found.

- [ ] **Step 3: Implement the service, the target lookup and the IPC**

```ts
// apps/desktop/src/main/issued-tokens.ts
/**
 * The session's issued-token cache (spec §4.1, plan amendment 5): one engine source for the whole
 * app, never persisted, plus what IPC needs to show and clear it for the entry being edited.
 */
import { createIssuedTokenSource } from '@wirebench/engine';
import type { IssuedTokenSource, IssuedTokenStatus, IssuedTokenTarget, TrustDeps, WssIssuedTokenEntry } from '@wirebench/engine';
import { recordSecretValue } from './redact.js';

export interface IssuedTokenLocator {
  readonly projectId: string;
  readonly configId: string;
  readonly entryIndex: number;
  readonly requestId?: string;
}

export interface ResolvedIssuedToken {
  readonly entry: WssIssuedTokenEntry;
  readonly target: IssuedTokenTarget;
  readonly deps: TrustDeps;
}

export type IssuedTokenStatusWire = IssuedTokenStatus & { readonly assertion?: string };

export class IssuedTokensService {
  constructor(
    private readonly resolve: (locator: IssuedTokenLocator) => Promise<ResolvedIssuedToken>,
    readonly source: IssuedTokenSource = createIssuedTokenSource({ onSecretValue: recordSecretValue }),
  ) {}

  async status(locator: IssuedTokenLocator, showSecrets: boolean): Promise<IssuedTokenStatusWire> {
    const { entry, target } = await this.resolve(locator);
    const status = this.source.status(entry, target);
    const token = showSecrets ? this.source.peek(entry, target) : undefined;
    return { ...status, ...(token !== undefined ? { assertion: token.assertionXml } : {}) };
  }

  async fetch(locator: IssuedTokenLocator, showSecrets: boolean): Promise<IssuedTokenStatusWire> {
    const { entry, target, deps } = await this.resolve(locator);
    this.source.clear(entry, target);
    try {
      await this.source.get(entry, target, deps);
    } catch {
      // Kept as status.lastError, which the panel shows.
    }
    return await this.status(locator, showSecrets);
  }

  async clear(locator: IssuedTokenLocator, showSecrets: boolean): Promise<IssuedTokenStatusWire> {
    const { entry, target } = await this.resolve(locator);
    this.source.clear(entry, target);
    return await this.status(locator, showSecrets);
  }
}
```

`ProjectHost.issuedTokenTarget(projectId, configId, entryIndex, requestId?)` returns
`ResolvedIssuedToken`. It:

1. finds the outgoing configuration, and checks that `entries[entryIndex]` is an issued-token
   entry;
2. picks the request: `requestId`, or else the first SOAP request whose `wssOutgoingRef` is
   `configId`. With none, it throws `WirebenchError('ws-trust-no-request', 'Select this configuration on a request first.')`.
3. builds the same target a send would:
   - endpoint URL and scopes, the way `previewOutgoingWss` resolves them;
   - TLS from `entry.tlsKeystoreRef` through the project's keystore loader;
   - proxy from the app's proxy resolver;
4. builds `deps.ctx` with the keystore and secret capabilities that `wssContext()` (line 2076)
   builds.

If the endpoint and scope resolution exist only inside the engine's `resolveSoap`, export a narrow
engine helper `soapEndpointAndScopes(selected, context)` from `soap/run.ts` in this task, and add
it to the public-exports lists.

Channels in `shared/ipc.ts`, next to `oauth2`:

```ts
  issuedTokens: {
    status: defineChannel('issuedTokens.status', issuedTokenLocatorSchema, issuedTokenStatusSchema),
    fetch: defineChannel('issuedTokens.fetch', issuedTokenLocatorSchema, issuedTokenStatusSchema),
    clear: defineChannel('issuedTokens.clear', issuedTokenLocatorSchema, issuedTokenStatusSchema),
  },
```

In `wire-types.ts`:

```ts
export const issuedTokenLocatorSchema = z.object({
  projectId: z.string(),
  configId: z.string(),
  entryIndex: z.number().int().nonnegative(),
  requestId: z.string().optional(),
});
export const issuedTokenStatusSchema = z.object({
  state: z.enum(['none', 'valid', 'expired']),
  expiresAt: z.string().optional(),
  samlVersion: z.enum(['1.1', '2.0']).optional(),
  keyType: z.enum(['bearer', 'public-key']).optional(),
  stsHost: z.string().optional(),
  lastError: z.string().optional(),
  /** Only with show-secrets on. */
  assertion: z.string().optional(),
});
export type IssuedTokenStatusWire = z.infer<typeof issuedTokenStatusSchema>;
```

Add to `exchangeSummarySchema`:

```ts
  /** Set on a row that is not the send itself: `sts` is the token request a send made first. */
  auxiliary: z.literal('sts').optional(),
  /** The `sendId` of the send this auxiliary row belongs to. */
  causedBy: z.string().optional(),
```

`ipc/issued-tokens.ts` registers the three handlers with `registerHandler`, reading show-secrets
the way `ipc/oauth2.ts` does (`grep -n "showSecrets" apps/desktop/src/main/ipc/oauth2.ts`).

- [ ] **Step 4: Log STS exchanges from the send host, and make preview peek-only**

In `send/host.ts`, add `readonly issuedTokens?: IssuedTokensService;` to `DesktopSendDeps`. In the
`SendHost` it builds, add `...(issued !== undefined ? { issuedTokens: issued } : {})`, where:

```ts
function issuedTokensFor(deps: DesktopSendDeps, send: DesktopSend): IssuedTokenSource | undefined {
  const source = deps.issuedTokens?.source;
  if (source === undefined) return undefined;
  return {
    get: (entry, target, trustDeps) =>
      source.get(entry, target, {
        ...trustDeps,
        onExchange: (exchange) => {
          trustDeps.onExchange?.(exchange);
          reportStsExchange(deps, send, exchange);
        },
      }),
    peek: (entry, target) => source.peek(entry, target),
    reject: (token) => {
      source.reject(token);
    },
    status: (entry, target) => source.status(entry, target),
    clear: (entry, target) => {
      source.clear(entry, target);
    },
  };
}

/** The STS exchange as its own HTTP Log row (never History), redacted like any SOAP row. */
function reportStsExchange(deps: DesktopSendDeps, send: DesktopSend, http: HttpExchange): void {
  if (deps.onExchange === undefined) return;
  const entry: LogEntryWire = {
    kind: 'exchange',
    ...(send.requestId !== undefined ? { requestId: send.requestId } : {}),
    exchange: {
      sendId: `${send.sendId}:sts:${String(Date.now())}`,
      durationMs: http.timings?.totalMs ?? 0,
      http: toHttpExchangeWire(http, { show: deps.showSecrets?.get() ?? false }),
      problems: [],
      auxiliary: 'sts',
      causedBy: send.sendId,
    },
  };
  try {
    deps.onExchange(entry);
  } catch {
    // A broadcast that fails never affects the send, as reportWsHandshake's own catch.
  }
}
```

Check the duration field on `HttpExchange` (`grep -n "timings\|durationMs" packages/engine/src/http/types.ts`),
and use what is there in place of `timings?.totalMs`.

Export `toHttpExchangeWire` from `main/engine-wire.ts`, and confirm that it runs `redactXml` over
SOAP bodies (`grep -n "redactXml" apps/desktop/src/main/engine-wire.ts`). If it does, Task 4's
masking covers the STS row. If it does not, apply `redactXml` to the response body text in
`reportStsExchange`.

In `index.ts`, construct the service as follows, and pass `issuedTokens` next to each
`oauth2: oauth2Service`:

```ts
const issuedTokensService = new IssuedTokensService((locator) =>
  projectHost.issuedTokenTarget(locator.projectId, locator.configId, locator.entryIndex, locator.requestId),
);
```

Register the IPC channels.

**Preview.** In `project-host.ts`'s `previewOutgoingWss`, before calling `applyOutgoingWss`, map
the configuration so that each issued-token entry becomes one of two things:

- When `issuedTokensService.source.peek(entry, target)` hits, an XML entry
  `{ kind: 'saml-token', source: 'xml', xml: token.assertionXml, expandProperties: false }`.
- Otherwise, an XML entry whose `xml` is
  `<saml2:Assertion xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion" ID="_preview"><!-- issued token: fetched from <host> at send --></saml2:Assertion>`,
  where `<host>` is the hostname of the expanded `stsUrl`.

So preview never contacts the STS (spec §4.1). The preview then runs through the normal
redaction, so a cached assertion's signature is masked unless show-secrets is on.

- [ ] **Step 5: Run the tests, gate and commit**

```bash
pnpm --filter @wirebench/desktop exec vitest run test/main
WIREBENCH_SKIP_PERF=1 pnpm check
git add apps/desktop packages/engine
git commit -m "feat(desktop): session token cache, STS log rows and token status IPC (#41)"
```

### Task 17: Desktop renderer — issued-token editor and status

**Files:**

- Create:
  - `apps/desktop/src/renderer/features/wss/issued-token-fields.tsx`
  - `apps/desktop/src/renderer/features/wss/issued-token-status.tsx`
- Modify:
  - `outgoing-config-editor.tsx` (Add option, `newEntry`, `EntryRow` replaces the Task 6
    placeholder, project and config ids passed down)
  - `renderer/features/console/log-name.ts` (`STS · ` prefix)
  - `apps/desktop/test/mocks/wirebench-api.ts` (the `issuedTokens` namespace)
- Test:
  - `apps/desktop/test/renderer/wss-issued-token-fields.test.tsx`
  - `apps/desktop/test/renderer/log-name-sts.test.ts`

**Interfaces:**

- Consumes:
  - `ipc.issuedTokens.*` through `state/ipc-client.js` (check how `oauth2-status.tsx` calls
    `ipc.oauth2.status`);
  - `KeystorePicker`, `SecretField` and `WSS_FIELD_CLASS`.
- Produces:
  - `IssuedTokenFields({ entry, onChange, projectId, configId, entryIndex })`
  - `IssuedTokenStatus({ projectId, configId, entryIndex })`

- [ ] **Step 1: Write the failing tests**

**`wss-issued-token-fields.test.tsx`.** Render `IssuedTokenFields` with a fresh issued-token
entry. Mock the channels with
`installWirebenchApi({ issuedTokens: { status: vi.fn().mockResolvedValue({ state: 'none' }), fetch: vi.fn().mockResolvedValue({ state: 'valid', expiresAt: '2026-10-05T14:32:00.000Z', samlVersion: '2.0', keyType: 'bearer' }), clear: vi.fn() } })`.

It asserts that:

1. changing **Credential** to Certificate emits `credential: { kind: 'certificate', keystoreRef: '' }`;
2. **Key type** Public key reveals the "Proof keystore" picker;
3. **Credential** Kerberos shows "Needs Kerberos support (#40)" while Kerberos is unavailable
   (the mock reports no Kerberos capability);
4. the status panel shows "No token cached" after mount;
5. clicking **Fetch now** calls `issuedTokens.fetch` with `{ projectId, configId, entryIndex }`,
   then shows "Valid until".

**`log-name-sts.test.ts`.** For
`{ kind: 'exchange', requestId: 'r1', exchange: { ..., auxiliary: 'sts' } }` with
`requests: { r1: { name: 'GetQuote' } }`, `nameOf` returns `STS · GetQuote`.

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm --filter @wirebench/desktop exec vitest run test/renderer/wss-issued-token-fields.test.tsx test/renderer/log-name-sts.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement the fields**

`issued-token-fields.tsx` has the following structure. Every control follows the `Row` and
`WSS_FIELD_CLASS` conventions of Task 6, and every `onChange` spreads `entry` and replaces one
field.

```tsx
// apps/desktop/src/renderer/features/wss/issued-token-fields.tsx
/**
 * An issued-token entry's fields (spec §4.2): the token service, the token asked for, and the
 * credential that proves who is asking — followed by the cached token's status.
 */
import type { ReactNode } from 'react';
import { SecretField } from '../../components/secret-field.js';
import { useKerberosAvailable } from '../../state/capabilities.js';
import { KeystorePicker, WSS_FIELD_CLASS } from './outgoing-entry-fields.js';
import { IssuedTokenStatus } from './issued-token-status.js';
import type { WssEntryWire } from '../../../shared/wire-types.js';

type IssuedEntry = Extract<WssEntryWire, { kind: 'issued-token' }>;
type Credential = IssuedEntry['credential'];

interface Props {
  readonly entry: IssuedEntry;
  readonly onChange: (entry: IssuedEntry) => void;
  readonly projectId: string;
  readonly configId: string;
  readonly entryIndex: number;
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <label className="flex items-center gap-1 text-xs text-fg-subtle">
      <span className="w-24 shrink-0">{label}</span>
      {children}
    </label>
  );
}

function Group({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-xs font-medium tracking-wider text-fg-subtle uppercase">{title}</legend>
      {children}
    </fieldset>
  );
}

function freshCredential(kind: Credential['kind']): Credential {
  if (kind === 'certificate') return { kind, keystoreRef: '' };
  if (kind === 'kerberos') return { kind, spn: '' };
  return { kind: 'username', username: '' };
}

export function IssuedTokenFields({ entry, onChange, projectId, configId, entryIndex }: Props) {
  const kerberos = useKerberosAvailable();
  const set = <K extends keyof IssuedEntry>(key: K, value: IssuedEntry[K]) => {
    onChange({ ...entry, [key]: value });
  };
  const credential = entry.credential;
  return (
    <div className="mt-1 flex flex-col gap-2">
      <Group title="Token service">
        <Row label="URL">
          <input aria-label="STS URL" className={WSS_FIELD_CLASS} value={entry.stsUrl} onChange={(e) => { set('stsUrl', e.target.value); }} />
        </Row>
        <Row label="SOAP version">
          <select aria-label="STS SOAP version" className={WSS_FIELD_CLASS} value={entry.soapVersion} onChange={(e) => { set('soapVersion', e.target.value as '1.1' | '1.2'); }}>
            <option value="1.2">1.2</option>
            <option value="1.1">1.1</option>
          </select>
        </Row>
        <Row label="WS-Trust">
          <select aria-label="WS-Trust version" className={WSS_FIELD_CLASS} value={entry.trustVersion} onChange={(e) => { set('trustVersion', e.target.value as '1.3' | '2005-02'); }}>
            <option value="1.3">1.3</option>
            <option value="2005-02">February 2005</option>
          </select>
        </Row>
        <Row label="Applies to">
          <input aria-label="Applies to" placeholder="the request's endpoint" className={WSS_FIELD_CLASS} value={entry.appliesTo ?? ''} onChange={(e) => { set('appliesTo', e.target.value === '' ? undefined : e.target.value); }} />
        </Row>
        <KeystorePicker label="Mutual TLS keystore" keystoreRef={entry.tlsKeystoreRef} alias={undefined} onChange={(ref) => { set('tlsKeystoreRef', ref); }} />
      </Group>
      <Group title="Token">
        <Row label="SAML version">
          <select aria-label="Token SAML version" className={WSS_FIELD_CLASS} value={entry.tokenType} onChange={(e) => { set('tokenType', e.target.value as '1.1' | '2.0'); }}>
            <option value="2.0">2.0</option>
            <option value="1.1">1.1</option>
          </select>
        </Row>
        <Row label="Key type">
          <select aria-label="Key type" className={WSS_FIELD_CLASS} value={entry.keyType} onChange={(e) => { set('keyType', e.target.value as 'bearer' | 'public-key'); }}>
            <option value="bearer">Bearer</option>
            <option value="public-key">Public key</option>
          </select>
        </Row>
        {entry.keyType === 'public-key' && (
          <KeystorePicker
            label="Proof keystore"
            keystoreRef={entry.proofKeystoreRef}
            alias={entry.proofAlias}
            onChange={(proofKeystoreRef, proofAlias) => {
              onChange({ ...entry, proofKeystoreRef, proofAlias });
            }}
          />
        )}
        <Row label="Lifetime (s)">
          <input aria-label="Requested lifetime" type="number" min={0} className={WSS_FIELD_CLASS} value={entry.requestedLifetimeSeconds} onChange={(e) => { set('requestedLifetimeSeconds', Math.max(0, Number(e.target.value) || 0)); }} />
        </Row>
        <textarea aria-label="Claims" placeholder="<wst:Claims …/>" rows={3} spellCheck={false} className={`${WSS_FIELD_CLASS} font-mono`} value={entry.claims ?? ''} onChange={(e) => { set('claims', e.target.value === '' ? undefined : e.target.value); }} />
      </Group>
      <Group title="Credential">
        <Row label="Credential">
          <select aria-label="Credential" className={WSS_FIELD_CLASS} value={credential.kind} onChange={(e) => { set('credential', freshCredential(e.target.value as Credential['kind'])); }}>
            <option value="username">Username</option>
            <option value="certificate">Certificate</option>
            <option value="kerberos">Kerberos</option>
          </select>
        </Row>
        {credential.kind === 'username' && (
          <>
            <Row label="Username">
              <input aria-label="STS username" className={WSS_FIELD_CLASS} value={credential.username} onChange={(e) => { set('credential', { ...credential, username: e.target.value }); }} />
            </Row>
            <SecretField label="STS password" value={credential.passwordRef} onChange={(ref) => { set('credential', { ...credential, passwordRef: ref }); }} />
          </>
        )}
        {credential.kind === 'certificate' && (
          <>
            <KeystorePicker label="Client certificate" keystoreRef={credential.keystoreRef === '' ? undefined : credential.keystoreRef} alias={credential.alias} onChange={(ref, alias) => { set('credential', { ...credential, keystoreRef: ref ?? '', alias }); }} />
            <SecretField label="Key password" value={credential.keyPasswordRef} onChange={(ref) => { set('credential', { ...credential, keyPasswordRef: ref }); }} />
          </>
        )}
        {credential.kind === 'kerberos' && (
          <>
            {!kerberos.available && <p className="text-xs text-fg-faint">Needs Kerberos support (#40).</p>}
            <Row label="SPN">
              <input aria-label="Service principal" placeholder="HTTP@sts.corp" className={WSS_FIELD_CLASS} value={credential.spn} onChange={(e) => { set('credential', { ...credential, spn: e.target.value }); }} />
            </Row>
            <Row label="Principal">
              <input aria-label="Principal" className={WSS_FIELD_CLASS} value={credential.principal ?? ''} onChange={(e) => { set('credential', { ...credential, principal: e.target.value === '' ? undefined : e.target.value }); }} />
            </Row>
            {kerberos.explicitCredentials && (
              <>
                <Row label="Username">
                  <input aria-label="Kerberos username" className={WSS_FIELD_CLASS} value={credential.username ?? ''} onChange={(e) => { set('credential', { ...credential, username: e.target.value === '' ? undefined : e.target.value }); }} />
                </Row>
                <Row label="Domain">
                  <input aria-label="Kerberos domain" className={WSS_FIELD_CLASS} value={credential.domain ?? ''} onChange={(e) => { set('credential', { ...credential, domain: e.target.value === '' ? undefined : e.target.value }); }} />
                </Row>
                <SecretField label="Kerberos password" value={credential.passwordRef} onChange={(ref) => { set('credential', { ...credential, passwordRef: ref }); }} />
              </>
            )}
          </>
        )}
      </Group>
      <IssuedTokenStatus projectId={projectId} configId={configId} entryIndex={entryIndex} />
    </div>
  );
}
```

`exactOptionalPropertyTypes` will reject assigning `undefined` to optional fields. Where the
snippet does that (`appliesTo`, `claims`, the keystore refs, `principal`, `passwordRef`, and so
on), drop the key instead, with the destructure-and-omit pattern `UsernameTokenFields` uses
(`const { passwordRef: dropped, ...rest } = entry`). Write a small local helper:

```ts
function withOptional<T extends object, K extends keyof T>(value: T, key: K, next: T[K] | undefined): T {
  const { [key]: _dropped, ...rest } = value;
  return (next === undefined ? rest : { ...rest, [key]: next }) as T;
}
```

Use it for every optional field.

**`useKerberosAvailable()`** is a new hook in `renderer/state/capabilities.ts`. It returns
`{ available: boolean; explicitCredentials: boolean }`. Until Task 19 it returns
`{ available: false, explicitCredentials: window.wirebench.platform === 'win32' }`. Check the
renderer's existing platform accessor
(`grep -rn "platform" apps/desktop/src/renderer/state apps/desktop/src/preload | head`) and use it.

**`issued-token-status.tsx`** copies `rest-editor/oauth2-status.tsx`'s `OAuth2StatusPanel`
(line 55): its layout, loading state, error style and refresh behaviour. It calls
`ipc.issuedTokens.status/fetch/clear` with `{ projectId, configId, entryIndex }`, and renders:

- `Valid until 14:32 · SAML 2.0 · bearer`, the time formatted with
  `toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })`;
- or `Expired`, or `No token cached`;
- `lastError`, in the error style, followed by "See the STS row in the HTTP Log.";
- **Fetch now** and **Clear** buttons.

It re-reads status whenever `OAuth2StatusPanel` re-reads its own.

**`outgoing-config-editor.tsx`:**

- `newEntry('issued-token')` returns the entry below.
- The Add select gains `<option value="issued-token">Issued Token (WS-Trust)</option>` before SAML
  Token, and its guard is extended to match.
- `EntryRow` renders `IssuedTokenFields`. Pass `projectId` (the configuration row's `projectId`)
  and `configId` down from `OutgoingConfigEditor`, and pass `index` as `entryIndex`.

```ts
    return {
      kind: 'issued-token',
      stsUrl: '',
      soapVersion: '1.2',
      trustVersion: '1.3',
      tokenType: '2.0',
      keyType: 'bearer',
      credential: { kind: 'username', username: '' },
      requestedLifetimeSeconds: 0,
    };
```

**`log-name.ts`.** At the end of `nameOf`, prefix the result:

```ts
const isSts = entry.kind === 'exchange' && 'auxiliary' in entry.exchange && entry.exchange.auxiliary === 'sts';
return isSts ? `STS · ${name}` : name;
```

Restructure the function so that it computes `name` and returns once.

- [ ] **Step 4: Run the tests, gate and commit**

```bash
pnpm --filter @wirebench/desktop exec vitest run test/renderer
WIREBENCH_SKIP_PERF=1 pnpm check
git add apps/desktop
git commit -m "feat(desktop): edit issued-token entries and see the cached token (#41)"
```

### Task 18: CLI verbose line, docs, criteria, e2e and PR 3

**Files:**

- Modify:
  - `packages/cli/src/ops/send.ts` (verbose STS line)
  - `docs/cli.md`
  - `docs/success-criteria.md` (`SC-WT1`, `SC-WT2`, `SC-WT6` pending)
  - `CHANGELOG.md`
  - `docs/roadmap.md` (item 7: WS-Trust shipped, Kerberos credential pending #40)
- Create:
  - `docs-site/src/content/docs/guides/ws-trust.mdx`, plus its sidebar entry (find the sidebar
    config with `grep -rln "ws-security" docs-site/astro.config.* docs-site/src`)
  - `e2e/ws-trust.spec.ts`
- Test: `packages/cli/test/unit/ops/send-sts-verbose.test.ts`

- [ ] **Step 1: Write the failing CLI test**

Model it on the nearest `send --verbose` test (`grep -rln "verbose" packages/cli/test/unit/ops`).
Use the test STS and SOAP servers and `projectWithWss` from the engine's test helpers. Check that
the CLI tests can import them (`grep -rn "engine/test/helpers" packages/cli/test | head -2`); if
not, copy the STS helper into `packages/cli/test/helpers/`.

The test sends the same request twice in one command with `--verbose`, and asserts that stderr
contains:

```text
/^STS 127\.0\.0\.1 200 fetched, valid until \d{2}:\d{2}$/m
/^STS 127\.0\.0\.1 cached, valid until \d{2}:\d{2}$/m
```

- [ ] **Step 2: Implement**

In `ops/send.ts`, give the host `issuedTokens: verboseIssuedTokens(createIssuedTokenSource({ onSecretValue }), log)`
when `--verbose` is set, and the plain source otherwise. `verboseIssuedTokens` wraps `get`:

```ts
function verboseIssuedTokens(source: IssuedTokenSource, log: (line: string) => void): IssuedTokenSource {
  const time = (date: Date | undefined) =>
    date === undefined ? 'single use' : `valid until ${date.toISOString().slice(11, 16)}`;
  return {
    ...source,
    get: async (entry, target, deps) => {
      let status: number | undefined;
      const token = await source.get(entry, target, {
        ...deps,
        onExchange: (exchange) => {
          status = exchange.status;
          deps.onExchange?.(exchange);
        },
      });
      log(
        status === undefined
          ? `STS ${token.stsHost} cached, ${time(token.expiresAt)}`
          : `STS ${token.stsHost} ${String(status)} fetched, ${time(token.expiresAt)}`,
      );
      return token;
    },
  };
}
```

Write the line with whatever the existing verbose output uses for stderr. The time is UTC, which
matches the CLI's other timestamps; check one with `grep -n "toISOString" packages/cli/src/ops/send.ts`.

- [ ] **Step 3: Write the docs**

**`ws-trust.mdx`.** It covers:

- what a token service does;
- adding an Issued Token entry;
- each credential, with the common endpoint shapes `…/trust/13/usernamemixed`,
  `…/trust/13/certificatemixed` and `…/trust/13/windowstransport`, described neutrally;
- bearer versus public key, and holder-of-key signing (linking to the WS-Security guide's
  section);
- that a `Claims` block's prefix must match the chosen WS-Trust version;
- the cache, status, Fetch now and Clear;
- what the STS row in the HTTP Log shows and masks;
- running it headless: per-run cache, secrets from env, `--verbose`.

**Success criteria:**

- **SC-WT1** An issued token is fetched with a username over https, cached for its lifetime, and
  reused across sends. Proved by `ws-trust-client.test.ts`, `issued-token.test.ts`,
  `ws-trust-send.test.ts` and `e2e/ws-trust.spec.ts`.
- **SC-WT2** The certificate credential signs the RST. Proved by `rst.test.ts`. Add a certificate
  case to `ws-trust-send.test.ts` in this task.
- **SC-WT6** The Kerberos credential, *pending #40*.

**CHANGELOG:**

> WS-Trust: request SAML tokens from a security token service with a username or a client
> certificate, cached for their lifetime; each token request shows in the HTTP Log.

- [ ] **Step 4: Write the e2e test**

`e2e/ws-trust.spec.ts` starts an STS from the e2e side. Check whether the e2e helpers can import
engine test helpers (`grep -rn "test/helpers" e2e | head -3`); if not, add a small STS to
`e2e/helpers/` that serves `rstrc-1.3-saml2.xml`.

Trust its CA through the same mechanism the existing TLS e2e uses.

The test:

1. adds an Issued Token entry pointing at the STS;
2. sends twice;
3. asserts one HTTP Log row named `STS · <request name>`;
4. asserts that the status says "Valid until";
5. clicks **Clear**, sends again, and asserts a second STS row.

- [ ] **Step 5: Gate, commit and open PR 3**

```bash
WIREBENCH_SKIP_PERF=1 pnpm check
pnpm test:perf
git add packages docs docs-site e2e CHANGELOG.md
git commit -m "docs: WS-Trust guide, criteria, CLI verbose line and e2e (#41)"
git push -u origin feat/41-ws-trust
gh pr create --base main --title "feat: WS-Trust issued SAML tokens (#41 3/4)" --body-file <(printf '%s\n' "Part 3 of #41: the WS-Trust client (username and certificate), per-run and session caches, STS rows in the HTTP Log, the issued-token editor. Ticks the request and cache boxes on #41.")
```

---

# PR 4 — Kerberos credential (after #40's PR 1)

### Task 19: Kerberos to the STS through #40's seam

**Precondition:** #40's PR 1 is merged, and
`packages/engine/src/http/auth/kerberos-token.ts` exports `kerberosToken(spn, credentials, opts?)`
(#40 spec §D1). Read that file first. If the signature differs from §D1, follow the code and say
so in the PR.

**Files:**

- Modify:
  - `packages/engine/src/soap/run.ts` (`wssFor`'s `get` passes `kerberosToken` into `TrustDeps`)
  - `packages/engine/src/run/host.ts`: if #40 adds a Kerberos provider to `SendHost`, pass it
    through; otherwise call the seam with its defaults.
  - `apps/desktop/src/renderer/state/capabilities.ts` (`useKerberosAvailable` reads #40's
    capability)
  - the `ws-trust.mdx` guide, `docs/success-criteria.md` (`SC-WT6` proved), `CHANGELOG.md` and
    `docs/roadmap.md`
- Test:
  - `packages/engine/test/unit/wss/trust/rst-kerberos.test.ts`
  - #40's Kerberos integration job: add an RST case

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/unit/wss/trust/rst-kerberos.test.ts
import { describe, expect, it } from 'vitest';
import { buildRst } from '../../../../src/wss/trust/rst.js';
import { createWssContext } from '../../../../src/wss/model.js';

describe('the Kerberos credential', () => {
  it('puts the AP-REQ into a GSS_Kerberosv5_AP_REQ BinarySecurityToken after the Timestamp', async () => {
    const rst = await buildRst(
      {
        kind: 'issued-token',
        stsUrl: 'https://sts.corp/trust/13/windowstransport',
        soapVersion: '1.2',
        trustVersion: '1.3',
        tokenType: '2.0',
        keyType: 'bearer',
        credential: { kind: 'kerberos', spn: 'HTTP@sts.corp' },
        requestedLifetimeSeconds: 0,
      },
      {
        stsUrl: 'https://sts.corp/trust/13/windowstransport',
        appliesTo: 'https://service.corp/',
        ctx: createWssContext({ uuid: () => 'k1' }),
        kerberosToken: new Uint8Array([1, 2, 3]),
      },
    );
    expect(rst.xml).toMatch(/#GSS_Kerberosv5_AP_REQ"[^>]*>AQID<\/wsse:BinarySecurityToken>/);
    expect(rst.xml.indexOf('Timestamp')).toBeLessThan(rst.xml.indexOf('GSS_Kerberosv5_AP_REQ'));
  });
});
```

Run: `pnpm --filter @wirebench/engine exec vitest run test/unit/wss/trust/rst-kerberos.test.ts`

Expected: PASS if Task 11's insertion is right, in which case this test pins it. If it fails,
fix the insertion in `rst.ts`.

The behavioural failing test for this task is in #40's integration job. It sends an RST with a
Kerberos credential through `requestIssuedToken`, with
`deps.kerberosToken = (spn, c) => kerberosToken(spn, c)`, to a test STS that hands the
BinarySecurityToken bytes to #40's `KerberosServer` and answers `rstrc-1.3-saml2.xml` when they
verify. Before wiring, it fails with `kerberos-unavailable`.

- [ ] **Step 2: Wire the seam**

In `soap/run.ts`'s `wssFor`, the `get` call passes:

```ts
{ ctx: base, kerberosToken: (spn, credentials) => kerberosToken(spn, credentials, kerberosOptionsOf(context)) }
```

Here `kerberosToken` is imported from `../http/auth/kerberos-token.js`, and `kerberosOptionsOf`
returns whatever provider or platform options #40's SPNEGO path passes; mirror its call site.
Its `kerberos-*` errors pass through unchanged.

`useKerberosAvailable` reads the availability capability #40 exposes to the renderer (find it
with `grep -rn "kerberos" apps/desktop/src/shared/ipc.ts apps/desktop/src/preload`). It keeps
`explicitCredentials` as Windows-only.

- [ ] **Step 3: Docs, gate, commit and open PR 4**

- **Guide:** add the Kerberos credential: the ambient ticket, the Windows-only explicit
  credentials, and the SPN forms (`host/sts.corp`, `HTTP@sts.corp`, a bare host).
- **Success criteria:** **SC-WT6** proved by `rst-kerberos.test.ts` and the integration case.
- **CHANGELOG:**

  > WS-Trust: Kerberos as a credential for the token service.

- **Roadmap:** item 7 done for #41.

```bash
WIREBENCH_SKIP_PERF=1 pnpm check
pnpm test:perf
git add packages apps docs docs-site CHANGELOG.md
git commit -m "feat: Kerberos credential for WS-Trust token requests (#41)"
git push -u origin feat/41-kerberos-sts
gh pr create --base main --title "feat: Kerberos to the token service (#41 4/4)" --body-file <(printf '%s\n' "Part 4 of #41: Kerberos as the token-service credential, through #40's kerberosToken seam. Closes #41.")
```

---

## Spec coverage check

| Spec | Tasks |
| --- | --- |
| §1 user stories | Username to a `usernamemixed` endpoint: 13, 15, 17, 18. Certificate: 11, 15, 18. Holder-of-key: 8, 9, 15. Form: 3. XML: 2. CI per-run cache: 14, 15, 18 |
| §2 decisions 1–4 | 1 (kerberos kind), 13 (unavailable), 19; 8, 9 and 12 (symmetric refused); 14, 16; 2, 3 |
| §2 decisions 5–10 | 1; 2, 15, 16 (preview peeks); 1, 11; 16; 15; 2, 9, 10 (amendment 3) |
| §3.1 model | 1 |
| §3.2 format, secret needs, legacy text | 1, 5 |
| §3.3 RST, RSTR, failures, transport | 11, 12, 13 |
| §3.4 Kerberos | 1, 13, 19 |
| §3.5 source, cache, drop | 14, 15 (amendments 1, 2, 8) |
| §3.6 placement, form, STR, STR-Transform, sender-vouches | 2, 3, 8, 9, 10 |
| §3.7 redaction | 4 (amendment 4) |
| §4.1 main | 16 (amendments 5, 6) |
| §4.2 renderer | 6, 10, 17 |
| §5 CLI/MCP, HTTP Log | 4, 5, 15, 16, 18 |
| §6 errors | throughout; `wss-proof-key-missing` (3) and `ws-trust-no-request` (16), added to the table by this plan PR |
| §7 security | 1 (nested password refine), 2 (hardened parse), 4, 13 (no redirects, https), 14 (memory only) |
| §8 testing | every task; interop 10; e2e 7, 18 |
| §9 delivery | the four PRs above |
| §10 docs | 5, 7, 10, 18, 19 |
| §12 risks | 10 (STR-Transform interop gap recorded), 12 and 8 (EncryptedAssertion needs an attached reference), 19 (seam drift) |
