/**
 * `wirebench plugin install | list | remove` (phase 7 spec §6, ADR-0031). Install reads the plugin
 * into memory, shows what it contributes and which origins it may reach, and writes only after a
 * yes: an interactive one, or `--yes`.
 */
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import {
  installedManifest,
  installStaged,
  isWirebenchError,
  loadInstalledPlugins,
  readPluginLock,
  removePlugin,
  stagePlugin,
} from '@wirebench/engine';
import type { PluginManifestData } from '@wirebench/engine';
import type { PluginArgs } from '../args-plugin.js';
import { ExitCode } from '../exit-codes.js';
import type { CliIo } from '../main.js';
import { defaultUserDataDir } from '../ops/paths.js';

const originsOf = (manifest: PluginManifestData): readonly string[] => manifest.capabilities?.network ?? [];

/** What the person is asked about: the plugin, each contribution, its origins, and what a reinstall changes. */
export function describeInstall(manifest: PluginManifestData, previous: PluginManifestData | undefined): string {
  const lines = [`${manifest.name} (${manifest.id}) ${manifest.version}`];
  for (const importer of manifest.contributes.importers ?? [])
    lines.push(`  importer        ${manifest.id}/${importer.id}  ${importer.title}`);
  for (const reporter of manifest.contributes.reporters ?? [])
    lines.push(`  reporter        ${manifest.id}/${reporter.id}  ${reporter.title}`);
  for (const generator of manifest.contributes.codeGenerators ?? []) {
    lines.push(`  code generator  ${manifest.id}/${generator.id}  ${generator.title}`);
  }
  const origins = originsOf(manifest);
  lines.push(origins.length > 0 ? `  network         ${origins.join(', ')}` : '  network         none');
  if (previous !== undefined) {
    lines.push(`Replaces ${previous.id} ${previous.version}.`);
    const before = originsOf(previous);
    if (before.join(',') !== origins.join(',')) {
      lines.push(`  network before  ${before.length > 0 ? before.join(', ') : 'none'}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

async function confirm(io: CliIo, question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: io.stderr });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export async function pluginCommand(args: PluginArgs, io: CliIo): Promise<ExitCode> {
  const userData = defaultUserDataDir(process.platform, io.env, homedir());
  try {
    if (args.command === 'plugin-list') {
      const lock = readPluginLock(userData);
      const { plugins, problems } = loadInstalledPlugins(userData);
      if (plugins.length === 0 && problems.length === 0) {
        io.stdout.write('No plugins are installed.\n');
        return ExitCode.Ok;
      }
      for (const plugin of plugins) {
        const { manifest } = plugin;
        const origins = originsOf(manifest);
        io.stdout.write(
          `${manifest.id} ${manifest.version}  ${manifest.name}  installed ${lock.plugins[manifest.id]?.installedAt ?? '?'}${origins.length > 0 ? `  network: ${origins.join(', ')}` : ''}\n`,
        );
      }
      for (const problem of problems) io.stdout.write(`${problem.id}  skipped (${problem.code}): ${problem.message}\n`);
      return ExitCode.Ok;
    }
    if (args.command === 'plugin-remove') {
      await removePlugin(userData, args.id);
      io.stdout.write(`Removed ${args.id}. It is gone the next time Wirebench starts.\n`);
      return ExitCode.Ok;
    }
    const staged = await stagePlugin(args.source);
    io.stderr.write(describeInstall(staged.manifest, installedManifest(userData, staged.manifest.id)));
    if (!args.yes) {
      if (process.stdin.isTTY !== true) {
        io.stderr.write('wirebench plugin install asks before it installs; pass --yes when not in a terminal\n');
        return ExitCode.Usage;
      }
      if (!(await confirm(io, 'Install it? [y/N] '))) {
        io.stderr.write('Not installed.\n');
        return ExitCode.Usage;
      }
    }
    await installStaged(userData, staged);
    io.stdout.write(
      `Installed ${staged.manifest.id} ${staged.manifest.version}. It loads the next time Wirebench starts.\n`,
    );
    return ExitCode.Ok;
  } catch (error) {
    if (isWirebenchError(error)) {
      io.stderr.write(`${error.code}: ${error.message}\n`);
      return error.code.startsWith('plugin-') ? ExitCode.Usage : ExitCode.RunError;
    }
    throw error;
  }
}
