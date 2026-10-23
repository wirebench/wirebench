/**
 * Where a plugin's brokered exchanges are recorded (phase 7 spec §8): `history/plugin-<id>.jsonl` in
 * the history folder the desktop and the CLI already share, one redacted record per line, no bodies.
 * A file past {@link PLUGIN_HISTORY_BYTES} keeps its newer half.
 */
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PluginNetRecord } from './net.js';

export const PLUGIN_HISTORY_BYTES = 10 * 1024 * 1024;

export const pluginHistoryFile = (historyDir: string, plugin: string): string =>
  join(historyDir, `plugin-${plugin}.jsonl`);

/** Appends one record; a failure to write never fails the plugin's call. */
export async function appendPluginNetRecord(historyDir: string, record: PluginNetRecord): Promise<void> {
  const file = pluginHistoryFile(historyDir, record.plugin);
  try {
    await mkdir(historyDir, { recursive: true });
    await appendFile(file, `${JSON.stringify(record)}\n`);
    if ((await stat(file)).size <= PLUGIN_HISTORY_BYTES) return;
    const lines = (await readFile(file, 'utf8')).split('\n').filter((line) => line !== '');
    const temp = `${file}.tmp`;
    await writeFile(temp, `${lines.slice(Math.floor(lines.length / 2)).join('\n')}\n`);
    await rename(temp, file);
  } catch {
    // History is a record, not a gate.
  }
}
