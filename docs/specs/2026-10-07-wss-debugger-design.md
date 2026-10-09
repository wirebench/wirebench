# WS-Security debugger — design

**Issue:** #57 · **Date:** 2026-10-07 · **Status:** draft for owner review

Builds on: the response pane's WSS inspector, incoming verification (`wss/incoming/*`) and the outgoing
preview channel (`wss.previewOutgoing`). Roadmap item 10.

## Objective

When incoming WS-Security fails, say why, not only that it failed. And let a user see the outgoing message
the way a send would secure it, before they press Send. Concretely (the issue's checklist):

1. **Reference diagnostics.** The reference that failed, its expected and computed digest, and the
   canonicalisation and transforms used.
2. **Token and clock.** The token the message expected and that was not found; the clock skew measured
   against the `wsu:Timestamp`.
3. **Timeline.** What the `wsse:Security` header signed and encrypted, step by step, in header order.
4. **Preview.** The secured outgoing envelope and its timeline, from the WSS inspector, without a send.

## Non-goals

- Changing any verdict. A signature, timestamp or decryption that fails today still fails, and one that
  passes still passes. The debugger only explains.
- Accepting encrypt-then-sign responses. Incoming processing decrypts first, so a signature computed over
  ciphertext fails today. This design does not change that (follow-up issue).
- Showing canonical bytes. The canonical form of a referenced part is the payload itself; it is large and
  can be sensitive. Digests identify it well enough.
- CLI and MCP output changes. They already carry the engine's `detail` strings, which become more precise
  here; new structured fields reach them only as JSON passthrough.
- Policy-driven configuration (#58).

## Facts this design rests on

Checked against `main` at `c51f6f6c`.

- `verifySignature` (`wss/outgoing/signature.ts`) runs xml-crypto 6.1.2 `checkSignature` and reports only
  `'One or more references failed validation.'` or the thrown message.
- xml-crypto validates references with `every`, so after the first failing reference the others are not
  checked. Each `Reference` exposes `uri`, `transforms`, `digestAlgorithm`, `digestValue` and
  `inclusiveNamespacesPrefixList` publicly. The canonical form and hash come from private methods
  (`getCanonReferenceXml`, `findHashAlgorithm`); the `SignedInfo` check from private
  `getCanonSignedInfoXml`, `findSignatureAlgorithm` and the private `signatureValue` field.
- `verifyIncoming` (`wss/incoming/verify.ts`) reports an unresolved signer as one message for every
  `KeyInfo` form: `'The signing certificate could not be resolved from the message or the truststore.'`
- `readTimestamp` reports `'The message was created in the future.'`, `'The message expired.'` and
  `'The message is older than the tolerated clock skew.'`, with no numbers.
- `decryptEnvelope` reports `'No xenc:EncryptedKey in the document could be opened with this key.'` and
  does not say which certificate the message named.
- This build *appends* each entry to `wsse:Security`, so on an outgoing message header order is
  configuration order. WS-Security 1.1 tells producers to *prepend*, so on a message from elsewhere header
  order is usually the reverse of the producer's order.
- `ProjectHost.previewOutgoingWss` applies the request's configuration without contacting a token
  service; `wss.previewOutgoing` redacts the result. Its one caller today is "Apply outgoing WS-Security
  to editor", which writes the result into the editor.
- The renderer may import only *types* from `shared/wire-types.ts` (a value import breaks e2e through
  the CSP zod probe).

## Design

### D1. Per-reference checks

`verifySignature` returns a `check` alongside its verdict:

```ts
export interface WssReferenceCheck {
  readonly uri: string;                 // without '#'
  readonly element?: string;            // local name of the element the URI resolves to
  readonly ok: boolean;
  readonly transforms: readonly string[];   // short names, see below
  readonly inclusivePrefixes: readonly string[];
  readonly digestAlgorithm: string;     // 'sha1' | 'sha256' | 'sha512', or the URI
  readonly expectedDigest: string;      // base64, as the message carries it
  readonly computedDigest?: string;     // base64; absent when the element could not be resolved
  readonly problem?: string;            // why there is no computed digest
}

export interface WssSignatureCheck {
  readonly canonicalization: string;    // SignedInfo's CanonicalizationMethod, short name
  readonly signatureMethod: string;     // 'rsa-sha256', 'rsa-sha1', … or the URI
  readonly references: readonly WssReferenceCheck[];
  /** The SignatureValue verifies over the canonical SignedInfo with the signer's key. */
  readonly signatureValueOk: boolean;
}
```

- Short names: `exc-c14n`, `exc-c14n#WithComments`, `c14n`, `c14n#WithComments`, `enveloped-signature`,
  `str-transform`. Anything else is shown as its URI.
- On success every reference passed, so the expected digest *is* the computed one; nothing is recomputed.
- On failure every reference is recomputed with xml-crypto's own `getCanonReferenceXml` and hash, through
  one typed seam (`wss/incoming/xml-crypto-seam.ts`). Using xml-crypto's code, not a second
  implementation, guarantees the debugger's computed digest is the one the verifier compared. A unit
  test pins the seam, so an xml-crypto upgrade that moves these methods fails the build, not the user.
- `signatureValueOk` is checked through the same seam even when a reference failed, so "the payload was
  changed" and "the wrong key or a changed SignedInfo" are told apart.
- The signature action's `detail` names the cause:
  - one or more references failed: `Reference #Id-1 (Body) does not match: the digest computed with
    exc-c14n and sha256 differs from the one in the message.` (the first failing reference; the rest are
    in `check`);
  - a reference that cannot be digested: `Reference #Id-1 could not be checked: No element in the message
    carries this id.`;
  - references fine, value not: `Every reference matches, but the SignatureValue does not verify with the
    signer's certificate: SignedInfo was changed, or the message names the wrong certificate.`
- `WssAction` gains `check?: WssSignatureCheck` on `signature` actions.

### D2. The token expected and not found; the clock skew

**Signer.** Resolving `ds:KeyInfo` returns either the certificate or a reason naming what the message
asked for:

| Form | Reason when not found |
| --- | --- |
| no `KeyInfo` | `The signature carries no ds:KeyInfo, so its signer cannot be found.` |
| `wsse:Reference` | `KeyInfo refers to token #X509-1, but no element in the message carries that id.` / `… more than one element …` / `Token #X509-1 is not an X.509 certificate.` |
| `ThumbprintSHA1`, `SubjectKeyIdentifier` | `KeyInfo names the signer by ThumbprintSHA1 <value>, and no truststore certificate has it.` (`… and no truststore is configured.` without one) |
| `X509IssuerSerial` | `KeyInfo names the signer by issuer "<dn>" and serial <n>, and no truststore certificate matches.` |
| other | `KeyInfo uses a form this build cannot resolve: <local name>.` |

**Decryption key.** When no `xenc:EncryptedKey` opens with the configured alias, the incoming decrypt
action says which certificate each key names and what the alias has in the same form:
`The message's xenc:EncryptedKey names its certificate by ThumbprintSHA1 <a>; the decryption alias "server"
has <b>.` The engine's `decryptEnvelope` messages do not change; the incoming layer adds the comparison.

**Clock.** `IncomingTimestampResult` and the `timestamp` action gain `skewSeconds` (this machine's clock
minus `Created`, whole seconds; negative means `Created` is ahead) and `toleranceSeconds`. Failures say the
numbers:

- `Created 95 s ahead of this machine's clock; 30 s of clock skew is tolerated.`
- `Expired 40 s ago (Expires 2026-10-07T10:00:00Z); 30 s of clock skew is tolerated.`
- `Created 400 s ago and carries no Expires; 300 s of clock skew is tolerated.`

The fresh detail stays `Timestamp fresh (created …).`.

### D3. Timeline

A pure function `describeSecurityHeader(xml): WssTimelineStep[]` (`wss/timeline.ts`) reads every
`wsse:Security` header child in document order:

```ts
export interface WssTimelineStep {
  readonly kind: 'timestamp' | 'username-token' | 'token' | 'signature' | 'encryption' | 'other';
  readonly summary: string;              // 'Signed Body, Timestamp (rsa-sha256, exc-c14n)'
  readonly covers?: readonly string[];   // element names signed, or encrypted ('Body (content)')
  readonly id?: string;
  readonly actor?: string;               // set when the header is addressed to an actor/role
}
```

- Signature: the referenced elements' names, signature method and canonicalisation.
- `xenc:EncryptedKey` / `xenc:ReferenceList`: each `DataReference` resolved to its `EncryptedData`;
  `Type=…#Content` reads `Body (content)`, `Type=…#Element` reads `element in Body`.
- `xenc:EncryptedData` in the header: `An encrypted header element`.
- Tokens: `X.509 certificate` (with the subject CN when it parses), `SAML assertion`; the username token
  shows its password type only, never the username or password.
- Incoming: computed on the message *as it arrived* (before decryption, so encryption is visible) and
  returned as `WssResult.timeline`.
- Order: the inspector labels the list "In header order". The preview labels it "Applied in this order",
  which is true because this build appends.

### D4. Preview before Send

- `wss.previewOutgoing` returns `timeline` next to `envelopeXml`, computed in main from the *redacted*
  envelope.
- The WSS inspector gets an **Outgoing** section with a **Preview secured request** button. It calls
  `wss.previewOutgoing` with the envelope on screen, then shows the timeline and the secured envelope
  read-only. Nothing is written to the editor or sent. A request with no outgoing configuration shows the
  channel's error text.
- The preview is a snapshot: editing the envelope clears it.

### D5. Wire

- `wssActionWireSchema` gains optional `check`, `skewSeconds`, `toleranceSeconds`.
- `wssExchangeWireSchema.incoming` gains optional `timeline`.
- `wssEnvelopeResponseSchema` stays as it is for insert/remove; `wss.previewOutgoing` gets
  `wssPreviewResponseSchema = { envelopeXml, timeline }`.
- Every new field is a digest, an algorithm name, an element name, a number or an engine message. None
  carries key material, a password or a secret reference.

## Success criteria

- **SC-WD1** A tampered Body reports the failing reference, expected and computed digests (computed equals
  the digest of the tampered part), and the canonicalisation and digest algorithm.
- **SC-WD2** A changed `SignedInfo` (or wrong certificate) is reported as a SignatureValue failure with every
  reference matching.
- **SC-WD3** A signer named by a form the truststore cannot satisfy, and a token reference to a missing id,
  each name what was asked for; an undecryptable message names the certificate the EncryptedKey wants.
- **SC-WD4** A timestamp ahead, expired or stale reports the skew in seconds and the tolerance.
- **SC-WD5** A sign-and-encrypt message's timeline lists the timestamp, token, signature and encryption with
  what each covers, in header order; the outgoing preview lists the configured entries in order.
- **SC-WD6** The WSS inspector's preview shows the secured envelope and timeline without sending or editing.

## Open questions for the owner

- Header order for incoming messages (rather than inferring the producer's order) — acceptable?
- Follow-up: verify signatures over ciphertext (encrypt-then-sign) by processing the header top-down.
