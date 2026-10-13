import { isWirebenchError } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import {
  alertTargetView,
  mergeSecrets,
  openSecrets,
  openValue,
  sealAlertTargets,
  secretSummaries,
} from '../../../src/schedules/seal.js';

const key = Buffer.alloc(32, 3);
const settings = { secretKey: key, smtp: { url: 'smtp://mail.test', from: 'wb@example.test' } };
const SLACK = 'https://hooks.slack.example/services/T000/B000/abcdWXYZ';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return isWirebenchError(error) ? error.code : 'not-a-wirebench-error';
  }
  return undefined;
}

describe('alert targets at rest (scheduled-runs §3.4)', () => {
  it('seals each URL and webhook secret, and a read shows only the host and the last four', () => {
    const stored = sealAlertTargets(settings, [
      { kind: 'slack', url: SLACK },
      { kind: 'webhook', url: 'https://ops.example.test/in/hook-1234', secret: 'a-long-signing-secret' },
      { kind: 'email', to: ['ops@example.test'] },
    ]);
    expect(JSON.stringify(stored)).not.toContain('hooks.slack.example/services');
    expect(JSON.stringify(stored)).not.toContain('a-long-signing-secret');
    const slack = stored[0]!;
    expect(slack.kind === 'slack' && openValue(key, slack.url)).toBe(SLACK);
    expect(stored.map(alertTargetView)).toEqual([
      { kind: 'slack', host: 'hooks.slack.example', hint: 'WXYZ' },
      { kind: 'webhook', host: 'ops.example.test', hint: '1234', signed: true },
      { kind: 'email', to: ['ops@example.test'] },
    ]);
  });

  it('refuses email without mail settings, a host off the list, and a URL without the key', () => {
    expect(codeOf(() => sealAlertTargets({ secretKey: key }, [{ kind: 'email', to: ['a@b.test'] }]))).toBe(
      'schedules-smtp-missing',
    );
    expect(
      codeOf(() => sealAlertTargets({ secretKey: key, alertHosts: ['*.slack.com'] }, [{ kind: 'slack', url: SLACK }])),
    ).toBe('schedules-alert-host-refused');
    expect(codeOf(() => sealAlertTargets({}, [{ kind: 'teams', url: SLACK }]))).toBe('schedules-secret-key-missing');
  });

  it('a *.domain entry allows the domain and every host below it', () => {
    const allowed = { secretKey: key, alertHosts: ['*.slack.example'] };
    expect(codeOf(() => sealAlertTargets(allowed, [{ kind: 'slack', url: SLACK }]))).toBeUndefined();
    expect(
      codeOf(() => sealAlertTargets(allowed, [{ kind: 'slack', url: 'https://slack.example/x' }])),
    ).toBeUndefined();
    expect(codeOf(() => sealAlertTargets(allowed, [{ kind: 'slack', url: 'https://evilslack.example/x' }]))).toBe(
      'schedules-alert-host-refused',
    );
  });
});

describe('schedule secrets (scheduled-runs §3.3)', () => {
  it('sets, changes and removes names, keeps the rest, and reports which', () => {
    const first = mergeSecrets({ secretKey: key }, {}, { API_KEY: 'first-api-key', TOKEN: 'short' });
    expect(first).toMatchObject({ added: ['API_KEY', 'TOKEN'], changed: [], removed: [] });
    const second = mergeSecrets({ secretKey: key }, first.secrets, {
      API_KEY: 'second-api-key',
      TOKEN: null,
      GONE: null,
    });
    expect(second).toMatchObject({ added: [], changed: ['API_KEY'], removed: ['TOKEN'] });
    expect(openSecrets({ secretKey: key }, second.secrets)).toEqual({ API_KEY: 'second-api-key' });
    expect(secretSummaries(first.secrets)).toEqual([
      { name: 'API_KEY', hint: '-key' },
      { name: 'TOKEN', hint: null },
    ]);
    expect(JSON.stringify(second.secrets)).not.toContain('second-api-key');
  });

  it('needs the key to set a value or to open any, but not to remove one', () => {
    expect(codeOf(() => mergeSecrets({}, {}, { A: 'value' }))).toBe('schedules-secret-key-missing');
    const stored = mergeSecrets({ secretKey: key }, {}, { A: 'value' }).secrets;
    expect(mergeSecrets({}, stored, { A: null }).removed).toEqual(['A']);
    expect(codeOf(() => openSecrets({}, stored))).toBe('schedules-secret-key-missing');
    expect(openSecrets({}, {})).toEqual({});
  });
});
