import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** The CLI's own version, read from its `package.json`. */
export function cliVersion(): string {
  return (require('../package.json') as { readonly version: string }).version;
}
