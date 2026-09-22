import { describe, expect, it } from 'vitest';
import { canSend, initialSelection, pickBaseline } from '../../src/renderer/features/multi-env/env-picker.js';

const ENVS = [
  { id: 'dev', name: 'Dev' },
  { id: 'test', name: 'Test' },
  { id: 'prod', name: 'Prod' },
];

describe('initialSelection', () => {
  it('ticks the active environment and makes it the baseline', () => {
    expect(initialSelection(ENVS, 'test')).toEqual({ ticked: ['test'], baseline: 'test' });
  });

  it('starts from the remembered selection, dropping environments that are gone', () => {
    expect(initialSelection(ENVS, 'dev', { ticked: ['prod', 'gone', 'test'], baseline: 'prod' })).toEqual({
      ticked: ['prod', 'test'],
      baseline: 'prod',
    });
  });

  it('falls back to the active, then the first ticked, when the remembered baseline is gone', () => {
    expect(initialSelection(ENVS, 'test', { ticked: ['dev', 'test'], baseline: 'gone' }).baseline).toBe('test');
    expect(initialSelection(ENVS, 'prod', { ticked: ['dev', 'test'], baseline: 'gone' }).baseline).toBe('dev');
  });

  it('ticks nothing when there is no active environment', () => {
    expect(initialSelection(ENVS, undefined)).toEqual({ ticked: [], baseline: '' });
  });
});

describe('pickBaseline', () => {
  it('keeps the preferred baseline while it is ticked', () => {
    expect(pickBaseline(['dev', 'prod'], 'prod', 'dev')).toBe('prod');
  });

  it('falls back to the active environment, else the first ticked, when it is unticked', () => {
    expect(pickBaseline(['dev', 'prod'], 'test', 'dev')).toBe('dev');
    expect(pickBaseline(['prod', 'test'], 'dev', 'dev')).toBe('prod');
    expect(pickBaseline([], 'dev', 'dev')).toBe('');
  });
});

describe('canSend', () => {
  it('needs two ticked environments with the baseline among them', () => {
    expect(canSend({ ticked: ['dev'], baseline: 'dev' })).toBe(false);
    expect(canSend({ ticked: ['dev', 'test'], baseline: 'dev' })).toBe(true);
    expect(canSend({ ticked: ['dev', 'test'], baseline: 'prod' })).toBe(false);
  });
});
