/**
 * Secret resolution lives in the engine so the CLI runner resolves credentials exactly as the app
 * does. This module stays as the desktop's import path for it.
 */
export { resolveAuthConfig, resolveEndpointAuth, secretMissingMessage } from '@wirebench/engine';
export type { ResolvedAuth } from '@wirebench/engine';
