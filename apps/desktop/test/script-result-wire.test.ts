// @vitest-environment node
/**
 * What a send's scripts did, as its summary carries it (#63, #334): each level that ran, in order,
 * with its tests, log and failure, and every string masked before it leaves main.
 */
import { describe, expect, it } from 'vitest';
import type { SentScripts } from '@wirebench/engine';
import { recordSecretValue } from '../src/main/redact.js';
import { toScriptResultWire } from '../src/main/script-send.js';

describe('toScriptResultWire', () => {
  it('carries each level that ran, masked', () => {
    recordSecretValue('lvl-secret-7731');
    const sent: SentScripts = {
      tests: [{ name: 'api ok', passed: true }],
      values: [],
      log: { lines: ['token lvl-secret-7731'], truncated: false },
      levels: [
        {
          level: 'api',
          name: 'Shop',
          phase: 'pre',
          tests: [],
          log: { lines: ['token lvl-secret-7731'], truncated: false },
        },
        {
          level: 'folder',
          name: 'Orders',
          phase: 'post',
          tests: [{ name: 'api ok', passed: true }],
          log: { lines: [], truncated: false },
          error: { code: 'script-error', message: 'Orders/folder.post.ts:1:1: lvl-secret-7731' },
        },
      ],
    };
    const wire = toScriptResultWire(sent);
    expect(wire.levels).toEqual([
      {
        level: 'api',
        name: 'Shop',
        phase: 'pre',
        tests: [],
        log: [expect.not.stringContaining('lvl-secret-7731')],
        truncated: false,
      },
      {
        level: 'folder',
        name: 'Orders',
        phase: 'post',
        tests: [{ name: 'api ok', passed: true }],
        log: [],
        truncated: false,
        error: { code: 'script-error', message: expect.not.stringContaining('lvl-secret-7731') as unknown },
      },
    ]);
  });
});
