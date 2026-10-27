// @vitest-environment node
/**
 * The last fetched head's settings under `server/state.yaml` (phase 4 spec §6.2): the team feature
 * policy is kept beside the recording flags and read without touching the file.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRecordingFlags } from '../../src/sync/server-state.js';

/** The file `ServerState` keeps under `server/`; not exported, the reader is. */
const STATE_FILE = 'state.yaml';

describe('readRecordingFlags', () => {
  it('reads the policy list with the recording flags, and reads nothing as nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wirebench-state-flags-'));
    expect(await readRecordingFlags(dir)).toEqual({ desktopActivity: false, sessionLogs: false, disabledFeatures: [] });
    await writeFile(
      join(dir, STATE_FILE),
      'version: 1\nbase:\n  head: null\nrecordSessionLogs: true\ndisabledFeatures: [scripts, grpc]\n',
    );
    expect(await readRecordingFlags(dir)).toEqual({
      desktopActivity: false,
      sessionLogs: true,
      disabledFeatures: ['scripts', 'grpc'],
    });
  });
});
