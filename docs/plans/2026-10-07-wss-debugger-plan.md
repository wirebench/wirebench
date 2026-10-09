# Plan: WS-Security debugger

Spec: [`docs/specs/2026-10-07-wss-debugger-design.md`](../specs/2026-10-07-wss-debugger-design.md)
Issue: [#57](https://github.com/wirebench/wirebench/issues/57)

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to carry out this plan task by task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** A failed incoming verify or decrypt says which reference, digest, canonicalisation, token or
clock skew is at fault; a timeline shows what the Security header signed and encrypted; the WSS
inspector previews the secured outgoing message without a send.

**Architecture:**
- Engine: `verifySignature` returns a per-reference `check` (through one xml-crypto seam);
  `verifyIncoming` names the missing signer token and the timestamp skew; `describeSecurityHeader`
  builds the timeline; `processIncomingWss` carries all three.
- Desktop: the wire schemas mirror the new fields; the WSS inspector renders them, and an Outgoing
  section calls `wss.previewOutgoing`, which now also returns the timeline.

**Tech stack:** TypeScript (ESM, `.js` import suffixes), vitest, xml-crypto 6.1.2, React.

## Global constraints

- **Gate before every commit:** `WIREBENCH_SKIP_PERF=1 pnpm check`. `pnpm test:perf` before the push.
- No local Electron windows; CI runs e2e.
- **Commits:** one per task after the gate is green, as Mohammed Naami <m.naami@outlook.com>, no
  `Co-Authored-By:` or `Claude-Session:` trailer.
- **Product names:** never name the product that inspired a feature (`pnpm check:banned-terms`).
- **No new dependencies.** No verdict changes: every existing pass/fail stays as it is.
- The renderer imports only types from `shared/wire-types.ts`.

## File map

| File | Change |
| --- | --- |
| `packages/engine/src/wss/incoming/xml-crypto-seam.ts` | new: typed access to xml-crypto's reference/SignedInfo internals |
| `packages/engine/src/wss/incoming/check.ts` | new: `WssSignatureCheck`, short algorithm names, `signatureCheck()` |
| `packages/engine/src/wss/outgoing/signature.ts` | `verifySignature` returns `check` |
| `packages/engine/src/wss/incoming/verify.ts` | carries `check`; KeyInfo reasons; timestamp skew |
| `packages/engine/src/wss/incoming/decrypt.ts` | names the certificate an unopened EncryptedKey wants |
| `packages/engine/src/wss/timeline.ts` | new: `describeSecurityHeader` |
| `packages/engine/src/wss/incoming/index.ts` | `WssAction.check/skewSeconds/toleranceSeconds`, `WssResult.timeline`, details |
| `packages/engine/src/index.ts` | exports |
| `apps/desktop/src/shared/wire-types.ts`, `ipc.ts` | wire schemas, preview response |
| `apps/desktop/src/main/engine-wire.ts`, `ipc/wss.ts` | mapping; preview timeline |
| `apps/desktop/src/renderer/features/request-editor/inspectors/wss-inspector.tsx` | diagnostics, timeline, preview |
| `docs-site/src/content/docs/guides/auth.mdx`, `docs/success-criteria.md`, `CHANGELOG.md` | docs |

---

### Task 1: Per-reference checks (SC-WD1, SC-WD2)

- [ ] `xml-crypto-seam.ts`: an interface for the private members used (`getCanonReferenceXml`,
  `findHashAlgorithm`, `getCanonSignedInfoXml`, `findSignatureAlgorithm`, `signatureValue`,
  `signatureAlgorithm`, `canonicalizationAlgorithm`) and one cast function. Unit test asserts each is a
  function/field on a real `SignedXml` after `loadSignature`.
- [ ] `check.ts`: short-name maps; `signatureCheck(verifier, xml, key, passed)` — on `passed`, references
  from `getReferences()` with computed = expected; otherwise resolve each URI (unique `Id`/`ID`/`id`, as
  xml-crypto does), recompute through the seam, and verify the SignatureValue through the seam. Never
  throws: a step that throws becomes `problem`.
- [ ] `verifySignature` returns `check` when the signature loaded.
- [ ] `verifyIncoming` passes `check` through; `processIncomingWss` puts it on the action and builds the
  detail from it (spec D1 texts).
- [ ] Tests (`test/unit/wss/incoming/check.test.ts`): tampered Body → failing reference `Body`, expected
  ≠ computed, computed = sha256 of exc-c14n of the tampered Body, `signatureValueOk: true`; tampered
  `SignatureValue` → all references ok, `signatureValueOk: false`, D1 text; a valid signature → all ok.
- [ ] Gate, commit `feat(engine): name the WS-Security reference that failed (#57)`.

### Task 2: Token not found and clock skew (SC-WD3, SC-WD4)

- [ ] `certificateFromKeyInfo` returns `{ certificate } | { reason }` with the spec D2 texts; the
  signature result uses the reason as `error`.
- [ ] `readTimestamp` adds `skewSeconds` and `toleranceSeconds` and the D2 texts; the timestamp action
  carries both fields.
- [ ] Incoming decrypt: on `wss-decrypt-failed` "No xenc:EncryptedKey…", append the comparison of what
  each EncryptedKey names against the alias certificate in the same form.
- [ ] Update existing tests that assert the old texts; add one per D2 row.
- [ ] Gate, commit `feat(engine): say which token and how much clock skew (#57)`.

### Task 3: Timeline (SC-WD5, engine half)

- [ ] `timeline.ts`: `describeSecurityHeader(xml)`; never throws (unparsable → `[]`).
- [ ] `processIncomingWss` sets `timeline` from the arrived XML when non-empty.
- [ ] Export `describeSecurityHeader`, `WssTimelineStep`, `WssSignatureCheck`, `WssReferenceCheck`;
  update `public-exports` tests.
- [ ] Tests: sign+encrypt outgoing envelope → timestamp, token, signature (covers Body, Timestamp),
  token, encryption (`Body (content)`), in that order; username token summary carries no username.
- [ ] Gate, commit `feat(engine): timeline of the WS-Security header (#57)`.

### Task 4: Desktop — diagnostics and timeline in the inspector

- [ ] Wire schemas (D5) and `engine-wire.ts` mapping; ipc test for the mapping.
- [ ] Inspector: a failed signature lists its references (element, ok, digests, transforms); the timestamp
  row shows skew and tolerance; a "Security header" list renders the timeline.
- [ ] Gate, commit `feat(desktop): show WS-Security diagnostics and timeline (#57)`.

### Task 5: Desktop — preview before Send (SC-WD5, SC-WD6)

- [ ] `wssPreviewResponseSchema`; `wss.previewOutgoing` returns `timeline` from the redacted envelope.
- [ ] Inspector Outgoing section: **Preview secured request** → timeline ("Applied in this order") and the
  envelope read-only; errors shown inline; cleared when the envelope changes.
- [ ] e2e: extend `e2e/specs/wss.spec.ts` with the preview (CI runs it).
- [ ] Gate, commit `feat(desktop): preview the secured request before Send (#57)`.

### Task 6: Docs

- [ ] `auth.mdx` WS-Security section: the debugger and the preview; success-criteria rows SC-WD1–6;
  CHANGELOG Unreleased → Added.
- [ ] Gate, commit `docs: WS-Security debugger (#57)`.
