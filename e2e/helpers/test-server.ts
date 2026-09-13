/**
 * Re-exports the engine's in-process test SOAP server for e2e specs. Imported via the
 * `@wirebench/engine/test-helpers` package export subpath (see `packages/engine/package.json`)
 * rather than a deep relative path, so the dependency on the engine's test fixtures is explicit
 * and versioned like any other workspace dependency. Test-only: never imported from the
 * desktop app itself.
 */
export { startTestSoapServer, type TestSoapServer } from '@wirebench/engine/test-helpers';
export { startTestRestServer, type TestRestServer, type TestRestServerDocument } from '@wirebench/engine/test-helpers';
