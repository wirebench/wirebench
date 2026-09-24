import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Where a command reads its environment and writes its output; tests pass fakes. */
export interface ServerIo {
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
  readonly env: NodeJS.ProcessEnv;
}

/** Host spec §3.1, §3.4, §3.8: 0 ok, 1 migrations pending, 2 configuration or usage, 3 migration failed. */
export const ExitCode = { Ok: 0, Pending: 1, Config: 2, Migration: 3 } as const;

export function packageVersion(): string {
  const { version } = require('../package.json') as { readonly version: string };
  return version;
}
