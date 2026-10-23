/**
 * Feature switches for one CLI process (feature switches phase 4 spec §5.1): `--features <list>` laid
 * over `WIREBENCH_FEATURES` per id, both in the `WIREBENCH_AREAS` grammar (`id=on|off`, comma
 * separated, case-insensitive, spaces trimmed). The CLI has no preferences file and no workspace
 * policy, so the parsed switches are the one level it resolves.
 */
import { builtinDescriptors, createBuiltinRegistry } from '@wirebench/engine';
import type { ProtocolRegistry } from '@wirebench/engine';
import { CLI_REPORTERS } from './reporters/builtins.js';
import { UsageError } from './usage-error.js';

/** The environment variable every verb reads. */
export const FEATURES_VARIABLE = 'WIREBENCH_FEATURES';

/** What `--features` adds to a parsed verb; present on every verb, so a pipeline can set it anywhere. */
export interface FeatureArgs {
  /** `--features <list>`, as typed. */
  readonly features?: string;
}

/** One `id=on|off` entry; `undefined` for a blank one, `null` for a malformed one. */
function parseEntry(entry: string): { readonly id: string; readonly on: boolean } | undefined | null {
  if (entry.trim() === '') return undefined;
  const [id, state, ...more] = entry.split('=').map((part) => part.trim().toLowerCase());
  if (id === undefined || id === '' || more.length > 0 || (state !== 'on' && state !== 'off')) return null;
  return { id, on: state === 'on' };
}

/**
 * The switches the flag and the variable name, the flag winning per id. A malformed flag entry is a
 * usage error; a malformed variable entry is ignored (the variable is set once for many commands
 * and must not break a verb that does not care). An id with no built-in descriptor is dropped
 * after one `unknown feature "x" ignored` warning, so a variable set for a newer version does not
 * break an older one.
 *
 * @throws UsageError for a flag entry that is not `id=on|off`
 */
export function parseFeatureSwitches(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
  warn: (line: string) => void,
): Record<string, boolean> {
  const switches: Record<string, boolean> = {};
  for (const entry of (env[FEATURES_VARIABLE] ?? '').split(',')) {
    const parsed = parseEntry(entry);
    if (parsed !== undefined && parsed !== null) switches[parsed.id] = parsed.on;
  }
  for (const entry of (flag ?? '').split(',')) {
    const parsed = parseEntry(entry);
    if (parsed === null) {
      throw new UsageError(`--features takes a comma-separated list of <id>=on|off, got "${entry.trim()}"`);
    }
    if (parsed !== undefined) switches[parsed.id] = parsed.on;
  }
  const known = new Set(builtinDescriptors().map((descriptor) => descriptor.id));
  for (const id of Object.keys(switches)) {
    if (!known.has(id)) {
      warn(`unknown feature "${id}" ignored`);
      delete switches[id];
    }
  }
  return switches;
}

/**
 * The registry a verb runs with: the built-in protocols and features, with `switches` applied (the
 * preference level; the CLI has no policy, so there is nothing else to resolve), and the CLI's own
 * reporters beside the engine's.
 */
export function registryFor(switches: Readonly<Record<string, boolean>>): ProtocolRegistry {
  return createBuiltinRegistry(switches, { reporters: CLI_REPORTERS });
}

/**
 * The registry for one verb's process, from its `--features` and the environment it runs in; each
 * unknown id is warned about on stderr, once.
 */
export function featuresFor(
  args: FeatureArgs,
  io: { readonly stderr: NodeJS.WritableStream; readonly env: NodeJS.ProcessEnv },
): ProtocolRegistry {
  return registryFor(parseFeatureSwitches(args.features, io.env, (line) => io.stderr.write(`warning: ${line}\n`)));
}
