/**
 * Slice 7 Task 27 (hosted edition spec §22.12): retention, mail and forwarding read each tenant's own settings. A
 * sweep cuts each tenant at its own age, inside its unit, never past the operator's; an alert goes out through the
 * tenant's own SMTP when it set one and the operator's otherwise; and a tenant's events are queued for forwarding
 * only when it forwards somewhere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditHook } from '../../../src/audit-log/hook.js';
import { deleteAuditEventsBefore } from '../../../src/audit-log/repo.js';
import { TenantSinks } from '../../../src/audit-log/forward/tenant-sinks.js';
import type { ServerConfig } from '../../../src/config.js';
import { CaptureSweeper } from '../../../src/hooks/sweep.js';
import { alertDelivery } from '../../../src/schedules/alerts/outbox.js';
import type { AlertPayload } from '../../../src/schedules/alerts/render.js';
import { TenantAdmin } from '../../../src/tenancy/directory.js';
import type { TenantScope } from '../../../src/tenancy/scope.js';
import { directoryOf } from '../../../src/tenancy/tenancy.js';
import { describeDb } from '../../helpers/database.js';
import { identityHarness, type IdentityHarness } from '../../helpers/identity.js';
import { smtpSink, type SmtpSink } from '../../helpers/smtp-sink.js';
import { manualTimers } from '../../helpers/timers.js';

const DAY = 86_400_000;
const NOW = new Date('2026-11-04T12:00:00.000Z');
const hosted = (config: ServerConfig): ServerConfig => ({ ...config, mode: 'hosted', appDomain: 'example.test' });

describeDb('per-tenant retention, mail and forwarding (spec §22.12)', () => {
  let h: IdentityHarness;
  let acme: TenantScope;
  let beta: TenantScope;
  let operator: SmtpSink;
  let own: SmtpSink;
  beforeAll(async () => {
    operator = await smtpSink();
    own = await smtpSink();
    h = await identityHarness({
      env: {
        WIREBENCH_SERVER_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
        WIREBENCH_SERVER_AUDIT_MAX_AGE_DAYS: '365',
        WIREBENCH_SERVER_SMTP_URL: `smtp://operator:operator-pass@127.0.0.1:${String(operator.port)}`,
        WIREBENCH_SERVER_SMTP_FROM: 'alerts@operator.test',
      },
      configure: hosted,
      beforeBuild: async (db, ctx) => {
        const admin = new TenantAdmin(db, directoryOf(ctx.tenancy));
        acme = (await admin.create({ slug: 'acme', name: 'Acme' })).scope;
        beta = (await admin.create({ slug: 'beta', name: 'Beta' })).scope;
      },
    });
  }, 60_000);
  afterAll(async () => {
    await h.close();
    await operator.close();
    await own.close();
  });

  /** One audit event in `scope`, dated `daysAgo` before now. */
  const eventAt = (scope: TenantScope, daysAgo: number) =>
    h.ctx.tenancy.db(scope).transaction((tx) =>
      auditHook(() => new Date(NOW.getTime() - daysAgo * DAY), { forward: false })(tx, {
        actor: { kind: 'system' },
        action: 'team.created',
        target: { kind: 'team', id: `T${String(daysAgo)}` },
      }),
    );
  const agesIn = async (scope: TenantScope) =>
    (
      await h.ctx.tenancy
        .db(scope)
        .query<{ id: string }>("select target_id as id from audit_events where action = 'team.created' order by at")
    ).rows.map((row) => row.id);

  it('cuts each tenant at its own age inside its unit, never past the operator’s maxima', async () => {
    for (const scope of [acme, beta]) for (const days of [400, 100, 10]) await eventAt(scope, days);
    await h.ctx.settings.set(acme, 'retention', { auditMaxAgeDays: 30 }, { by: 'test' });
    // Asking for more than the operator keeps is clamped to the operator's 365 days.
    await h.ctx.settings.set(beta, 'retention', { auditMaxAgeDays: 3000 }, { by: 'test' });
    const sweeper = new CaptureSweeper({
      maxAgeDays: h.ctx.config.auditMaxAgeDays,
      maxAgeDaysFor: async (scope) => (await h.ctx.settings.retention(scope)).auditMaxAgeDays,
      now: () => NOW,
      setTimer: manualTimers().setTimer,
      log: h.app.log,
      target: { tenancy: h.ctx.tenancy, job: 'test-audit-retention', deleteBefore: deleteAuditEventsBefore },
    });
    expect(await sweeper.runOnce()).toBe(3);
    expect(await agesIn(acme)).toEqual(['T10']);
    expect(await agesIn(beta)).toEqual(['T100', 'T10']);
  });

  it('sends a tenant’s alert through its own SMTP when it set one, else the operator’s', async () => {
    await h.ctx.settings.set(
      acme,
      'smtp',
      { url: `smtp://acme-mailer:acme-pass@127.0.0.1:${String(own.port)}`, from: 'ops@acme.test' },
      { by: 'test' },
    );
    const deliver = alertDelivery(
      { smtp: { url: h.ctx.config.smtpUrl!, from: h.ctx.config.smtpFrom! } },
      { egress: 'unchecked', smtpFor: (scope) => h.ctx.settings.smtp(scope) },
    );
    const payload: AlertPayload = {
      kind: 'test',
      streak: 0,
      muted: false,
      schedule: { id: 'S1', name: 'Nightly' },
      workspace: { id: 'W1', name: 'Billing' },
      project: 'p',
      environment: null,
      failures: [],
    };
    await deliver({ kind: 'email', to: ['a@acme.test'] }, payload, acme);
    await deliver({ kind: 'email', to: ['b@beta.test'] }, payload, beta);
    expect(own.messages.map((message) => [message.from, message.auth, message.to])).toEqual([
      ['ops@acme.test', 'acme-mailer:acme-pass', ['a@acme.test']],
    ]);
    expect(operator.messages.map((message) => [message.from, message.to])).toEqual([
      ['alerts@operator.test', ['b@beta.test']],
    ]);
  });

  describe('forwarding', () => {
    it('builds a sink only for a tenant that forwards, and drops it when the setting changes', async () => {
      const built: string[] = [];
      const closed: string[] = [];
      const sinks = new TenantSinks(h.ctx.settings, { denyPrivate: true }, (setting) => {
        built.push(setting.url);
        return { send: () => Promise.resolve(), close: () => (closed.push(setting.url), Promise.resolve()) };
      });
      await h.ctx.settings.set(
        acme,
        'auditForward',
        { url: 'https://siem.acme.test/events', token: 'tok-acme-123456' },
        { by: 'test' },
      );
      expect(await sinks.forwards(acme)).toBe(true);
      expect(await sinks.forwards(beta)).toBe(false);
      expect(await sinks.sinkFor(beta)).toBeUndefined();
      expect(await sinks.sinkFor(acme)).toBeDefined();
      expect(await sinks.sinkFor(acme)).toBe(await sinks.sinkFor(acme));
      await h.ctx.settings.set(acme, 'auditForward', { url: 'https://siem2.acme.test/events' }, { by: 'test' });
      await sinks.sinkFor(acme);
      expect(built).toEqual(['https://siem.acme.test/events', 'https://siem2.acme.test/events']);
      expect(closed).toEqual(['https://siem.acme.test/events']);
      await sinks.close();
    });
  });
});
