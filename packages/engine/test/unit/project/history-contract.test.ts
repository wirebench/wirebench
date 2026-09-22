import { describe, expect, it } from 'vitest';
import { historyContractOf, openHistory } from '../../../src/project/history.js';
import type { HistoryEntry } from '../../../src/project/history.js';
import { MAX_CONTRACT_MESSAGE_LENGTH, MAX_CONTRACT_PROBLEMS } from '../../../src/rest/contract-check.js';
import type { RestContractResult } from '../../../src/rest/contract-check.js';
import { tempProjectDir } from './fixture.js';
import { join } from 'node:path';

function makeEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: 'contract-entry-0001',
    at: new Date(2026, 0, 1).toISOString(),
    projectId: 'proj-1',
    requestName: 'Get pet',
    interfaceName: 'Pets',
    operationName: '',
    endpoint: 'https://example.test/pets/1',
    soapVersion: 'none',
    method: 'GET',
    durationMs: 12,
    ok: true,
    status: 200,
    request: { envelopeXml: '', headers: [] },
    sizeBytes: 42,
    kind: 'rest',
    ...overrides,
  };
}

const violation: RestContractResult = {
  status: 'violation',
  operation: { method: 'get', path: '/pets/{id}' },
  responseKey: '200',
  mediaType: 'application/json',
  problems: [{ path: '/name', keyword: 'type', message: 'must be string' }],
  notes: ['format is not checked'],
};

describe('history: rest contract result', () => {
  it('a kind: rest entry with a contract survives a jsonl write and read unchanged', async () => {
    const dir = await tempProjectDir();
    const file = await openHistory(join(dir, 'history.jsonl'));
    const entry = makeEntry({ contract: historyContractOf(violation) });
    await file.append(entry);
    const reopened = await openHistory(join(dir, 'history.jsonl'));
    expect(reopened.list()[0]?.contract).toEqual(violation);
  });

  it('keeps the same caps as the check: problems, messages and notes', () => {
    const long = 'x'.repeat(MAX_CONTRACT_MESSAGE_LENGTH + 50);
    const stored = historyContractOf({
      status: 'violation',
      problems: Array.from({ length: MAX_CONTRACT_PROBLEMS + 10 }, (_, i) => ({
        path: `/${String(i)}`,
        keyword: 'type',
        message: long,
      })),
      notes: Array.from({ length: MAX_CONTRACT_PROBLEMS + 10 }, () => long),
    });
    expect(stored.problems).toHaveLength(MAX_CONTRACT_PROBLEMS);
    expect(stored.problems[0]?.message).toHaveLength(MAX_CONTRACT_MESSAGE_LENGTH);
    expect(stored.notes).toHaveLength(MAX_CONTRACT_PROBLEMS);
    expect(stored.notes[0]).toHaveLength(MAX_CONTRACT_MESSAGE_LENGTH);
  });

  it('copies nothing it does not know', () => {
    const stored = historyContractOf({ ...violation, body: 'secret' } as unknown as RestContractResult);
    expect(stored).not.toHaveProperty('body');
  });
});
