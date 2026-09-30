// packages/cli/test/unit/ops/history.test.ts
import { join } from 'node:path';
import { appendHistory } from '@wirebench/engine';
import type { HistoryEntry } from '@wirebench/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { runOp } from '../../../src/ops/context.js';
import { historyDiffOp, historyItemOf, historyListOp, MAX_DIFF_CHARS } from '../../../src/ops/history.js';
import { sendOp } from '../../../src/ops/send.js';
import { addEnvironment, emptyProject, removeTempDirs, restItem, restProject, SECRET, startServer } from './helpers.js';
import type { Fixture, TestServer } from './helpers.js';

let pets: TestServer | undefined;

afterEach(async () => {
  await pets?.close();
  pets = undefined;
  await removeTempDirs();
});

/** A REST project whose `GET /pets` answers with a counter, sent twice. */
async function sentTwice(): Promise<{ fixture: Fixture; ids: string[]; item: string }> {
  const fixture = await restProject();
  let seen = 0;
  pets = await startServer(() => {
    seen += 1;
    return {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ id: 1, name: 'Rex', seen }]),
    };
  });
  await addEnvironment(fixture.dir, 'local', { Pets: pets.url });
  const item = await restItem(fixture.dir, 'GET', '/pets');
  const ids: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    const sent = await runOp(sendOp, { item, environment: 'local' }, fixture.base());
    ids.push(sent.historyId ?? '');
  }
  return { fixture, ids, item };
}

describe('op history_list', () => {
  it('lists the newest sends first, with the item path send takes', async () => {
    const { fixture, ids, item } = await sentTwice();
    const result = await runOp(historyListOp, {}, fixture.base());

    expect(result.total).toBe(2);
    expect(result.entries.map((row) => row.id)).toEqual([...ids].reverse());
    expect(result.entries[0]).toMatchObject({
      item,
      kind: 'rest',
      method: 'GET',
      status: 200,
      ok: true,
      tags: ['mcp'],
    });
  });

  it('filters by item, limits, and refuses a limit out of range', async () => {
    const { fixture } = await sentTwice();
    expect((await runOp(historyListOp, { item: 'pets' }, fixture.base())).total).toBe(2);
    expect((await runOp(historyListOp, { item: 'Calculator' }, fixture.base())).entries).toEqual([]);
    const one = await runOp(historyListOp, { limit: 1 }, fixture.base());
    expect(one).toMatchObject({ total: 2 });
    expect(one.entries).toHaveLength(1);
    await expect(runOp(historyListOp, { limit: 201 }, fixture.base())).rejects.toMatchObject({ code: 'invalid-input' });
  });

  it('lists nothing for a project with no History file yet', async () => {
    const fixture = await restProject();
    expect(await runOp(historyListOp, {}, fixture.base())).toEqual({ entries: [], total: 0 });
  });
});

/** A SOAP entry as the desktop writes one: no `kind`, no `tags`. */
function desktopEntry(index: number, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: `01KD${String(index).padStart(22, '0')}`,
    at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    projectId: 'mcp-fixture',
    requestName: 'Request 1',
    interfaceName: 'CalculatorService',
    operationName: 'Add',
    endpoint: 'http://127.0.0.1:9/calculator',
    soapVersion: '1.1',
    status: 200,
    durationMs: 3,
    ok: true,
    sizeBytes: 0,
    request: { envelopeXml: '<Envelope/>', headers: [] },
    response: { envelopeXml: '<Envelope/>', rawHeaders: [], status: 200, statusText: 'OK' },
    ...overrides,
  };
}

describe('historyItemOf', () => {
  it('joins a nested REST folder chain into the path send takes', () => {
    const entry = desktopEntry(1, {
      kind: 'rest',
      interfaceName: 'Pets',
      operationName: 'Admin / Owners / Archive',
      requestName: 'List',
    });
    expect(historyItemOf(entry)).toBe('Pets/Admin/Owners/Archive/List');
    expect(historyItemOf({ ...entry, operationName: '' })).toBe('Pets/List');
  });

  it('keeps a SOAP operation one segment, whatever its name holds, with or without a kind', () => {
    expect(historyItemOf(desktopEntry(1))).toBe('CalculatorService/Add/Request 1');
    expect(historyItemOf(desktopEntry(1, { kind: 'soap', operationName: 'Add / Sub' }))).toBe(
      'CalculatorService/Add / Sub/Request 1',
    );
  });
});

describe('op history_list over entries the desktop wrote', () => {
  it('lists an entry with no tags or kind as SOAP, without tags', async () => {
    const fixture = await emptyProject();
    await appendHistory(join(fixture.historyDir, 'mcp-fixture.jsonl'), desktopEntry(1));

    const result = await runOp(historyListOp, {}, fixture.base());

    expect(result.total).toBe(1);
    expect(result.entries[0]).toEqual({
      id: desktopEntry(1).id,
      at: desktopEntry(1).at,
      item: 'CalculatorService/Add/Request 1',
      kind: 'soap',
      status: 200,
      ok: true,
      durationMs: 3,
    });
  });

  it('lists 20 entries by default, and takes a limit of 200', async () => {
    const fixture = await emptyProject();
    const file = join(fixture.historyDir, 'mcp-fixture.jsonl');
    for (let index = 0; index < 25; index += 1) {
      await appendHistory(file, desktopEntry(index));
    }

    const byDefault = await runOp(historyListOp, {}, fixture.base());
    expect(byDefault.total).toBe(25);
    expect(byDefault.entries).toHaveLength(20);
    expect(byDefault.entries[0]?.id).toBe(desktopEntry(24).id);

    const most = await runOp(historyListOp, { limit: 200 }, fixture.base());
    expect(most.entries).toHaveLength(25);
  });
});

describe('op history_diff', () => {
  it('diffs two responses semantically, and ignores the paths it is given', async () => {
    const { fixture, ids } = await sentTwice();
    const [from = '', to = ''] = ids;

    const diff = await runOp(historyDiffOp, { from, to }, fixture.base());
    expect(diff).toMatchObject({ format: 'json', ignored: 0, from: { id: from, status: 200 }, to: { id: to } });
    expect(diff.changes).toEqual([{ kind: 'changed', path: '/0/seen', expected: '1', actual: '2' }]);

    const ignored = await runOp(historyDiffOp, { from, to, ignore: ['/0/seen'] }, fixture.base());
    expect(ignored).toMatchObject({ changes: [], ignored: 1 });
  });

  it('refuses an unknown id and an entry with no response', async () => {
    const { fixture, ids } = await sentTwice();
    const [from = ''] = ids;
    await appendHistory(join(fixture.historyDir, 'mcp-fixture.jsonl'), {
      id: '01KZZZZZZZZZZZZZZZZZZZZZZZ',
      kind: 'rest',
      at: new Date().toISOString(),
      projectId: 'mcp-fixture',
      requestName: 'Gone',
      interfaceName: 'Pets',
      operationName: '',
      endpoint: 'http://127.0.0.1:9/pets',
      method: 'GET',
      soapVersion: 'none',
      durationMs: 1,
      ok: false,
      request: { envelopeXml: '', headers: [] },
      error: { code: 'connection-refused', message: 'refused' },
      sizeBytes: 0,
    });

    await expect(runOp(historyDiffOp, { from, to: 'nope' }, fixture.base())).rejects.toMatchObject({
      code: 'history-entry-not-found',
    });
    await expect(
      runOp(historyDiffOp, { from, to: '01KZZZZZZZZZZZZZZZZZZZZZZZ' }, fixture.base()),
    ).rejects.toMatchObject({ code: 'history-no-response' });
  });
});

/** A History entry as the desktop stores one, holding `body` unredacted as the response. */
async function appendResponse(
  fixture: Fixture,
  id: string,
  body: string,
  contentType = 'application/json',
  name = 'Pets',
): Promise<void> {
  const entry: HistoryEntry = {
    id,
    kind: 'rest',
    at: new Date().toISOString(),
    projectId: 'mcp-fixture',
    requestName: name,
    interfaceName: 'Pets',
    operationName: '',
    endpoint: 'http://127.0.0.1:9/pets',
    method: 'GET',
    soapVersion: 'none',
    status: 200,
    durationMs: 1,
    ok: true,
    request: { envelopeXml: '', headers: [] },
    response: { envelopeXml: body, rawHeaders: [['Content-Type', contentType]], status: 200, statusText: 'OK' },
    sizeBytes: body.length,
  };
  await appendHistory(join(fixture.historyDir, 'mcp-fixture.jsonl'), entry);
}

const ID_A = '01KZZZZZZZZZZZZZZZZZZZZZZA';
const ID_B = '01KZZZZZZZZZZZZZZZZZZZZZZB';

describe('history_diff redaction and bounds', () => {
  it('shows neither password when two JSON responses differ only in a password value', async () => {
    const fixture = await restProject();
    const other = 'zyx987wvu654tsr321';
    await appendResponse(fixture, ID_A, JSON.stringify({ user: 'rex', password: SECRET }));
    await appendResponse(fixture, ID_B, JSON.stringify({ user: 'rex', password: other }));

    const diff = await runOp(historyDiffOp, { from: ID_A, to: ID_B }, fixture.base());
    expect(diff.changes).toEqual([]);
    expect(JSON.stringify(diff)).not.toContain(SECRET);
    expect(JSON.stringify(diff)).not.toContain(other);
  });

  it('shows neither password when two XML responses differ only in a WS-Security password', async () => {
    const fixture = await restProject();
    const envelope = (password: string): string =>
      '<Envelope xmlns:wsse="urn:wsse"><Header><wsse:Security><wsse:Password>' +
      `${password}</wsse:Password></wsse:Security></Header><Body><n>1</n></Body></Envelope>`;
    const other = 'zyx987wvu654tsr321';
    await appendResponse(fixture, ID_A, envelope(SECRET), 'text/xml');
    await appendResponse(fixture, ID_B, envelope(other), 'text/xml');

    const diff = await runOp(historyDiffOp, { from: ID_A, to: ID_B }, fixture.base());
    expect(diff).toMatchObject({ format: 'xml', changes: [], truncated: false });
    expect(JSON.stringify(diff)).not.toContain(SECRET);
    expect(JSON.stringify(diff)).not.toContain(other);
  });

  it('masks a credential in a URL a changed value quotes, and in an item name', async () => {
    const fixture = await restProject();
    const link = (token: string): string => `http://host.example/next?token=${token}&page=2`;
    await appendResponse(fixture, ID_A, JSON.stringify({ next: link(SECRET) }), 'application/json', link(SECRET));
    await appendResponse(fixture, ID_B, JSON.stringify({ next: `${link(SECRET)}&x=1` }));

    const diff = await runOp(historyDiffOp, { from: ID_A, to: ID_B }, fixture.base());
    expect(diff.changes).toHaveLength(1);
    expect(JSON.stringify(diff)).not.toContain(SECRET);
    const list = await runOp(historyListOp, {}, fixture.base());
    expect(list.entries).toHaveLength(2);
    expect(JSON.stringify(list)).not.toContain(SECRET);
  });

  it('compares bodies of different kinds as text, and reports a body that does not parse', async () => {
    const fixture = await restProject();
    await appendResponse(fixture, ID_A, '{"a":1}');
    await appendResponse(fixture, ID_B, '<a>1</a>', 'text/xml');
    const mixed = await runOp(historyDiffOp, { from: ID_A, to: ID_B }, fixture.base());
    expect(mixed).toMatchObject({ format: 'text', changes: [{ kind: 'changed', path: '/' }] });
    expect(mixed.error).toBeUndefined();

    await appendResponse(fixture, '01KZZZZZZZZZZZZZZZZZZZZZZC', '{"a":', 'application/json');
    const broken = await runOp(historyDiffOp, { from: ID_A, to: '01KZZZZZZZZZZZZZZZZZZZZZZC' }, fixture.base());
    expect(broken.format).toBe('text');
    expect(broken.error).toEqual(expect.any(String));
  });

  it('cuts a large diff at the character budget and says so', async () => {
    const fixture = await restProject();
    const many = (letter: string): string => JSON.stringify(Array.from({ length: 1500 }, () => letter.repeat(300)));
    await appendResponse(fixture, ID_A, many('a'));
    await appendResponse(fixture, ID_B, many('b'));

    const diff = await runOp(historyDiffOp, { from: ID_A, to: ID_B }, fixture.base());
    const used = diff.changes.reduce(
      (sum, change) => sum + change.path.length + (change.expected?.length ?? 0) + (change.actual?.length ?? 0),
      0,
    );
    expect(diff.truncated).toBe(true);
    expect(diff.changes.length).toBeGreaterThan(0);
    expect(diff.changes.length).toBeLessThan(1500);
    expect(used).toBeLessThanOrEqual(MAX_DIFF_CHARS);
  });
});
