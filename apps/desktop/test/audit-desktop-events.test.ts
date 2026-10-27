import { describe, expect, it } from 'vitest';
import { desktopAuditEventSchema } from '@wirebench/engine';
import type { SequenceRunResult, SequenceStepResult } from '@wirebench/engine';
import { maskAuditUrl, requestSentEvent, runFinishedEvent, sshSessionEvent } from '../src/main/audit/desktop-events.js';
import type { SshSessionInput } from '../src/main/audit/desktop-events.js';
import { Redactor } from '../src/main/host/redactor.js';

const redactor = new Redactor();

describe('maskAuditUrl', () => {
  it('masks a sensitive query value, a password and a recorded secret in the path', () => {
    redactor.recordSecretValue('s3cr3t-token-value');
    const masked = maskAuditUrl(redactor, 'https://user:pw@api.example/v1/s3cr3t-token-value/x?api_key=abc&q=1');
    expect(masked).not.toContain('abc');
    expect(masked).not.toContain('pw@');
    expect(masked).not.toContain('s3cr3t-token-value');
    expect(masked).toContain('q=1');
  });

  it('cuts before a redaction marker the cut would split', () => {
    const head = 'https://a.example/?q=';
    const prefix = `${head}${'x'.repeat(2045 - head.length - '&api_key='.length)}&api_key=`;
    expect(prefix).toHaveLength(2045);
    const masked = maskAuditUrl(redactor, `${prefix}abc`);
    expect(masked).toBe(prefix);
  });

  it('masks the sensitive query values of a URL that does not parse', () => {
    const masked = maskAuditUrl(redactor, '127.0.0.1:50051?token=x&keep=1&api_key=y');
    expect(masked).not.toContain('=x');
    expect(masked).not.toContain('=y');
    expect(masked).toContain('keep=1');
  });

  it('masks the userinfo password of a URL that does not parse, keeping the user', () => {
    const masked = maskAuditUrl(redactor, 'https://ada:hunter2@bad host:99999/x?keep=1');
    expect(masked).toBe('https://ada:<redacted>@bad host:99999/x?keep=1');
    expect(maskAuditUrl(redactor, 'https://ada:p@ss@bad host/x')).toBe('https://ada:<redacted>@bad host/x');
    expect(maskAuditUrl(redactor, 'https://ada@bad host/x')).toBe('https://ada@bad host/x');
  });

  it('matches a recorded secret before redactor.redactUrl re-encodes it', () => {
    redactor.recordSecretValue('a b+c');
    const masked = maskAuditUrl(redactor, 'https://a.example/p?q=a b+c');
    expect(masked).not.toContain('a b');
    expect(masked).not.toContain('b+c');
  });

  it('cuts at 2048 characters', () => {
    expect(maskAuditUrl(redactor, `https://a.example/${'x'.repeat(5000)}`)).toHaveLength(2048);
  });
});

describe('requestSentEvent', () => {
  it('builds a schema-valid event with the URL masked', () => {
    const event = requestSentEvent(redactor, {
      protocol: 'rest',
      method: 'GET',
      url: 'https://a.example/?api_key=abc',
      status: 200,
      outcome: 'ok',
      durationMs: 12.6,
      environment: null,
      requestId: 'r1',
      requestName: 'List',
      sentAt: '2026-10-03T10:00:00.000Z',
    });
    expect(desktopAuditEventSchema.safeParse(event).success).toBe(true);
    expect(JSON.stringify(event)).not.toContain('abc');
  });
});

const step = (outcome: SequenceStepResult['outcome'], origin?: string, durationMs?: number): SequenceStepResult => ({
  index: 0,
  stepId: 's',
  requestId: 'r',
  name: 'n',
  outcome,
  assertions: [],
  transfers: [],
  ...(origin !== undefined ? { origin } : {}),
  ...(durationMs !== undefined ? { durationMs } : {}),
});

describe('runFinishedEvent', () => {
  const result: SequenceRunResult = {
    sequenceId: 'seq1',
    name: 'Smoke',
    startedAt: '2026-10-03T10:00:00.000Z',
    outcome: 'failed',
    steps: [
      step('passed', 'https://a.example'),
      step('passed', 'https://a.example'),
      step('failed', 'https://b.example'),
      step('errored'),
      step('skipped'),
    ],
  };
  const now = new Date('2026-10-03T10:00:05.250Z');

  it('counts outcomes, collects distinct origins and derives the duration', () => {
    const event = runFinishedEvent(redactor, result, '2026-10-03T10:00:00.000Z', now, 'prod');
    expect(desktopAuditEventSchema.safeParse(event).success).toBe(true);
    expect(event).toEqual({
      action: 'desktop.run_finished',
      details: {
        sequenceId: 'seq1',
        sequenceName: 'Smoke',
        outcome: 'failed',
        passed: 2,
        failed: 1,
        errored: 1,
        skipped: 1,
        durationMs: 5250,
        hosts: ['https://a.example', 'https://b.example'],
        environment: 'prod',
        startedAt: '2026-10-03T10:00:00.000Z',
        sentAt: '2026-10-03T10:00:05.250Z',
      },
    });
  });

  it('counts a run a branch superseded as skipped, as the outcome does (#347)', () => {
    const retried = {
      ...result,
      outcome: 'passed' as const,
      steps: [{ ...step('failed', 'https://a.example'), retried: true as const }, step('passed', 'https://a.example')],
    };
    const event = runFinishedEvent(redactor, retried, retried.startedAt, now, null);
    expect(event.action === 'desktop.run_finished' && [event.details.failed, event.details.skipped]).toEqual([0, 1]);
  });

  it('reports cancelled when the caller says so, and caps hosts at 64', () => {
    const many = { ...result, steps: Array.from({ length: 80 }, (_, i) => step('passed', `https://h${i}.example`)) };
    const event = runFinishedEvent(redactor, many, many.startedAt, now, null, true);
    expect(event.action === 'desktop.run_finished' && event.details.outcome).toBe('cancelled');
    expect(event.action === 'desktop.run_finished' && event.details.hosts).toHaveLength(64);
  });
});

describe('sshSessionEvent (#355)', () => {
  const startedAt = new Date('2026-10-20T08:00:00.000Z');
  const endedAt = new Date('2026-10-20T08:01:05.250Z');
  const PASSWORD = 'hunter2-pw';
  const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----';
  const PASSPHRASE = 'open-sesame';
  const ENV_VALUE = 'tok_from_env_secret';
  const base: SshSessionInput = {
    protocol: 'ssh',
    hostId: 'web-1',
    address: '10.0.0.1',
    port: 22,
    user: 'deploy',
    secrets: [PASSWORD, PRIVATE_KEY, PASSPHRASE, ENV_VALUE],
    startedAt,
    endedAt,
    exit: { code: 0, reason: 'exit' },
  };

  it('builds a schema-valid event with where the session went and how it ended', () => {
    const event = sshSessionEvent(redactor, base);
    expect(desktopAuditEventSchema.safeParse(event).success).toBe(true);
    expect(event).toEqual({
      action: 'desktop.ssh_session',
      details: {
        protocol: 'ssh',
        hostId: 'web-1',
        address: '10.0.0.1',
        port: 22,
        user: 'deploy',
        exitCode: 0,
        reason: 'exit',
        durationMs: 65_250,
        startedAt: '2026-10-20T08:00:00.000Z',
        endedAt: '2026-10-20T08:01:05.250Z',
        sentAt: '2026-10-20T08:01:05.250Z',
      },
    });
  });

  it('carries no credential: the details hold only the named fields, whatever the input knows', () => {
    const event = sshSessionEvent(redactor, {
      ...base,
      password: PASSWORD,
      privateKey: PRIVATE_KEY,
    } as SshSessionInput);
    expect(Object.keys(event.details).sort()).toEqual(
      [
        'address',
        'durationMs',
        'endedAt',
        'exitCode',
        'hostId',
        'port',
        'protocol',
        'reason',
        'sentAt',
        'startedAt',
        'user',
      ].sort(),
    );
    const text = JSON.stringify(event);
    for (const secret of [PASSWORD, PRIVATE_KEY, PASSPHRASE, ENV_VALUE]) expect(text).not.toContain(secret);
  });

  it('masks a session secret, or a recorded one, wherever the address or user shows it', () => {
    redactor.recordSecretValue('rec0rded-value');
    const event = sshSessionEvent(redactor, {
      ...base,
      address: `${PASSWORD}.example`,
      user: `deploy-${ENV_VALUE}-rec0rded-value`,
    });
    expect(desktopAuditEventSchema.safeParse(event).success).toBe(true);
    const text = JSON.stringify(event);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(ENV_VALUE);
    expect(text).not.toContain('rec0rded-value');
    expect(event.action === 'desktop.ssh_session' && event.details.address).toBe('••••.example');
    expect(event.action === 'desktop.ssh_session' && event.details.user).toBe('deploy-••••-<redacted>');
  });

  it('reports a window-closed session with no exit code and reason closed, and a serial line with no user', () => {
    const closed = sshSessionEvent(redactor, { ...base, exit: undefined });
    expect(closed.action === 'desktop.ssh_session' && closed.details).toMatchObject({
      exitCode: null,
      reason: 'closed',
    });
    const lost = sshSessionEvent(redactor, { ...base, exit: { code: null, reason: 'lost' } });
    expect(lost.action === 'desktop.ssh_session' && lost.details).toMatchObject({ exitCode: null, reason: 'lost' });
    const serial = sshSessionEvent(redactor, {
      ...base,
      protocol: 'serial',
      address: '/dev/ttyUSB0',
      port: 0,
      user: '',
    });
    expect(desktopAuditEventSchema.safeParse(serial).success).toBe(true);
    expect(serial.action === 'desktop.ssh_session' && serial.details).toMatchObject({
      protocol: 'serial',
      address: '/dev/ttyUSB0',
      port: 0,
      user: '',
    });
  });

  it('keeps the event valid when the clock ran backwards or the address masks to nothing', () => {
    const event = sshSessionEvent(redactor, { ...base, address: PASSWORD, startedAt: endedAt, endedAt: startedAt });
    expect(desktopAuditEventSchema.safeParse(event).success).toBe(true);
    expect(event.action === 'desktop.ssh_session' && event.details).toMatchObject({ durationMs: 0, address: '••••' });
  });
});
