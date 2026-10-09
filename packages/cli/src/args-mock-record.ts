/**
 * `wirebench mock record` (#60, `docs/specs/2026-10-08-mock-recording-design.md` §CLI): its options,
 * help and parsing, kept apart from the other verbs so the `mock` verb's serving command (#61) can
 * sit beside it.
 */
import type { OptionValues } from './args-ops.js';
import { refuseOpOnly } from './args-ops.js';
import { UsageError } from './usage-error.js';

/** The options only `mock record` takes; `--insecure` it shares with `run`. */
export const MOCK_RECORD_OPTIONS = {
  target: { type: 'string' },
  from: { type: 'string' },
  port: { type: 'string' },
  host: { type: 'string' },
  replace: { type: 'boolean' },
  'no-dedupe': { type: 'boolean' },
} as const;

const MOCK_RECORD_ONLY_FLAGS: readonly string[] = Object.keys(MOCK_RECORD_OPTIONS);

const USAGE = 'wirebench mock record <path> <mock> --target <url>';

export const MOCK_RECORD_HELP = `${USAGE} [--from <interface|api>] [--port <n>] [--host <addr>]
                      [--replace] [--no-dedupe] [--insecure]

Passes requests through to <url> and keeps each response that reaches a contract operation as a
stub of <mock>. Point a client at the printed address instead of the real system. Ctrl-C stops the
recording and saves the stubs as response files under mocks/.

<path>                 The project directory (wirebench.yaml).
<mock>                 A mock's name or slug.
--target <url>         The real system, http or https. The mock's path maps onto its path.
--from <name>          When no mock is called <mock>, generate one with no stubs from this
                       interface or API (name or slug).
--port <n>             Listen on this port instead of the mock's own (0: any free port).
--host <addr>          Listen on this address instead of 127.0.0.1.
--replace              An operation that gets a recording loses its other responses.
--no-dedupe            Keep a recording equal to a response the operation already has.
--insecure             Skip TLS verification of the target.

Requests are never saved. Responses are masked before they are kept: credential headers, secret
keys in JSON and form bodies, WS-Security passwords and tokens, and every WIREBENCH_SECRET_* value.
The upstream proxy comes from HTTPS_PROXY, HTTP_PROXY and NO_PROXY.`;

export interface MockRecordArgs {
  readonly command: 'mock-record';
  readonly path: string;
  readonly mock: string;
  readonly target: string;
  readonly from?: string;
  readonly port?: number;
  readonly host?: string;
  readonly replace: boolean;
  readonly dedupe: boolean;
  readonly insecure: boolean;
}

/** Refuses `mock record`'s own flags on another verb, as `refuseOpOnly` does for the op flags. */
export function refuseMockRecordOnly(values: OptionValues, verb: string): void {
  for (const key of MOCK_RECORD_ONLY_FLAGS) {
    if (values[key] !== undefined) {
      throw new UsageError(`--${key} does not apply to ${verb}`);
    }
  }
}

function str(values: OptionValues, key: string): string | undefined {
  const value = values[key];
  return typeof value === 'string' ? value : undefined;
}

/** Parses `mock <sub> …` after the verb; `record` is the only subcommand so far. */
export function parseMock(rest: readonly string[], values: OptionValues): MockRecordArgs {
  const [sub, path, mock, ...extra] = rest;
  if (sub !== 'record') {
    throw new UsageError(`${USAGE}: unknown subcommand "${sub ?? ''}"`);
  }
  refuseOpOnly(values, 'wirebench mock record');
  if (path === undefined || mock === undefined) {
    throw new UsageError(`${USAGE}: <path> and <mock> are required`);
  }
  if (extra.length > 0) {
    throw new UsageError(`${USAGE}: unexpected "${extra.join(' ')}"`);
  }
  const target = str(values, 'target');
  if (target === undefined) {
    throw new UsageError(`${USAGE}: --target is required`);
  }
  const rawPort = str(values, 'port');
  let port: number | undefined;
  if (rawPort !== undefined) {
    port = Number(rawPort);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new UsageError(`--port must be an integer from 0 to 65535, got "${rawPort}"`);
    }
  }
  const from = str(values, 'from');
  const host = str(values, 'host');
  return {
    command: 'mock-record',
    path,
    mock,
    target,
    ...(from !== undefined ? { from } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(host !== undefined ? { host } : {}),
    replace: values['replace'] === true,
    dedupe: values['no-dedupe'] !== true,
    insecure: values['insecure'] === true,
  };
}
