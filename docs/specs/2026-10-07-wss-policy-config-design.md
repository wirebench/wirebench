# Policy-driven WS-Security configuration — design

**Issue:** #58 · **Date:** 2026-10-07 · **Status:** draft

Builds on: WS-Addressing policy detection (`packages/engine/src/wsa/policy-detect.ts`), the outgoing
WS-Security model (`packages/engine/src/wss/model.ts`) and the request Auth inspector's WSS selectors.

## Objective

A WSDL that attaches WS-SecurityPolicy assertions already says how a request must be secured. Today the
user reads that XML by hand and rebuilds it as an outgoing WS-Security configuration. After this change:

1. On import, every binding operation's effective security policy is read and summarised: which tokens,
   which parts are signed and encrypted, which algorithm suite, whether TLS is required, whether a
   timestamp is included.
2. The request's Auth inspector shows that summary and an **Apply policy** button. One click creates (or
   refreshes) an outgoing configuration proposed from the policy and selects it for the request.
3. A badge next to the summary says whether the request, as configured now, satisfies the policy, and
   lists each unmet requirement.

## Scope

**Policy sources.** WS-Policy 1.5 and 2004/09 (`wsp:`), WS-SecurityPolicy 1.2/1.3
(`http://docs.oasis-open.org/ws-sx/ws-securitypolicy/200702`) and 1.1
(`http://schemas.xmlsoap.org/ws/2005/07/securitypolicy`). Attachment points per WS-PolicyAttachment for
WSDL 1.1: the binding (and the ports that use it), the binding operation, and the binding operation's
`wsdl:input` — merged, as WS-Policy merges an endpoint, operation and message policy. Policies are found
inline, through `wsp:PolicyReference URI="#id"` and through `wsp:PolicyURIs`. External references (not
`#id`) are noted, not fetched.

**Alternatives.** `wsp:ExactlyOne` takes its first alternative; the summary notes that others exist.

**Assertions read.**

| Assertion | Summary field |
| --- | --- |
| `sp:TransportBinding` with `sp:HttpsToken` | `requiresTls` |
| `sp:AsymmetricBinding` (`InitiatorToken`/`RecipientToken`, `X509Token`) | `binding: 'asymmetric'`, key reference form |
| `sp:SymmetricBinding` | `binding: 'symmetric'` — noted as unsupported |
| `sp:AlgorithmSuite` (`Basic256`, `Basic192`, `Basic128`, their `Sha256` and `Rsa15` variants, `TripleDes*`) | `algorithmSuite` |
| `sp:IncludeTimestamp` | `includeTimestamp` |
| `sp:EncryptBeforeSigning` | `encryptBeforeSigning` |
| `sp:SignedParts`, `sp:EncryptedParts` (`Body`, `Header Name/Namespace`) | `signedParts`, `encryptedParts` |
| `sp:SignedElements`, `sp:EncryptedElements` (XPath) | noted as unsupported |
| `sp:SupportingTokens`, `sp:SignedSupportingTokens`, `sp:Endorsing…` with `UsernameToken`, `IssuedToken`, `SamlToken`, `X509Token`, `KerberosToken` | `tokens` |
| `sp:UsernameToken` `HashPassword` | username token `passwordType: 'digest'` |
| `sp:IssuedToken` `Issuer/Address` | issued-token `stsUrl` |

Anything else under a security binding is ignored. Anything this build cannot express is listed in
`notes` (shown under the summary), never silently dropped.

## Decisions

- **D1. Where it lives.** `wss/policy/detect.ts` (DOM, import time) produces a `WssPolicy` per operation,
  keyed by `wsaActionKey(binding, operation)`. `wss/policy/plan.ts` is pure: `proposeWssEntries(policy)`,
  `checkWssPolicy(policy, entries, endpoint)` and `describeWssPolicy(policy)`. Main runs them behind a
  new `wss.policyStatus` channel (ADR-0002: the renderer reaches the engine over IPC); the renderer
  only renders the answer. A browser-safe engine subpath was considered and dropped, because the
  renderer's engine-import allowlist lives in the protected lint config.
- **D2. Wire.** `WsdlImportResult.wssPolicy` → `OperationSummaryWire.wssPolicy` (optional; absent when the
  operation has no security policy). The renderer finds it on the request's operation to decide whether to
  show the panel, and asks `wss.policyStatus` again whenever the policy, the selected configuration, its
  entries or the endpoint change.
- **D3. Proposal.** Entries in configuration order: timestamp (TTL 300 s); username token
  (`digest` when `HashPassword`, otherwise `text`; nonce and created on for digest); issued token; then
  signature and encryption — signature first unless `EncryptBeforeSigning`. Signature parts: the signed
  parts plus the timestamp when included (WS-SP signs it). Algorithms from the suite: `*Sha256` →
  `rsa-sha256`/`sha256`, otherwise `rsa-sha1`/`sha1`; `Basic256*` → `aes256-cbc`, `Basic128*` →
  `aes128-cbc`; `Basic192*` and `TripleDes*` noted (not offered); `*Rsa15` → `rsa-1_5`, otherwise
  `rsa-oaep`. Key identifier from the token's reference assertions (`RequireThumbprintReference` →
  `Thumbprint`, `RequireIssuerSerialReference` → `IssuerSerial`, `RequireKeyIdentifierReference` →
  `SubjectKeyIdentifier`, otherwise `BinarySecurityToken`). Keystore refs, usernames and secrets are left
  empty: the user picks them in the configuration editor.
- **D4. Apply.** The configuration is named `<Operation> policy`. If the request already selects a
  configuration with that name, its entries are replaced by the proposal, carrying over what the user filled
  in (username, password ref, keystore ref, alias, key password ref, STS URL, credential) from the first
  existing entry of the same kind; otherwise a new configuration is created. Then the request's
  `wssOutgoingRef` is set to it. All through the existing store actions, so it is saved like any other edit.
- **D5. Badge.** `checkWssPolicy` returns one result per requirement (TLS endpoint, timestamp, each token,
  signature present with a keystore and matching algorithms and parts, encryption present with matching
  algorithms and parts, order). All met → "Satisfies policy"; otherwise "Policy: N unmet" with the list. A
  requirement this build cannot express (symmetric binding, XPath elements) is reported unmet with its
  note, so the badge never claims a fit it cannot check.
- **D6. Scope.** Desktop only. The CLI and MCP keep their current behaviour; a later issue can expose the
  summary there.

## Testing

- Engine unit: detection over a crafted fixture `fixtures/wsdl/crafted/ws-security-policy/service.wsdl`
  (transport + username, asymmetric with signed/encrypted parts and Basic256Sha256, referenced policy,
  operation and input level policies, ExactlyOne, symmetric binding, no policy); proposal and check tables.
- Desktop unit: wire conversion carries the policy; the Apply helper's merge; the inspector renders the
  summary, applies, and flips the badge.
- e2e: none new (CI runs the existing suite).
