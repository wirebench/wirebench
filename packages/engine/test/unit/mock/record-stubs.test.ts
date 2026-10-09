/**
 * Adding recorded traffic to a mock (#60, spec §Saving): new operations, names and slugs, order,
 * dedupe, replace, the limits, and that the input is left alone.
 */
import { describe, expect, it } from 'vitest';
import { MOCK_LIMITS, createMock, createMockOperation, createMockResponse } from '../../../src/mock/model.js';
import type { MockDef } from '../../../src/mock/model.js';
import { addRecordedStubs } from '../../../src/mock/record-stubs.js';
import type { MockRecording } from '../../../src/mock/record-stubs.js';

function ids(): () => string {
  let n = 0;
  return () => `ID${String((n += 1))}`;
}

function recording(over: Partial<MockRecording> = {}): MockRecording {
  return {
    operation: 'get /orders',
    operationName: 'GET /orders',
    status: 200,
    headers: [{ name: 'Content-Type', value: 'application/json' }],
    body: 'json',
    bodyText: '[{"id":1}]',
    ...over,
  };
}

function generated(): MockDef {
  return createMock(
    'Orders',
    { containerId: 'A1' },
    {
      id: 'M1',
      operations: [
        createMockOperation('GET /orders', 'get /orders', {
          id: 'O1',
          slug: 'get-orders',
          defaultResponseId: 'R1',
          responses: [createMockResponse('Default', { id: 'R1', slug: 'Default', body: 'json', bodyText: '[]' })],
        }),
      ],
    },
  );
}

describe('addRecordedStubs', () => {
  it('appends to the routed operation, after its responses, keeping its default', () => {
    const mock = generated();
    const result = addRecordedStubs(mock, [recording(), recording({ bodyText: '[{"id":2}]' })], { newId: ids() });
    const operation = result.mock.operations[0];
    expect(result.added).toBe(2);
    expect(operation?.defaultResponseId).toBe('R1');
    expect(operation?.responses.map((r) => [r.name, r.slug, r.order])).toEqual([
      ['Default', 'Default', 0],
      ['Recorded 200', 'Recorded 200', 1],
      ['Recorded 200 2', 'Recorded 200 2', 2],
    ]);
    expect(operation?.responses[1]?.headers).toEqual([{ name: 'Content-Type', value: 'application/json' }]);
  });

  it('creates an operation the mock lacks, with sequence dispatch and the first stub as default', () => {
    const result = addRecordedStubs(
      generated(),
      [
        recording({ operation: 'post /orders', operationName: 'POST /orders', status: 201 }),
        recording({ operation: 'post /orders', operationName: 'POST /orders', status: 400, bodyText: '{}' }),
      ],
      { newId: ids() },
    );
    const created = result.mock.operations[1];
    expect(created).toMatchObject({ name: 'POST /orders', operation: 'post /orders', dispatch: 'sequence', order: 1 });
    expect(created?.slug).not.toBe('get-orders');
    expect(created?.defaultResponseId).toBe(created?.responses[0]?.id);
    expect(created?.responses.map((r) => r.name)).toEqual(['Recorded 201', 'Recorded 400']);
  });

  it('skips duplicates of existing responses and of earlier recordings, unless dedupe is off', () => {
    const mock = generated();
    const same = recording({ bodyText: '[]', headers: [] });
    const deduped = addRecordedStubs(mock, [same, recording(), recording()], { newId: ids() });
    expect(deduped.added).toBe(1);
    expect(deduped.skipped).toEqual([
      { operation: 'get /orders', reason: 'duplicate' },
      { operation: 'get /orders', reason: 'duplicate' },
    ]);
    expect(addRecordedStubs(mock, [same, recording(), recording()], { dedupe: false }).added).toBe(3);
  });

  it('replace drops the operation’s other responses once, and the first stub becomes the default', () => {
    const result = addRecordedStubs(generated(), [recording(), recording({ status: 404, bodyText: '' })], {
      replace: true,
      newId: ids(),
    });
    const operation = result.mock.operations[0];
    expect(operation?.responses.map((r) => r.name)).toEqual(['Recorded 200', 'Recorded 404']);
    expect(operation?.defaultResponseId).toBe(operation?.responses[0]?.id);
  });

  it('skips past the responses-per-operation limit', () => {
    const full = createMock(
      'M',
      { containerId: 'A1' },
      {
        operations: [
          createMockOperation('Op', 'op', {
            responses: Array.from({ length: MOCK_LIMITS.responsesPerOperation }, (_, i) =>
              createMockResponse(`R${String(i)}`, { order: i }),
            ),
          }),
        ],
      },
    );
    const result = addRecordedStubs(full, [recording({ operation: 'op' })]);
    expect(result.added).toBe(0);
    expect(result.skipped).toEqual([{ operation: 'op', reason: 'responses' }]);
  });

  it('skips a new operation past the operations limit', () => {
    const full = createMock(
      'M',
      { containerId: 'A1' },
      {
        operations: Array.from({ length: MOCK_LIMITS.operations }, (_, i) =>
          createMockOperation(`Op${String(i)}`, `op${String(i)}`, { order: i }),
        ),
      },
    );
    const result = addRecordedStubs(full, [recording({ operation: 'other' })]);
    expect(result.skipped).toEqual([{ operation: 'other', reason: 'operations' }]);
    expect(result.mock.operations).toHaveLength(MOCK_LIMITS.operations);
  });

  it('skips a stub that would take the mock past its body bytes, and creates no empty operation', () => {
    const big = 'x'.repeat(MOCK_LIMITS.totalBodyBytes - 10);
    const mock = createMock(
      'M',
      { containerId: 'A1' },
      {
        operations: [
          createMockOperation('Op', 'op', { responses: [createMockResponse('Big', { body: 'text', bodyText: big })] }),
        ],
      },
    );
    const result = addRecordedStubs(mock, [recording({ operation: 'new', bodyText: 'more than ten bytes' })]);
    expect(result.skipped).toEqual([{ operation: 'new', reason: 'bodies' }]);
    expect(result.mock.operations).toHaveLength(1);
    // Replacing the big body frees its bytes.
    const replaced = addRecordedStubs(mock, [recording({ operation: 'op', bodyText: 'more than ten bytes' })], {
      replace: true,
    });
    expect(replaced.added).toBe(1);
  });

  it('leaves the input mock unchanged', () => {
    const mock = generated();
    const before = structuredClone(mock);
    addRecordedStubs(mock, [recording(), recording({ operation: 'x', operationName: 'X' })], { replace: true });
    expect(mock).toEqual(before);
  });
});
