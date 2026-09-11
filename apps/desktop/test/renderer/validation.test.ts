import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setValidationMarkers, toMarkerData, VALIDATION_MARKER_OWNER } from '../../src/renderer/editor/markers.js';
import type { MarkerApi } from '../../src/renderer/editor/markers.js';
import {
  clearValidation,
  runValidation,
  validateAndReport,
  validationGroupId,
} from '../../src/renderer/features/request-editor/validate-actions.js';
import { useProblemsStore } from '../../src/renderer/state/problems.js';
import type { ValidationProblemWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const model = { getLineCount: () => 10, getLineMaxColumn: (line: number) => line * 10 };

const problem = (overrides: Partial<ValidationProblemWire> = {}): ValidationProblemWire => ({
  severity: 'error',
  code: 'schema-invalid',
  message: "Element 'intA': 'abc' is not a valid value",
  source: 'schema',
  line: 6,
  ...overrides,
});

describe('toMarkerData', () => {
  it('spans the whole line when only a line is known', () => {
    expect(toMarkerData([problem()], model)).toEqual([
      {
        severity: 8,
        message: "Element 'intA': 'abc' is not a valid value",
        code: 'schema-invalid',
        source: 'schema',
        startLineNumber: 6,
        startColumn: 1,
        endLineNumber: 6,
        endColumn: 60,
      },
    ]);
  });

  it('uses warning severity and an explicit range when given one', () => {
    const [marker] = toMarkerData(
      [problem({ severity: 'warning', line: 2, column: 3, endLine: 4, endColumn: 7 })],
      model,
    );
    expect(marker).toMatchObject({ severity: 4, startLineNumber: 2, startColumn: 3, endLineNumber: 4, endColumn: 7 });
  });

  it('pins a positionless problem to line 1 and clamps beyond the last line', () => {
    const [first, second] = toMarkerData([problem({ line: undefined }), problem({ line: 99, endLine: 120 })], model);
    expect(first).toMatchObject({ startLineNumber: 1, endLineNumber: 1 });
    expect(second).toMatchObject({ startLineNumber: 10, endLineNumber: 10 });
  });
});

describe('setValidationMarkers', () => {
  it('files markers under the validation owner', () => {
    const setModelMarkers = vi.fn();
    const monaco = { editor: { setModelMarkers } } as unknown as MarkerApi;
    setValidationMarkers(model as never, [problem()], monaco);
    expect(setModelMarkers).toHaveBeenCalledWith(model, VALIDATION_MARKER_OWNER, expect.any(Array));
  });

  it('does nothing without a model or a Monaco namespace', () => {
    const setModelMarkers = vi.fn();
    setValidationMarkers(null, [problem()], { editor: { setModelMarkers } } as unknown as MarkerApi);
    setValidationMarkers(model as never, [problem()], undefined);
    expect(setModelMarkers).not.toHaveBeenCalled();
  });
});

describe('runValidation', () => {
  beforeEach(() => {
    useProblemsStore.setState({ items: [] });
  });

  it('records the findings under the request/direction group', async () => {
    installWirebenchApi({
      validate: {
        message: vi.fn().mockResolvedValue({ ok: true, value: { problems: [problem()], durationMs: 3 } }),
      },
    });

    const problems = await runValidation('req-1', 'request', '<Envelope/>');
    expect(problems).toHaveLength(1);
    const items = useProblemsStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      groupId: validationGroupId('req-1', 'request'),
      source: 'validation',
      severity: 'error',
      requestId: 'req-1',
    });
  });

  it('replaces the previous run of the same direction only', async () => {
    const message = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: { problems: [problem()], durationMs: 1 } })
      .mockResolvedValueOnce({ ok: true, value: { problems: [problem({ code: 'other' })], durationMs: 1 } })
      .mockResolvedValueOnce({ ok: true, value: { problems: [], durationMs: 1 } });
    installWirebenchApi({ validate: { message } });

    await runValidation('req-1', 'request');
    await runValidation('req-1', 'response');
    expect(useProblemsStore.getState().items).toHaveLength(2);

    await runValidation('req-1', 'request');
    expect(useProblemsStore.getState().items.map((item) => item.problem.code)).toEqual(['other']);
  });

  it('records a failed validation call as a problem of its own', async () => {
    installWirebenchApi({
      validate: {
        message: vi.fn().mockResolvedValue({ ok: false, error: { code: 'unknown-interface', message: 'nope' } }),
      },
    });
    const problems = await runValidation('req-1', 'request');
    expect(problems.map((item) => item.code)).toEqual(['unknown-interface']);
    expect(useProblemsStore.getState().items).toHaveLength(1);
  });

  it('clearValidation drops both directions', async () => {
    installWirebenchApi({
      validate: { message: vi.fn().mockResolvedValue({ ok: true, value: { problems: [problem()], durationMs: 1 } }) },
    });
    await runValidation('req-1', 'request');
    await runValidation('req-1', 'response');
    clearValidation('req-1');
    expect(useProblemsStore.getState().items).toEqual([]);
  });

  it('validateAndReport returns the same findings it announces', async () => {
    installWirebenchApi({
      validate: { message: vi.fn().mockResolvedValue({ ok: true, value: { problems: [], durationMs: 1 } }) },
    });
    await expect(validateAndReport('req-1', 'request')).resolves.toEqual([]);
  });
});
