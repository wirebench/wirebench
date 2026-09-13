/**
 * Test-only entry point for `@wirebench/engine/test-helpers`. Re-exports the fixtures used by
 * both the engine's own integration tests and, via the package's `test-helpers` export
 * subpath, the desktop app's e2e suite (`e2e/helpers/test-server.ts`) and its main-process
 * tests. Never import this from production code.
 *
 * The subpath stays even though it points outside `src/`: `@wirebench/engine` is a private
 * workspace package that is never packed or published, so nothing ever resolves this export
 * from a tarball. Moving these files under `src/` to make a tarball correct would instead put
 * `vitest` imports into the built `dist/` — a real cost for a hypothetical one.
 */
export {
  startTestSoapServer,
  type TestSoapServer,
  type TestSoapServerTls,
  type RecordedRequest,
} from './test-soap-server.js';
export {
  startTestRestServer,
  type TestRestServer,
  type TestRestServerOptions,
  type TestRestServerTls,
  type RecordedRestRequest,
} from './test-rest-server.js';
export { startTestProxy, type ProxiedRequest, type TestProxy, type TestProxyOptions } from './test-proxy.js';
export { secureResponse, type TestWssMode, type TestWssOptions } from './wss-responses.js';
export {
  generateTestCa,
  generateServerCert,
  generateClientCert,
  generateClientPkcs12,
  generateSigningCert,
  generateUntrustedCert,
  type TestCertificate,
} from './test-certs.js';
export {
  createNtlmAuthenticator,
  startNtlmServer,
  verifyType3,
  type NtlmAccount,
  type NtlmServer,
  type NtlmServerOptions,
} from './ntlm-server.js';
export { SOURCE_SNIPPET_CASES, type SourceSnippetCase } from './source-snippet-cases.js';
export { readCraftedFixture, readFixtureWsdl, readPublicFixture } from './fixtures.js';
