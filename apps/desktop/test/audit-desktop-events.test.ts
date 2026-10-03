import { describe, expect, it } from 'vitest';
import { desktopAuditEventSchema } from '@wirebench/engine';
import type { SequenceRunResult, SequenceStepResult } from '@wirebench/engine';
import { maskAuditUrl, requestSentEvent, runFinishedEvent } from '../src/main/audit/desktop-events.js';
import { recordSecretValue } from '../src/main/redact.js';

describe('maskAuditUrl', () => {
  it('masks a sensitive query value, a password and a recorded secret in the path', () => {
    recordSecretValue('s3cr3t-token-value');
    const masked = maskAuditUrl('https://user:pw@api.example/v1/s3cr3t-token-value/x?api_key=abc&q=1');
    expect(masked).not.toContain('abc');
    expect(masked).not.toContain('pw@');
    expect(masked).not.toContain('s3cr3t-token-value');
    expect(masked).toContain('q=1');
  });

  it('cuts at 2048 characters', () => {
    expect(maskAuditUrl(`https://a.example/${'x'.repeat(5000)}`)).toHaveLength(2048);
  });
});

describe('requestSentEvent', () => {
  it('builds a schema-valid event with the URL masked', () => {
    const event = requestSentEvent({
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
    const event = runFinishedEvent(result, '2026-10-03T10:00:00.000Z', now, 'prod');
    expect(desktopAuditEventSchema.safeParse(event).success).toBe(true);
    expect(event).toEqual({
      action: 'desktop.run_finished',
      details: {
        sequenceId: 'seq1',
        name: 'Smoke',
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

  it('reports cancelled when the caller says so, and caps hosts at 64', () => {
    const many = { ...result, steps: Array.from({ length: 80 }, (_, i) => step('passed', `https://h${i}.example`)) };
    const event = runFinishedEvent(many, many.startedAt, now, null, true);
    expect(event.action === 'desktop.run_finished' && event.details.outcome).toBe('cancelled');
    expect(event.action === 'desktop.run_finished' && event.details.hosts).toHaveLength(64);
  });
});
