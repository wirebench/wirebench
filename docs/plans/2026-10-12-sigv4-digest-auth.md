# AWS Signature v4 and Digest auth — plan

Spec: `docs/specs/2026-10-12-sigv4-digest-auth-design.md` · issue #339

Each task is written test-first and lands as one commit after
`NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 pnpm check` passes.

1. **SigV4 signer** — `packages/engine/src/http/auth/sigv4.ts`: canonical request, string to sign,
   signing key, `Authorization` / presigned URL. Unit tests against the AWS suite vectors and the S3
   presign example.
2. **Digest math** — `packages/engine/src/http/auth/digest.ts`: challenge pick, HA1/HA2 for
   MD5/SHA-256 and `-sess`, `qop=auth` and legacy, header format, `DigestNonceCache`. Unit tests against
   the RFC 7616 and RFC 2617 examples.
3. **Model + schema + resolution** — the `aws-sigv4` and `digest` arms in `model.ts`, `schema-parts.ts`
   (both unions, the plaintext keys), `SendAuth`, `resolveAuthConfig`, `secretNeedsOfAuth`,
   `missingSecretRef` and `reportedAuth`. Format 9 doc comment. Tests: schema round-trip, refusal of
   plaintext keys, resolution, env names.
4. **Transport** — `sendWithAuth` SigV4 (header/query, `now`) and Digest (cache, stale, retry budget).
   `AuthSummary.signature`. gRPC/WS refusals. Sensitive query parameters and headers. Integration tests
   with local servers on REST and SOAP.
5. **Preview, cURL export, codegen** — `previewRestHeaders` rows, `restToCurl` / `toCurl` flags,
   codegen and SOAP export notes, the desktop `placeholderAuth` / `environmentAuth` / preview stand-ins.
6. **cURL import** — `fromRestCurl` `--digest` / `--aws-sigv4`, the security-token header, and the
   desktop `importCurlAsRest` storing the secrets.
7. **Desktop wire + editor + HTTP Log** — `authConfigWireSchema`, `authSummaryWireSchema`, `AuthFields`
   types and fields, `recordAuthValues`, masking of the signature, and the log detail's
   canonical-request block. Renderer tests.
8. **CLI / MCP** — integration tests: `wirebench run` and MCP `send` with SigV4 and Digest from
   `WIREBENCH_SECRET_*`.
9. **Docs + CHANGELOG** — the auth docs page, the CHANGELOG `[Unreleased]` entry, and the format 9 line.
