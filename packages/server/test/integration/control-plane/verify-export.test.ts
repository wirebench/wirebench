/**
 * Slice 7 Task 21 (hosted edition spec §22.9, §13 criterion 6): `wirebench-server admin audit verify --export <file>`
 * verifies an export's audit chain with no database: a fresh export is intact, and one byte edited in
 * `audit_events.ndjson` breaks it, naming the event.
 */
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readTarGz, writeTarGz, type TarSource } from '../../../src/control-plane/export/tar.js';
import { main } from '../../../src/main.js';
import { describeDb } from '../../helpers/database.js';
import { describeGit, mkTempDir, removeTempDir } from '../../helpers/git.js';
import { exportFixture, type ExportFixture } from './export-fixture.js';

/** Each suite's set-up builds servers and repositories: under load that is past the 10 s default. */
const SETUP_MS = 120_000;

/** `main` with no database in the environment at all: the verify reads the file only. */
async function verify(...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(['admin', 'audit', 'verify', ...args], {
    stdout: { write: (text: string) => out.push(text) },
    stderr: { write: (text: string) => err.push(text) },
    env: {},
  });
  return { code, stdout: out.join(''), stderr: err.join('') };
}

describeDb('admin audit verify --export (spec §22.9)', () => {
  describeGit('an export', () => {
    let x: ExportFixture;
    let dir: string;
    let file: string;
    beforeEach(async () => {
      x = await exportFixture();
      dir = await mkTempDir('wbs-verify-');
      const runner = x.runner();
      const queued = await runner.request(x.scope, 'operator');
      await runner.runNext(x.scope);
      file = runner.path(x.scope, queued.id);
    }, SETUP_MS);
    afterEach(async () => {
      await x.f.h.close();
      await removeTempDir(dir);
    }, SETUP_MS);

    it('verifies a fresh export with no database', async () => {
      const result = await verify('--export', file);
      expect(result).toMatchObject({ code: 0, stderr: '' });
      expect(result.stdout).toMatch(/checked [1-9]\d* sealed rows, seq 1 to \d+; 0 unsealed\nintact\n/);
      const json = await verify('--export', file, '--json');
      expect(JSON.parse(json.stdout)).toMatchObject({ result: 'intact', unsealed: 0 });
    });

    it('names the event one edited byte breaks', async () => {
      const events = await x.f.h.tdb.query<{ id: string; seq: string }>(
        "select id, chain_seq::text as seq from audit_events where details ->> 'note' = 'zoë ü'",
      );
      const { id, seq } = events.rows[0]!;
      const sources: TarSource[] = [];
      for await (const entry of readTarGz(file)) {
        const data = await entry.buffer();
        sources.push({
          name: entry.name,
          data:
            entry.name === 'tables/audit_events.ndjson'
              ? Buffer.from(data.toString('utf8').replace('zoë ü', 'zoë u'))
              : data,
        });
      }
      const edited = join(dir, 'edited.tar.gz');
      await writeTarGz(edited, sources);
      const result = await verify('--export', edited);
      expect(result.code).toBe(1);
      expect(result.stdout).toContain(`broken: edited at seq ${seq} (row ${id})`);
      expect(result.stdout).toContain("does not match the manifest's checksum");
    });

    it('refuses --export with --tenant, which names no file', async () => {
      const result = await verify('--export', file, '--tenant', 'acme');
      expect(result.code).toBe(2);
    });
  });
});
