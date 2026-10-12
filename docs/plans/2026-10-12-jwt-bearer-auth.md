# Client-signed JWT bearer auth — plan

Spec: `docs/specs/2026-10-12-jwt-bearer-auth-design.md`. Issue #348. One commit per task, each after
`NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 pnpm check` is green.

1. **Engine signer.** Add `jose` to the engine. `http/auth/jwt.ts`: `signJwt`, claim templating
   (`buildJwtPayload`), `createJwtSource` with reuse until 30 s before `exp` and `reject`. Unit
   tests for all 12 algorithms (verified with `jose.jwtVerify`), generated claims, NumericDate
   coercion, cache reuse/re-sign/no-exp, key mismatch.
2. **Key-only PEM keystores.** `loadPem` accepts a key without a certificate; `selectAlias`
   refuses it unless asked for a signing key; TLS identity and WS-Security keep requiring a
   certificate. Tests.
3. **Model, schema and send path.** `JwtAuth` in the model and zod (`authConfigSchema` only),
   `SendAuth` jwt arm, `applyAuth`, gRPC metadata, `reportedAuth`, `secretNeedsOfAuth`,
   `missingSecretRef`, exporters, `authFor` (expand, load key, sign through the run's source),
   `SendHost.jwts`, refused-token drop, keystore needs in `secrets list`. Regenerate the published
   schemas. Engine tests including a REST run against the test server, and a CLI send test.
4. **Desktop.** Wire schema, auth editor fields (keystore picker reuse), labels, redaction,
   placeholder auth, header preview, code generation signed now, keystore-removal cleanup, the
   app's JWT source. Unit tests for main-process pieces.
5. **Docs and changelog.** Auth docs page section, CHANGELOG under [Unreleased].
