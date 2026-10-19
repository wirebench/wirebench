/**
 * `wirebench scripts convert <path> [selector…] [--write]` (convert-imported-scripts spec §10): a
 * project's imported (layered) scripts rewritten to the typed API, previewed or written.
 */
import { refuseForeign } from './args-ops.js';
import type { OptionValues } from './args-ops.js';
import { UsageError } from './usage-error.js';

export interface ScriptsConvertArgs {
  readonly command: 'scripts-convert';
  readonly path: string;
  readonly selectors: readonly string[];
  /** `--write`: back up, switch and save; without it the conversion is only printed. */
  readonly write: boolean;
}

/** The options only `scripts convert` takes; every other verb refuses them. */
export const SCRIPTS_OPTIONS = {
  write: { type: 'boolean' },
} as const;

export const SCRIPTS_USAGE = 'wirebench scripts convert <path> [selector…] [--write]';

export const SCRIPTS_HELP = `${SCRIPTS_USAGE}

Rewrites the project's imported scripts (each level whose scripts run in a source client's dialect)
to the typed API. Without --write it prints, per level, its path, its dialect, a unified diff of
each phase and the TODOs left in the converted text, then a total. Nothing is written.

<path>                 One project directory (wirebench.yaml).
[selector…]            Paths below <path>, as for run: an API, an interface, a folder or a request,
                       by its display path or its path on disk. Each selects the levels at or below
                       it. None = every level with imported scripts.
--write                Back each phase's original text up under imported-scripts/, switch the level
                       to the typed API and save the project. A level that does not parse is listed
                       and skipped.
Exit 0 when done, whatever the TODO count; 2 for a usage error; 3 when the project cannot be loaded,
a backup cannot be written or the project cannot be saved.`;

/** `--write` belongs to `scripts convert` alone. */
export function refuseScriptsOnly(values: OptionValues, verb: string): void {
  if (values['write'] !== undefined) {
    throw new UsageError(`--write does not apply to ${verb}`);
  }
}

/** Parses what follows `wirebench scripts`. */
export function parseScripts(rest: readonly string[], values: OptionValues): ScriptsConvertArgs {
  const [sub, path, ...selectors] = rest;
  if (sub !== 'convert') {
    throw new UsageError(`${SCRIPTS_USAGE}: unknown subcommand "${sub ?? ''}"`);
  }
  refuseForeign(values, Object.keys(SCRIPTS_OPTIONS), 'wirebench scripts convert');
  if (path === undefined) {
    throw new UsageError(`${SCRIPTS_USAGE}: <path> is required`);
  }
  return { command: 'scripts-convert', path, selectors, write: values['write'] === true };
}
