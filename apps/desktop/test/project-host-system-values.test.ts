// @vitest-environment node
/**
 * The desktop builds some scopes itself rather than through a send's run context: a WebSocket
 * message pushed with `expand: true` (`request.wsSend`) and a sequence step's callback assertions
 * (`sequence-runner.ts`) both expand against `ProjectHost.scopesFor`. A `${#System#…}` value they
 * expand is recorded for the session like a resolved secret, so the log, the frame and a failure
 * message mask it (#181). A short value is not.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expand } from '@wirebench/engine';
import { DialogPicks } from '../src/main/dialog-picks.js';
import { EngineService } from '../src/main/engine-service.js';
import { ProjectHost } from '../src/main/project-host.js';
import { containsRecordedSecret } from '../src/main/redact.js';

const NAMES = ['WB_HOST_181_PUSH', 'WB_HOST_181_CALLBACK', 'WB_HOST_181_NONE', 'WB_HOST_181_SHORT'] as const;
const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));

let dir: string;
let host: ProjectHost;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wirebench-host-system-'));
  host = new ProjectHost(new EngineService(), {}, undefined, undefined, undefined, undefined, new DialogPicks());
  process.env['WB_HOST_181_PUSH'] = 'pushed-system-value-181';
  process.env['WB_HOST_181_CALLBACK'] = 'callback-system-value-181';
  process.env['WB_HOST_181_NONE'] = 'no-project-system-value-181';
  process.env['WB_HOST_181_SHORT'] = 'hst7chr';
});

afterEach(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('ProjectHost.scopesFor and ${#System#…} values', () => {
  it('records a value a pushed WebSocket message expands, but not a short one', async () => {
    await host.create({ dir: join(dir, 'project'), name: 'Push' });
    expect(containsRecordedSecret('pushed-system-value-181')).toBe(false);
    const text = expand(
      '{"t":"${#System#WB_HOST_181_PUSH}","s":"${#System#WB_HOST_181_SHORT}"}',
      host.scopesFor(),
    ).text;
    expect(text).toBe('{"t":"pushed-system-value-181","s":"hst7chr"}');
    expect(containsRecordedSecret('pushed-system-value-181')).toBe(true);
    expect(containsRecordedSecret('hst7chr')).toBe(false);
  });

  it('records a value a sequence step callback assertion expands, with the Sequence scope laid over', async () => {
    await host.create({ dir: join(dir, 'project'), name: 'Callback' });
    const scopes = { ...host.scopesFor(), sequence: { id: 'from-a-response' } };
    expect(expand('${#System#WB_HOST_181_CALLBACK}/${#Sequence#id}', scopes).text).toBe(
      'callback-system-value-181/from-a-response',
    );
    expect(containsRecordedSecret('callback-system-value-181')).toBe(true);
  });

  it('records one with no project open too', () => {
    expand('${#System#WB_HOST_181_NONE}', host.scopesFor());
    expect(containsRecordedSecret('no-project-system-value-181')).toBe(true);
  });
});
