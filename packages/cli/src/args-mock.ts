/**
 * `wirebench mock <path> [mock…]` (#61, docs/specs/2026-10-08-headless-mock-design.md): serve a
 * project's mocks until stopped.
 */
import { refuseForeign } from './args-ops.js';
import type { OptionValues } from './args-ops.js';
import { UsageError } from './usage-error.js';

export interface MockArgs {
  readonly command: 'mock';
  readonly path: string;
  /** Mock names, folder slugs or ids. Empty: every mock in the project. */
  readonly mocks: readonly string[];
  /** Overrides the one selected mock's port; 0 is any free port. */
  readonly port?: number;
  /** As typed; absent means `WIREBENCH_MOCK_HOST`, else loopback. */
  readonly host?: string;
  readonly json: boolean;
  readonly quiet: boolean;
}

const USAGE = 'wirebench mock <path> [mock…] [--port <n>] [--host <addr>] [--json] [-q]';

const MOCK_FLAGS = ['port', 'host', 'json', 'quiet'];

export const MOCK_HELP = `${USAGE}

Serves the project's mocks until stopped (SIGINT or SIGTERM, exit 0).
<path>                 The project directory (wirebench.yaml).
[mock…]                Mocks by name, folder slug or id. None = every mock in the project.
--port <n>             Listen on this port instead of the mock's own; one mock only. 0 = any free port.
--host <addr>          The address to listen on. Default: WIREBENCH_MOCK_HOST, else 127.0.0.1. The
                       container image sets WIREBENCH_MOCK_HOST=0.0.0.0.
--json                 One JSON object per line: a "listening" line per mock, an "exchange" line per request.
-q, --quiet            Only the listening lines.
stdout carries the listening lines and the request log; warnings and errors go to stderr.
Exit 2 for a usage error, an unknown mock or a project that does not load; 3 when a mock does not start.`;

/** @throws UsageError */
export function parseMock(rest: readonly string[], values: OptionValues): MockArgs {
  refuseForeign(values, MOCK_FLAGS, 'wirebench mock');
  const [path, ...mocks] = rest;
  if (path === undefined) {
    throw new UsageError(`${USAGE}: <path> is required`);
  }
  const rawPort = values['port'];
  let port: number | undefined;
  if (typeof rawPort === 'string') {
    port = Number(rawPort);
    if (rawPort.trim() === '' || !Number.isInteger(port) || port < 0 || port > 65535) {
      throw new UsageError(`--port must be a port from 0 to 65535, got "${rawPort}"`);
    }
  }
  const host = values['host'];
  if (typeof host === 'string' && host.trim() === '') {
    throw new UsageError('--host needs an address');
  }
  return {
    command: 'mock',
    path,
    mocks,
    ...(port !== undefined ? { port } : {}),
    ...(typeof host === 'string' ? { host: host.trim() } : {}),
    json: values['json'] === true,
    quiet: values['quiet'] === true,
  };
}
