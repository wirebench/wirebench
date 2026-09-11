/**
 * Test-only entry point for `@wirebench/engine/test-helpers`. Re-exports the fixtures used by
 * both the engine's own integration tests and, via the package's `test-helpers` export
 * subpath, the desktop app's e2e suite (`e2e/helpers/test-server.ts`). Never import this from
 * production code.
 */
export {
  startTestSoapServer,
  type TestSoapServer,
  type TestSoapServerTls,
  type RecordedRequest,
} from './test-soap-server.js';
export {
  generateTestCa,
  generateServerCert,
  generateClientCert,
  generateClientPkcs12,
  generateSigningCert,
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
export { readPublicFixture } from './fixtures.js';
