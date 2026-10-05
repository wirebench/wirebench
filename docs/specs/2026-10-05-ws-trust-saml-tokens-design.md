# Spec: WS-Trust — STS-issued SAML tokens in WS-Security

**Date:** 2026-10-05
**Status:** draft (under review)
**Issue:** [#41](https://github.com/wirebench/wirebench/issues/41) · roadmap item 7 · milestone 3.2 — Enterprise trust

Builds on:

- `docs/specs/2026-09-09-wirebench-v1-explore-and-send-design.md` §6.6: outgoing WS-Security,
  entries applied in order, keystores. Its "1.1" list carries **SAML (form/XML)**, which the
  roadmap folds into this pass.
- `docs/specs/2026-10-01-wirebench-one-send-path-design.md`: one SOAP send path, the prepare
  order and the `SendHost` seam.
- `docs/specs/2026-09-22-soap-owner-auth-design.md` and the REST client spec §3.5: the OAuth2
  token cache, which the issued-token cache copies.
- `docs/specs/2026-10-05-kerberos-spnego-auth-design.md` §D1 ([#40](https://github.com/wirebench/wirebench/issues/40),
  PR #253): the `kerberosToken` seam the Kerberos credential calls.
- ADR-0003 (project folder format), ADR-0004 (secrets outside project files), ADR-0017 (protocol
  modules).

## 1. Objective

**Why.** Federated SOAP estates almost always sit behind a security token service (STS). Before
a client can call a service, it asks the STS for a SAML token and presents that token in the
WS-Security header. Wirebench cannot do that today, so these services are out of reach. The
user's only workaround is to get an assertion elsewhere and paste it into the XML by hand every
time it expires.

**What.** Two new outgoing WS-Security entry kinds. Both put a SAML assertion into
`wsse:Security` at their place in the entry order:

- **Issued token** asks an STS for the token over WS-Trust. It authenticates with a username, a
  certificate or Kerberos, caches the token for its lifetime, and asks again when it runs out.
- **SAML token** is self-issued. It comes in two variants:
  - **form**: Wirebench builds the assertion from fields and can sign it;
  - **XML**: the user supplies a ready assertion, inline or as a file.

A signature entry can refer to either token by a `SecurityTokenReference`. That covers holder-of-key
(the message is signed with the key the token is bound to) and signed supporting tokens (the
signature covers the assertion through the STR-Transform).

**User stories.**

- My service sits behind an ADFS `usernamemixed` endpoint. I add an **Issued token** entry with
  the STS URL, my username and a password secret, then send. Wirebench fetches a SAML 2.0 bearer
  token, puts it in the header and sends. The next twenty sends reuse the token, and the entry
  shows "valid until 14:32". After it expires, the next send fetches a new one.
- The STS wants my client certificate. I pick the credential **Certificate**, choose the keystore
  alias, and the request for the token (the RST) is signed with it.
- The service wants holder-of-key. I set the key type to **Public key**, add a signature entry
  after the token entry, and pick **SAML token reference** as its key identifier. The message is
  signed with my certificate, and the signature's `KeyInfo` points at the assertion.
- A test environment trusts a fixed issuer. I add a **SAML token (form)** entry with issuer,
  subject, audience and two attributes, and sign it with the test issuer's key.
- Support sent me an assertion that works. I paste it into a **SAML token (XML)** entry and
  send it as it is.
- In CI, `wirebench run` fetches the token once per run with the password from an environment
  variable and reuses it across the suite.

## 2. Decisions

### Owner rulings, 2026-10-05

| # | Question | Decision |
| --- | --- | --- |
| 1 | Kerberos as an STS credential | Deferred to #40. The kind is in the format from the start and refuses with `kerberos-unavailable` until #40's engine seam lands; then it calls `kerberosToken` (§3.4) |
| 2 | Proof-of-possession | **Bearer** and **asymmetric holder-of-key** (signed with the user's own keystore key). No symmetric proof keys |
| 3 | Token cache | **In memory only.** The desktop keeps a per-session cache; CLI and MCP keep one per run. Never written to disk or the keychain |
| 4 | Self-issued SAML | Both variants, **form** and **XML**, in this pass |

### Taken in this spec (open for review)

| # | Question | Decision | Why |
| --- | --- | --- | --- |
| 5 | Where the STS settings live | Inline in the `issued-token` entry; there is no separate STS registry | Interfaces and endpoints carry no WS-Security of their own today; one entry is one token. A shared STS file can come later without a format break |
| 6 | When the token is fetched | Lazily, while outgoing WS-Security is applied, through a new `WssContext.issuedTokens` capability (§3.5) | `applyOutgoingWss` is already async and takes its keystores and secrets the same way. Preview can then show a cached token without fetching one |
| 7 | WS-Trust versions | WS-Trust 1.3 (`200512`) and the February 2005 draft (`2005/02`) | The draft is what older WCF stacks and ADFS `/trust/2005/` endpoints still speak |
| 8 | The STS exchange in the HTTP Log | Its own log row, marked **STS**. Never a History row. Assertions and Kerberos tokens are masked (§5.2) | Federated failures are usually STS failures. Today an auxiliary request is invisible unless it fails, which is too little here |
| 9 | Expired token at the service | A SOAP fault that says the token is bad drops the cached token. No automatic resend | Mirrors `dropRefusedToken` for OAuth2 |
| 10 | Assertion bytes | Never mutated and never given a `wsu:Id`, so its exc-c14n form is unchanged. Signing re-serialises the envelope, so byte-for-byte identity is not promised (plan amendment 3) | Anything else breaks the issuer's enveloped signature |

## 3. Engine

### 3.1 Model

The new types live in `packages/engine/src/wss/model.ts`, beside the four existing kinds.
`WssEntry` and `WSS_ENTRY_KINDS` gain `'issued-token'` and `'saml-token'`, in that order after
`'encryption'`.

```ts
export type SamlVersion = '1.1' | '2.0';
export type WsTrustVersion = '1.3' | '2005-02';
export type IssuedKeyType = 'bearer' | 'public-key';

export type StsCredential =
  | { readonly kind: 'username'; readonly username: string; readonly passwordRef?: string }
  | { readonly kind: 'certificate'; readonly keystoreRef: string; readonly alias?: string; readonly keyPasswordRef?: string }
  | {
      readonly kind: 'kerberos';
      /** Service principal of the STS: `host/sts.corp`, `HTTP@sts.corp` or a bare host (#40 normalises). */
      readonly spn: string;
      readonly principal?: string;
      /** Windows only, per #40 §D1. Resolved through `secrets/resolve.ts`. */
      readonly username?: string;
      readonly domain?: string;
      readonly passwordRef?: string;
    };

/** A `wsse:Security` SAML assertion requested from a security token service. */
export interface WssIssuedTokenEntry {
  readonly kind: 'issued-token';
  /** STS endpoint URL; property expansion applies. */
  readonly stsUrl: string;
  readonly soapVersion: '1.1' | '1.2';
  readonly trustVersion: WsTrustVersion;
  /** `wsp:AppliesTo` address; empty means the request's own endpoint URL. Property expansion applies. */
  readonly appliesTo?: string;
  readonly tokenType: SamlVersion;
  readonly keyType: IssuedKeyType;
  /**
   * For `public-key`: the keystore alias whose certificate goes into `wst:UseKey` and whose key
   * later signs the message. Defaults to the configuration's `defaultAlias`.
   */
  readonly proofKeystoreRef?: string;
  readonly proofAlias?: string;
  readonly credential: StsCredential;
  /** Requested lifetime in seconds; `0` asks for none and takes the STS default. */
  readonly requestedLifetimeSeconds: number;
  /** Raw `wst:Claims` XML, copied into the RST as it is. Property expansion applies. */
  readonly claims?: string;
  /** Client certificate for mutual TLS to the STS; the request's own TLS settings do not carry over. */
  readonly tlsKeystoreRef?: string;
}

export interface SamlAttribute { readonly name: string; readonly nameFormat?: string; readonly values: readonly string[] }

export type SamlConfirmation = 'bearer' | 'holder-of-key' | 'sender-vouches';

/** A self-issued SAML assertion, built from fields (`form`) or supplied (`xml`). */
export type WssSamlTokenEntry =
  | {
      readonly kind: 'saml-token';
      readonly source: 'form';
      readonly version: SamlVersion;
      readonly issuer: string;
      readonly subject: string;
      readonly subjectFormat?: string;
      readonly confirmation: SamlConfirmation;
      readonly audience?: string;
      /** Seconds the assertion is valid from now; `NotBefore` is backdated by the clock-skew allowance. */
      readonly lifetimeSeconds: number;
      readonly authnContext?: string;
      readonly attributes: readonly SamlAttribute[];
      /** Sign the assertion as its issuer (enveloped signature over `ID` / `AssertionID`). */
      readonly sign?: { readonly keystoreRef: string; readonly alias?: string; readonly keyPasswordRef?: string; readonly signatureAlgorithm: WssSignatureAlgorithm };
      /** For holder-of-key: the alias whose certificate goes in `SubjectConfirmationData`. */
      readonly proofKeystoreRef?: string;
      readonly proofAlias?: string;
    }
  | {
      readonly kind: 'saml-token';
      readonly source: 'xml';
      /** Exactly one of `xml` and `file`. A file path is project-relative and contained (ADR-0005). */
      readonly xml?: string;
      readonly file?: string;
      /** Run property expansion on the text first; off by default because it would break a signed assertion. */
      readonly expandProperties: boolean;
    };
```

Every value, whether text, a file, a form field or an STS token, goes through the same placement
code. Every secret is a reference, never a value: a plaintext `password` is rejected the same way
UsernameToken rejects one today (`project/schema.ts`:117).

**Signature entry additions.**

- `WssKeyIdentifierType` gains `'saml-token'`. The signature's `KeyInfo` becomes a
  `wsse:SecurityTokenReference` to the nearest earlier SAML entry in the same configuration. The
  private key still comes from `keystoreRef`/`alias`, and for holder-of-key it must be the proof
  alias.
- `WssPart` gains a token part, `{ name: 'SamlToken', token: true }`. The signature then covers
  the assertion through the STR-Transform (§3.6) rather than by `Id`.

### 3.2 Format

- `project/schema.ts` gains `wssIssuedTokenSchema`, `wssSamlTokenSchema` and the additions to
  the signature entry. `wssOutgoingFileSchema` already keeps unknown kinds through a load and
  save, so projects stay openable both ways.
- **No format bump.** The change only adds things. An older engine or CLI opens the project, keeps
  the new entries, and refuses to send with them (`wss-entry-unsupported`). That refusal is loud and
  correct. An older desktop build may misread an entry kind it does not know in the WS-Security
  editor, so edit such a configuration only with this version or later.
- The CLI env-secret needs (`soap/run.ts` `outgoingNeeds`) gain every new reference:
  - `passwordRef` and the certificate credential's keystore and `keyPasswordRef`;
  - `proofKeystoreRef`, `tlsKeystoreRef` and `sign.keystoreRef`.
- The new kinds also need adding to the legacy-import warning text in
  `soap/legacy-project/map.ts`:184. It already says WS-Security configurations are not imported,
  so only the wording changes.

### 3.3 The WS-Trust client — `packages/engine/src/wss/trust/`

`requestIssuedToken(entry, target, deps): Promise<IssuedToken>` builds an RST, sends it and reads
the reply (the RSTR).

**The request (RST).** The SOAP 1.1 or 1.2 envelope carries:

- **WS-Addressing 1.0 headers**, always: `Action`, which is `…/RST/Issue` for 1.3 and
  `http://schemas.xmlsoap.org/ws/2005/02/trust/RST/Issue` for the draft; a fresh `MessageID`;
  `ReplyTo` anonymous; and `To` = `stsUrl`.
- **A `wsse:Security` header**, built by the existing builders. Its content depends on the
  credential:
  - **username**: Timestamp plus a UsernameToken with a text password. This is the `…mixed`
    pattern, so the STS URL must be `https`; plain `http` refuses with `ws-trust-insecure-transport`.
  - **certificate**: Timestamp, a BinarySecurityToken and a Signature over Timestamp and Body,
    using the existing signature builder and alias.
  - **kerberos**: Timestamp plus a BinarySecurityToken with
    `ValueType="…#GSS_Kerberosv5_AP_REQ"`. Its bytes come from `deps.kerberosToken(spn, credentials)`.
- **A Body** holding `wst:RequestSecurityToken` with:
  - `TokenType`: the SAML 1.1 or SAML 2.0 token profile URI;
  - `RequestType` `Issue`;
  - `wsp:AppliesTo/wsa:EndpointReference/wsa:Address`;
  - `KeyType`: `Bearer`, or `PublicKey` with `UseKey` carrying the proof certificate as an X.509
    BinarySecurityToken;
  - `Lifetime`, when `requestedLifetimeSeconds > 0`;
  - `Claims`, when set.

**The reply (RSTR).** The client accepts the 1.3 `RequestSecurityTokenResponseCollection` or a
single `RequestSecurityTokenResponse`, and reads:

- `RequestedSecurityToken`'s single element child. It keeps the element and its in-scope
  namespaces as they are. A `saml2:EncryptedAssertion` is opaque, and is placed and cached like
  any other token.
- `RequestedAttachedReference`, kept for the signature's STR when present.
- `Lifetime/wsu:Expires`. When that is absent, the assertion's `Conditions/@NotOnOrAfter`. When
  both are absent, the token is used once and never cached (the status line says so).
- A `RequestedProofToken`, which means the STS issued a symmetric key. That refuses with
  `ws-trust-symmetric-key-unsupported`, because symmetric keys are out of scope.

**Failures.** A SOAP fault refuses with `ws-trust-sts-fault`, carrying the fault code, the reason
and the HTTP status. A body that is not an RSTR refuses with `ws-trust-response-invalid`. Failures
are never cached.

**Transport.** The STS call uses `sendHttp` with the request's proxy, the workspace trust roots
and `tlsKeystoreRef` as the client identity. Redirects are not followed: a 3xx refuses with
`ws-trust-sts-fault`, so credentials never travel to a second host.

### 3.4 Kerberos

The `kerberos` credential calls `kerberosToken` from `packages/engine/src/http/auth/kerberos-token.ts`
(#40 §D1, delivered in #40's PR 1).

- That seam owns the availability check, SPN normalisation, the KRB5 mechanism and error
  mapping. This spec adds nothing to it.
- Until #40's seam is merged, the kind validates and saves, and sending refuses with
  `kerberos-unavailable`.
- On macOS and Linux, explicit `username`/`passwordRef` refuse with #40's
  `kerberos-explicit-credentials-unsupported`, and the editor greys them out there.

### 3.5 The token source and the cache seam

```ts
export interface IssuedTokenSource {
  /** A cached, unexpired token for this key, or a fresh one from the STS. */
  get(entry: WssIssuedTokenEntry, target: IssuedTokenTarget, deps: TrustDeps): Promise<IssuedToken>;
  /** Only what is cached; never contacts the STS. Preview uses this. */
  peek(entry: WssIssuedTokenEntry, target: IssuedTokenTarget): IssuedToken | undefined;
  reject(token: IssuedToken): void;
  status(entry: WssIssuedTokenEntry, target: IssuedTokenTarget): IssuedTokenStatus;
  clear(entry: WssIssuedTokenEntry, target: IssuedTokenTarget): void;
}

export interface IssuedToken {
  readonly assertionXml: string;            // self-contained serialisation, never mutated
  readonly assertionId?: string;            // ID / AssertionID, for the STR
  readonly attachedReferenceXml?: string;
  readonly samlVersion: SamlVersion;
  readonly keyType: IssuedKeyType;
  readonly expiresAt?: Date;
  readonly proofCertPem?: string;
  readonly stsHost: string;
  readonly cacheKey: string;
}
```

- The assertion is a string, not an `Element`: signing re-parses the envelope, so a cached
  `Element` would go stale (plan amendment 2).
- `SendHost` gains `issuedTokens?: IssuedTokenSource`, next to `tokens: RunTokenSource`.
  `WssContext` gains `issuedTokens?: BoundIssuedTokens` (`get(entry)` / `peek(entry)`), which
  `wssFor` in `soap/run.ts` binds to the send's endpoint, scopes, TLS and proxy (plan amendment 1).
  `WssContext` also gains `expand?` and `projectFile?` (plan amendment 7).
- If the source is missing when a configuration has an issued-token entry, sending refuses with
  `ws-trust-unavailable`.
- **The cache key** is a sha256 of: `stsUrl` (after expansion), `trustVersion`, `soapVersion`,
  `tokenType`, `keyType`, `appliesTo` (after expansion), the proof keystore and alias references, the
  credential identity, and the hash of `claims`.
  - The credential identity is the username, the certificate keystore and alias references, or
    the SPN plus principal. References, not fingerprints, so no keystore is loaded just to build a
    key (plan amendment 8).
  - No secret goes into the key, so changing a password in the secret store does not invalidate a
    live token. Clear covers that case (§4.2).
- **Refresh margin.** A token with less than 60 seconds left counts as expired. This is the same
  skew constant as `needsRefresh` for OAuth2.
- **Headless.** `createIssuedTokenSource` (`run/issued-token.ts`) keeps one cache per run, the
  same way `createRunTokenSource` does.
- **Bad token at the service.** After the send, `dropRejectedIssuedToken` looks at a SOAP fault
  whose code is `wsse:InvalidSecurityToken`, `wsse:FailedAuthentication`,
  `wsse:SecurityTokenUnavailable` or `wsse:MessageExpired`. If that request used an issued
  token, it calls `reject`. It sits next to `dropRefusedToken` (`run/send-helpers.ts`:267).

### 3.6 Placement and signing

**Placement** (`wss/outgoing/saml.ts`).

- `buildEntry` resolves the assertion:
  - issued token: `issuedTokens.get`;
  - form: `buildSamlAssertion`;
  - XML: parse the text and require exactly one `saml:Assertion`, `saml2:Assertion` or
    `saml2:EncryptedAssertion` root, otherwise `saml-token-invalid`.
- It imports the assertion into the envelope document and appends it to `wsse:Security`, in
  entry order like the other kinds.
- `apply.ts` records the placed token in a per-envelope token list, so a later signature entry
  can find it.

**Form assertions** (`wss/saml/build.ts`).

- **SAML 2.0**: `Issuer`, `Subject` with `NameID` and `SubjectConfirmation`, `Conditions` with
  `AudienceRestriction`, an `AuthnStatement` and an optional `AttributeStatement`. The fields come
  from the entry. `ID` is `_` plus a UUID, and `IssueInstant`/`NotOnOrAfter` come from
  `WssContext.clock`. Holder-of-key puts the proof certificate in `SubjectConfirmationData` as a
  `KeyInfo`.
- **SAML 1.1**: the same content, in 1.1 statements.
- **Signing**: when `sign` is set, an enveloped signature over the assertion's `ID`/`AssertionID`,
  with exc-c14n and the chosen RSA algorithm, made with xml-crypto using `idAttributes` set to the
  SAML attribute.

**Signature changes** (`wss/outgoing/signature.ts`, `key-identifiers.ts`).

- **`keyIdentifierType: 'saml-token'`** writes the STR into `KeyInfo`:
  - the RSTR's `RequestedAttachedReference` when there is one;
  - otherwise a `wsse:KeyIdentifier` with `ValueType` `…#SAMLAssertionID` (1.1) or `…#SAMLID`
    (2.0), plus `wsse11:TokenType` on the STR.
  - Refuses with `wss-saml-token-missing` when no SAML entry comes before the signature entry.
  - For holder-of-key, refuses with `wss-proof-key-mismatch` when the signing alias's certificate
    is not the proof certificate.
- **Token part `SamlToken`** adds a second STR with a `wsu:Id` to `wsse:Security` (or reuses the
  `KeyInfo` STR), plus a reference to that STR with the STR-Transform
  (`…oasis-200401-wss-soap-message-security-1.0#STR-Transform`) and exc-c14n as its
  `TransformationParameters`.
  - The transform is registered with xml-crypto through `CanonicalizationAlgorithms`. It
    dereferences the STR to the assertion and canonicalises the assertion in its place.
  - The assertion itself never gets an `Id` added. The `wsu:Id` loop at `signature.ts`:152–162
    skips token parts.
- **Sender-vouches** is a signature by the user's own key, covering Body, Timestamp and the
  `SamlToken` part. It needs no new code beyond the above.

### 3.7 Redaction (`redact/index.ts`)

**Masked** (plan amendment 4: readable but unusable):

- the text of every `ds:SignatureValue` and `xenc:CipherValue` inside a `saml:Assertion`,
  `saml2:Assertion`, `saml2:EncryptedAssertion` or `wst:RequestedProofToken`, wherever they
  appear. A masked assertion cannot be replayed, because its signature is gone;
- the whole content of a `wsse:BinarySecurityToken` whose `ValueType` ends in `Kerberosv5_AP_REQ`.
  This is #40's D8, handed to this spec.

Everything else in an assertion stays visible, including `Issuer`, `NameID` and the conditions,
which are the usual reasons a token is refused. The scanner is a forward scan, never a
backtracking regex.

**Kept.** An X.509 BinarySecurityToken is public, so it stays.

`wsse:Password` keeps its current rule. Show-secrets turns masking off exactly as it does today.
Fetched tokens are also handed to `SendHost.onSecretValue`, so the masker catches a copy that
turns up in a script log or a response echo.

## 4. Desktop

### 4.1 Main process

- **The service.** `apps/desktop/src/main/issued-tokens.ts` holds `IssuedTokensService`, which
  wraps one engine `createIssuedTokenSource()` kept for the whole session (plan amendment 5). Two
  concurrent sends for the same key share one STS call (a single-flight promise).
- **The bridge.** `main/send/host.ts` adapts it into `SendHost.issuedTokens`, and passes fetched
  assertions to `recordSecretValue`.
- **The log row.** Each STS exchange is reported through `SendHost.events.onExchange`, which the
  WebSocket handshake already uses, as an HTTP Log row:
  - marked **STS**, linked to the send that caused it: an `exchangeSummarySchema` row with
    `auxiliary: 'sts'` and `causedBy: <sendId>` (plan amendment 6);
  - redacted per §3.7;
  - written to the log only, never to History;
  - a cache hit makes no row.
- **IPC.** `issuedTokens.status({projectId, configId, entryIndex, requestId?})`, `issuedTokens.fetch(…)` and
  `issuedTokens.clear(…)`.
  - Status reports: `expiresAt`, the SAML version, the key type, and where the token came from
    (cached or not cached, with the reason). The assertion itself is included only when
    show-secrets is on.
  - `fetch` uses the same target as a send of the selected request.
- **Preview.** `previewOutgoingWss` uses `peek`. With no cached token, the preview shows a
  placeholder comment: `<!-- issued token: fetched from <sts host> at send -->`. Previewing never
  contacts the STS.
- **The wire schema.** `wssEntryWireSchema` and `wssOutgoingPatchSchema` in `shared/wire-types.ts`
  gain both kinds. It is a strict union, so this is required. Renderer imports from wire-types
  stay type-only (the CSP trap).

### 4.2 Renderer

**The Add-entry list.** `features/wss/outgoing-config-editor.tsx` gains **Issued token (WS-Trust)**
and **SAML token**. The SAML token entry has a Form/XML switch.

**The fields.** `outgoing-entry-fields.tsx` gains two field sets.

- `IssuedTokenFields` is laid out in three groups:
  1. **STS**: URL, SOAP version, WS-Trust version, AppliesTo, mutual-TLS keystore.
  2. **Token**: SAML version, key type, proof alias (shown for Public key only), requested
     lifetime, Claims (a small XML editor).
  3. **Credential**: Username / Certificate / Kerberos. Kerberos shows "Needs Kerberos support
     (#40)" until the seam is there, and greys out the Windows-only fields on other platforms.
- `IssuedTokenStatus` sits under the fields and is modelled on `OAuth2StatusPanel`:
  - "Valid until 14:32 · SAML 2.0 · bearer", or "No token cached";
  - **Fetch now** and **Clear** buttons;
  - the last STS fault, shown inline with a link to its log row.
- `SamlTokenFields`:
  - **Form**: issuer, subject and format, confirmation, audience, lifetime, authentication
    context, an attributes grid (name, format, values), and optional signing (keystore, alias,
    algorithm).
  - **XML**: an XML editor, or a project file picker, plus the "Expand properties" switch, with a
    warning that expansion breaks a signed assertion.

**Signature entry.** Key identifier gains **SAML token reference**. The parts table gains a
**SAML token (STR-Transform)** row that can be added once.

**Errors.** Inline validation follows the refusal codes in §6, before any send.

## 5. Headless and visibility

### 5.1 CLI and MCP

- Nothing new to select: both send through `soapRun`, which uses the request's stored
  configuration.
- `createRunIssuedTokenSource` fills `SendHost.issuedTokens`, one cache per run, so a suite
  fetches each token once.
- Secrets come from the environment through `secretNeeds` (§3.2). `docs/cli.md` documents the new
  secret names.
- Kerberos uses the ambient ticket cache, as #40 does.
- The MCP and CLI redaction text (`mcp/server.ts`:28, `ops/redact.ts`:107) is updated to mention
  SAML assertions and Kerberos tokens.
- `wirebench send --verbose` prints one line per STS exchange: host, status, cached or fetched,
  and expiry.

### 5.2 HTTP Log

The STS row (§4.1) uses the existing log detail tabs. A failed STS call shows as the existing
"Failed · before send" row, with the fault reason, as an OAuth2 token failure does now.

## 6. Errors

| Code | When |
| --- | --- |
| `ws-trust-unavailable` | An issued-token entry was sent with no token source on the host |
| `ws-trust-insecure-transport` | A username credential with an `http:` STS URL |
| `ws-trust-sts-fault` | The STS answered with a SOAP fault, a non-2xx status or a redirect |
| `ws-trust-response-invalid` | The reply is not an RSTR, or has no single token element |
| `ws-trust-symmetric-key-unsupported` | The RSTR carries a `RequestedProofToken` |
| `kerberos-unavailable`, `kerberos-*` | From #40's seam, passed through unchanged |
| `saml-token-invalid` | An XML-variant assertion that does not parse, or has the wrong root |
| `saml-token-file-missing` | The XML variant's file is missing or outside the project |
| `wss-saml-token-missing` | A `saml-token` key identifier or `SamlToken` part with no SAML entry before it |
| `wss-proof-key-mismatch` | Holder-of-key signed with a key other than the proof key |
| `wss-proof-key-missing` | A holder-of-key or public-key token with no proof certificate |
| `ws-trust-no-request` | Fetch now on a configuration that no request selects |

Every refusal names the configuration and the entry's position. None of them carries a secret.

## 7. Security

- **Secrets.** Passwords, key passphrases and Kerberos passwords are references only (ADR-0004).
  Fetched assertions live only in memory, and are dropped when the session ends or the run
  finishes.
- **Transport.** No redirects to the STS. `https` is required for the username credential.
  Mutual TLS uses its own keystore reference.
- **Scripts.** A pre-request script runs before WS-Security is applied, so it never sees an
  issued token.
- **Masking.** Assertions and Kerberos tokens are masked in the log, in History, in HAR export and
  in CLI/MCP output, through the engine's redaction (§3.7), with the value masker as a second net.
- **Untrusted input.** A pasted assertion, a file or an RSTR is parsed with the engine's existing
  hardened XML parser (no DTDs, no external entities). Wirebench never verifies an issued
  assertion's signature, because that is the service's job. It is never re-serialised either.

## 8. Testing

- **Unit (engine):**
  - RST shapes for each credential × trust version × SOAP version, as golden XML;
  - RSTR parsing from fixtures: 1.3 collection, 2005/02 single, SAML 1.1, SAML 2.0, an encrypted
    assertion, a symmetric proof token (refused), a fault, and no lifetime (not cached);
  - cache-key components, the refresh margin and single-flight;
  - form assertions for both versions, signed and unsigned;
  - XML-variant validation;
  - the STR forms;
  - an STR-Transform signature that verifies with the engine's own verifier after it learns to
    dereference an STR (`incoming/verify.ts`);
  - the redaction rules.
- **Byte preservation:** an STS-signed assertion fixture placed and then signed over through
  STR-Transform must keep its own enveloped signature valid. This is checked by verifying the
  assertion signature after placement.
- **Integration:** a fake STS on a local HTTPS server (username and certificate), then a SOAP
  stub service that checks the token is present, covering both the per-run cache and the desktop
  cache. Kerberos runs in #40's integration job once the seam lands, with `kerberosToken`'s bytes
  inside a BinarySecurityToken.
- **Interop:** xmlsec1 has no STR-Transform. The existing `wss-xmlsec` job covers form-assertion
  signatures, using `--id-attr:ID` for SAML 2.0. STR-Transform interop is a refinement for
  planning (§12).
- **e2e:** add an issued-token entry against the fake STS, send, see the token reused and the
  status line, Clear, and see a new STS row.
- **Success criteria:** add `SC-WT1`…`SC-WT6` to `docs/success-criteria.md`, one each for STS
  username, STS certificate, holder-of-key, form, XML, and Kerberos (blocked by #40).

## 9. Delivery

There is one plan and four pull requests, in this order:

1. **SAML placement and self-issued tokens:**
   - model, schema, wire;
   - `saml-token` form and XML;
   - placement and redaction;
   - editor fields.
2. **Token references and STR-Transform signing:**
   - the `saml-token` key identifier and the `SamlToken` part;
   - verifier dereferencing;
   - holder-of-key and sender-vouches for form tokens.
3. **WS-Trust client:**
   - `issued-token` with username and certificate credentials;
   - both caches and Clear/Fetch;
   - the STS log row and the verbose line;
   - documentation.
4. **Kerberos credential:** wire `kerberosToken` in, after #40's PR 1 is merged.

## 10. Documentation

- A new guide, `docs-site/.../guides/ws-trust.mdx`. It covers:
  - the STS flow;
  - each credential, with the common STS endpoint shapes (`…/usernamemixed`, `…/certificatemixed`,
    `…/windowstransport`) described neutrally;
  - holder-of-key versus bearer;
  - what the STS log row shows.
- The WS-Security guide gains the two entry kinds and the new signature options.
- `docs/cli.md` documents the secret names and the verbose line.
- `docs/roadmap.md` item 7: WS-Trust and SAML move to shipped as each PR lands.

## 11. Not in scope

- Symmetric proof keys: entropy, `P_SHA1`, HMAC signatures, `RequestedProofToken`. These were
  ruled out (decision 2).
- Configuration driven by WS-SecurityPolicy `sp:IssuedToken`. That is
  [#58](https://github.com/wirebench/wirebench/issues/58), which can fill this entry from the WSDL
  later.
- Verifying SAML in incoming responses, and SAML for REST requests (the Bearer SAML grant).
- Token renewal and cancel (`RequestType` Renew and Cancel), and an STS chain (ActAs, OnBehalfOf).
- Persisting tokens across restarts (decision 3).

## 12. Risks and refinements for planning

- **STR-Transform interop.** There is no reference verifier in CI. Planning chooses between a
  WSS4J check job and committed vectors from a WSS4J run, with the generator script committed.
- **ADFS quirks.** These include the `trust/13` SOAP 1.2 requirement and an empty `AppliesTo`
  realm mismatch. Each is checked against a public ADFS test fixture before PR 3 closes.
- **`EncryptedAssertion` for holder-of-key.** The STR needs the inner assertion's ID, which the
  client cannot read. The `RequestedAttachedReference` is then required, and its absence refuses
  with `wss-saml-token-missing`.
- **The #40 seam signature.** If #40's API changes during its review, PR 4 follows it. This spec
  pins only the function and the token framing.
