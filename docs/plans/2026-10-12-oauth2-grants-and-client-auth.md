# More OAuth 2 grants and client authentication — plan

Spec: `docs/specs/2026-10-12-oauth2-grants-and-client-auth-design.md` · issue #338.

Each task is test-first and gets its own commit once
`NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 pnpm check` is green.

1. **JWT signer.** Add `http/auth/jwt-sign.ts` with `signJwt`, `defaultAlgFor` and `JwtAlg`, and
   export them from the engine index. Tests verify each algorithm with `crypto.verify`, check the
   JOSE ES form, and check that unsupported keys are refused.
2. **Model and schema.** Add the new `OAuth2Auth` fields and enum values, and extend
   `authConfigWireSchema` to match. `secretNeedsOfAuth` gains the password and browser-grant
   refresh tokens. Add an `oauth2KeystoreNeeds` helper and wire it into the REST, SOAP, gRPC and
   WebSocket `secretNeeds`. Regenerate the schemas. Tests: round trip, refusing secret values, and
   the needs.
3. **Grants, assertions and device flow (pure).** In `oauth2.ts`, add the password and device-code
   grants, `clientAssertion`, the JWT and TLS client auth methods, and the device authorization
   request, response and poll. Unit tests.
4. **Run token source.** Add the refresh order, the password grant, refresh from the environment
   for browser grants, the key-based client auth through `identityFor`, and the tls-client-auth
   identity. Add `test/helpers/test-oauth-server.ts` and integration tests through `runRequests`.
5. **CLI.** Add a CLI test that `wirebench run` uses the password grant and then the refresh grant
   headless, and that `secrets list` names the password and refresh token variables.
6. **Desktop main.** In `OAuth2Service`, add password, the device flow with its pending details,
   JWT and TLS client auth through `identityFor`, and refresh for the new grants. Extend the status
   wire with `device`, and resolve the password in `credentialsOf` and the send host. Tests.
7. **Desktop renderer.** Add the new fields to the auth editor and the device-code panel to
   `oauth2-status.tsx`. jsdom tests.
8. **Import and export.** Map Postman, OpenAPI and OpenCollection password and device flows in
   both directions. Tests.
9. **Docs.** Update the docs-site auth guide and the CHANGELOG `[Unreleased]` entry.
