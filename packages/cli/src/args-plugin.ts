/**
 * `wirebench plugin install | list | remove` (phase 7 spec §6, ADR-0031): its help and parsing. A
 * plugin goes into the per-user folder the desktop shares, and only by this verb or the app's
 * Settings → Plugins.
 */
import { parseArgs } from 'node:util';
import { UsageError } from './usage-error.js';

export const PLUGIN_HELP = `wirebench plugin install <folder | file.tgz> [--yes]
wirebench plugin list
wirebench plugin remove <id>

Installs, lists and removes the plugins this user's Wirebench loads: importers, reporters and code
generators that run in the script sandbox (ADR-0031). They live in the app's data folder, plugins/,
shared with the desktop app; a project can never bring or enable one. A change applies the next
time Wirebench or a wirebench command starts.

install                Reads the plugin, shows what it contributes and which origins it may
                       reach, and asks before it writes anything. Replacing an installed plugin
                       shows the old and the new origins.
  --yes, -y            Install without asking. Needed when not run in a terminal.
list                   Every installed plugin, its version and origins, and why one is skipped.
remove <id>            Removes the plugin and its record.

Exit 0 when done, 2 for a usage problem or a plugin that is refused or cannot be read.`;

export type PluginArgs =
  | { readonly command: 'plugin-install'; readonly source: string; readonly yes: boolean }
  | { readonly command: 'plugin-list' }
  | { readonly command: 'plugin-remove'; readonly id: string };

export function parsePlugin(
  argv: readonly string[],
): PluginArgs | { readonly command: 'help'; readonly topic: 'plugin' } {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: { yes: { type: 'boolean', short: 'y' }, help: { type: 'boolean', short: 'h' } },
    });
  } catch (error) {
    if (error instanceof TypeError) throw new UsageError(error.message);
    throw error;
  }
  const { values, positionals } = parsed;
  if (values.help === true) return { command: 'help', topic: 'plugin' };
  const [sub, target, ...extra] = positionals;
  if (extra.length > 0) throw new UsageError(`wirebench plugin ${sub ?? ''}: unexpected "${extra.join(' ')}"`);
  if (sub === 'install') {
    if (target === undefined)
      throw new UsageError('wirebench plugin install <folder | file.tgz>: the path is required');
    return { command: 'plugin-install', source: target, yes: values.yes === true };
  }
  if (values.yes === true) throw new UsageError('--yes applies to wirebench plugin install only');
  if (sub === 'list') {
    if (target !== undefined) throw new UsageError(`wirebench plugin list takes no argument, got "${target}"`);
    return { command: 'plugin-list' };
  }
  if (sub === 'remove') {
    if (target === undefined) throw new UsageError('wirebench plugin remove <id>: the id is required');
    return { command: 'plugin-remove', id: target };
  }
  throw new UsageError(`wirebench plugin install | list | remove: unknown subcommand "${sub ?? ''}"`);
}
