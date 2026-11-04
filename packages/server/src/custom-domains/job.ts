/**
 * The custom-name check job (hosted edition spec §23.2): one pass over every tenant in the job loop (§19.8 guard 6),
 * each tenant's claim checked in its own units. The module registers {@link checkPass} on a timer (Task 7); the
 * on-demand route calls {@link checkTenant}.
 *
 * Per tenant:
 *
 * 1. In the loop's unit, read the claim. Nothing network-bound runs inside a unit, so the rest runs after it.
 * 2. Read the tenant's features. Without `custom-domains`, the claim is `paused` and its name released at once,
 *    whether or not a check is due.
 * 3. When a check is due (hourly while `pending`, every 6 hours otherwise, never once `expired`), ask DNS
 *    ({@link verifyRecords}), then, in a new unit, move the claim with {@link next}: hold the name on the way to
 *    `verified` (a name another tenant holds keeps the claim where it was, `held-elsewhere`), release it on the way to
 *    `lapsed`, `paused` or `expired`, and write the result. The claim is matched by its token, so a claim removed and
 *    made again meanwhile is left alone.
 * 4. A `verified` name gets the certificate probe (`probe.ts`), when one is given: right after the check
 *    that verified it, then every {@link PROBE_EVERY_MS} between DNS checks, since Traefik issues within minutes of
 *    the router appearing and the next DNS check is hours away. A pass marks the name live and the claim `active`.
 *    Without a probe the claim waits in `verified`. The probe never touches `checked_at`, which stays the DNS
 *    check's time; `last_result.probedAt` is the probe's.
 * 5. After the units, mail the tenant's server admins about `active`, `failing` and `lapsed`, when SMTP is set.
 *
 * Each change is an audit event in the tenant's chain, through the audit-log module's hook. Neither an event, a log
 * line nor a mail carries the token.
 */
import type { FastifyBaseLogger } from 'fastify';
import { recordAudit, SYSTEM_SOURCE, type ServerHooks } from '../context.js';
import type { JobPass } from '../tenancy/jobs.js';
import type { TenantScope } from '../tenancy/scope.js';
import type { Tenancy } from '../tenancy/tenancy.js';
import type { TenantQuerier } from '../tenancy/tenant-db.js';
import { verifyRecords, type DnsLookup, type RecordVerdict } from './dns.js';
import { domainEmail, type DomainNotice, type Mailer } from './mail.js';
import {
  getClaim,
  hold,
  record,
  release,
  serverAdminEmails,
  setLive,
  type CheckRecord,
  type Claim,
  type LastResult,
} from './repo.js';
import { isHeld, next, type DomainState } from './states.js';

/** The feature that grants a custom name (`FEATURES`). */
export const CUSTOM_DOMAINS_FEATURE = 'custom-domains';

/** How often a pending claim is checked, and how often any other (spec §23.2). */
export const PENDING_EVERY_MS = 60 * 60_000;
export const HELD_EVERY_MS = 6 * 60 * 60_000;
/**
 * How often a `verified` name is probed between its DNS checks (spec §23.4). The job's timer (Task 7) must run at
 * least this often for the cadence to hold.
 */
export const PROBE_EVERY_MS = 2 * 60_000;

/** The certificate probe's verdict for one name (Part C, spec §23.4). */
export interface ProbeResult {
  readonly verdict: RecordVerdict;
  readonly message: string;
}

/** Opens TLS to the proxy with `name` as SNI and checks the chain (Part C). */
export type CertificateProbe = (name: string) => Promise<ProbeResult>;

export interface CheckDeps {
  readonly tenancy: Pick<Tenancy, 'db' | 'forEachTenant'>;
  readonly lookup: DnsLookup;
  readonly appDomain: string;
  readonly now: () => Date;
  /** Where the audit events go: the audit-log module's hook. */
  readonly hooks: ServerHooks;
  /** The features the tenant's license grants, read through its scope (slice 7's per-tenant state plugs in here). */
  readonly features: (scope: TenantScope) => Promise<readonly string[]>;
  /** The certificate probe; without one a verified name stays `verified`. */
  readonly probe?: CertificateProbe;
  /** The mail sender; without one nothing is mailed. */
  readonly mail?: Mailer;
  readonly log: Pick<FastifyBaseLogger, 'error' | 'warn'>;
  /**
   * Called once a unit that may have changed what the resolver maps has committed: a name made live, made not live
   * or released (spec §23.5). The module reloads the tenant map here and, through the bus, on every instance.
   */
  readonly hostsChanged?: () => void;
}

/** The job's name in the loop's log lines. */
export const CHECK_JOB = 'custom-domains-check';

/** Whether `claim` is due a DNS check at `now`. */
export function isDue(claim: Pick<Claim, 'state' | 'checkedAt'>, now: Date): boolean {
  if (claim.state === 'expired') return false;
  if (claim.checkedAt === null) return true;
  const every = claim.state === 'pending' ? PENDING_EVERY_MS : HELD_EVERY_MS;
  return now.getTime() - claim.checkedAt.getTime() >= every;
}

/** Whether `claim` is due a probe-only pass at `now`: `verified`, and not probed for {@link PROBE_EVERY_MS}. */
export function isProbeDue(claim: Pick<Claim, 'state' | 'lastResult'>, now: Date): boolean {
  if (claim.state !== 'verified') return false;
  const probedAt = claim.lastResult?.probedAt;
  if (probedAt === undefined) return true;
  return now.getTime() - Date.parse(probedAt) >= PROBE_EVERY_MS;
}

const AUDIT_ACTION = {
  verified: 'custom_domain.verified',
  active: 'custom_domain.activated',
  failing: 'custom_domain.failing',
  lapsed: 'custom_domain.lapsed',
  paused: 'custom_domain.paused',
  expired: 'custom_domain.expired',
} as const satisfies Partial<Record<DomainState, string>>;

const NOTICES: readonly DomainState[] = ['active', 'failing', 'lapsed'];

interface Moved {
  readonly claim: Claim;
  /** The mail to send once the unit has committed, with its recipients. */
  readonly notice?: { readonly kind: DomainNotice; readonly to: readonly string[]; readonly detail: string };
}

/** One pass over every tenant. One tenant's failure is logged, and the next tenant still runs. */
export async function checkPass(deps: CheckDeps): Promise<JobPass> {
  return deps.tenancy.forEachTenant(
    CHECK_JOB,
    async (tx, scope) => {
      const seen = await getClaim(tx);
      if (seen === undefined || seen.state === 'expired') return;
      return { afterUnit: () => checkClaim(deps, scope, seen, false).then(() => undefined) };
    },
    deps.log,
  );
}

/**
 * Checks `scope`'s claim now, due or not: the on-demand check (`POST …/check`, Task 7). Answers the claim as it is
 * afterwards, or undefined when there is none.
 */
export async function checkTenant(deps: CheckDeps, scope: TenantScope): Promise<Claim | undefined> {
  const seen = await deps.tenancy.db(scope).transaction((tx) => getClaim(tx));
  if (seen === undefined) return undefined;
  return checkClaim(deps, scope, seen, true);
}

async function checkClaim(deps: CheckDeps, scope: TenantScope, seen: Claim, force: boolean): Promise<Claim> {
  const now = deps.now();
  const featured = (await deps.features(scope)).includes(CUSTOM_DOMAINS_FEATURE);
  if (!featured) {
    if (seen.state === 'paused' || seen.state === 'expired') return seen;
    const message = "This team's license no longer includes custom domains, so the name is released.";
    const moved = await move(deps, scope, seen.token, now, () => ({
      observation: { featured: false, passed: false },
      lastResult: { cname: seen.lastResult?.cname ?? 'missing', txt: seen.lastResult?.txt ?? 'missing', message },
    }));
    return moved?.claim ?? seen;
  }
  if (seen.state === 'expired') return seen;
  if (!force && !isDue(seen, now)) {
    // Between DNS checks, a verified name is only probed, on its own faster cadence.
    if (deps.probe === undefined || !isProbeDue(seen, now)) return seen;
    const probed = await probeName(deps, scope, seen, now);
    await sendNotices(deps, scope, [probed?.notice], seen.name);
    return probed?.claim ?? seen;
  }

  const records = await verifyRecords(deps.lookup, seen.name, seen.token, deps.appDomain);
  const passed = records.cname === 'ok' && records.txt === 'ok';
  const moved = await move(deps, scope, seen.token, now, () => ({
    observation: { featured: true, passed },
    lastResult: { cname: records.cname, txt: records.txt, message: records.message },
  }));
  let after = moved?.claim;
  const notices = [moved?.notice];
  if (after?.state === 'verified' && deps.probe !== undefined) {
    const probed = await probeName(deps, scope, after, now);
    after = probed?.claim ?? after;
    notices.push(probed?.notice);
  }
  await sendNotices(deps, scope, notices, after?.name ?? seen.name);
  return after ?? seen;
}

/**
 * In a new unit, applies one check to the claim with `token`: the move of {@link next}, holding or releasing the
 * name to match, the record, and the audit event. Undefined when the claim is gone.
 */
async function move(
  deps: CheckDeps,
  scope: TenantScope,
  token: string,
  now: Date,
  check: () => { observation: { featured: boolean; passed: boolean }; lastResult: LastResult },
): Promise<Moved | undefined> {
  let routed = false;
  const moved = await deps.tenancy.db(scope).transaction(async (tx) => {
    const current = await getClaim(tx, { forUpdate: true });
    if (current === undefined || current.token !== token) return undefined;
    const { observation, lastResult: seen } = check();
    const since = { createdAt: current.createdAt, failingSince: current.failingSince };
    let to = next(current.state, observation, now, since);
    let lastResult: LastResult = seen;
    if (to === 'verified' && (await hold(tx, current.name)) === 'held-elsewhere') {
      // Another tenant proved the name first: this claim stays where it was, and learns nothing about who.
      to = next(current.state, { ...observation, passed: false }, now, since);
      lastResult = { ...seen, heldElsewhere: true, message: 'Another team holds this name, so it cannot be used.' };
    }
    if (to === 'verified' && current.state !== 'verified') {
      await setLive(tx, current.name, false);
      routed = true;
    }
    if (isHeld(current.state) && !isHeld(to)) {
      await release(tx, current.name);
      routed = true;
    }
    const write: CheckRecord = {
      state: to,
      lastResult,
      checkedAt: now,
      failingSince: to === 'failing' ? (current.failingSince ?? now) : null,
      ...(to === 'verified' && current.state !== 'verified' ? { verifiedAt: now } : {}),
    };
    if (!(await record(tx, token, write))) throw claimGone();
    const notice = await audited(deps, tx, current, to, lastResult.message);
    const claim = (await getClaim(tx))!;
    return notice === undefined ? { claim } : { claim, notice };
  });
  if (routed) deps.hostsChanged?.();
  return moved;
}

/** Probes a verified name and, on a pass, marks it live and the claim `active`. */
async function probeName(deps: CheckDeps, scope: TenantScope, claim: Claim, now: Date): Promise<Moved | undefined> {
  let probed: ProbeResult;
  try {
    probed = await deps.probe!(claim.name);
  } catch (error) {
    probed = { verdict: 'missing', message: `The certificate check failed: ${(error as Error).message}` };
  }
  const probedMove = await deps.tenancy.db(scope).transaction(async (tx) => {
    const current = await getClaim(tx, { forUpdate: true });
    if (current === undefined || current.token !== claim.token || current.state !== 'verified') return undefined;
    const base = current.lastResult ?? { cname: 'ok', txt: 'ok', message: '' };
    const lastResult: LastResult = {
      ...base,
      certificate: probed.verdict,
      probedAt: now.toISOString(),
      message: probed.message,
    };
    const live = probed.verdict === 'ok' && (await setLive(tx, current.name, true));
    const to: DomainState = live ? 'active' : 'verified';
    const written = await record(tx, current.token, {
      state: to,
      lastResult,
      checkedAt: current.checkedAt ?? now,
      failingSince: null,
      ...(live ? { activeAt: now } : {}),
    });
    if (!written) throw claimGone();
    const notice = await audited(deps, tx, current, to, probed.message);
    const after = (await getClaim(tx))!;
    return notice === undefined ? { claim: after } : { claim: after, notice };
  });
  // Live now: the resolver maps the name from here on.
  if (probedMove?.claim.state === 'active') deps.hostsChanged?.();
  return probedMove;
}

/**
 * The claim went between the read and the record. The row lock makes that impossible; this is the second line: the
 * unit rolls back, so a `hold` or `setLive` made in it never outlives its claim.
 */
function claimGone(): Error {
  return new Error('the custom-domain claim was removed during its check; nothing was kept');
}

/** Records the move from `current.state` to `to`, if it is one, and answers the mail it calls for. */
async function audited(
  deps: CheckDeps,
  tx: TenantQuerier,
  current: Claim,
  to: DomainState,
  detail: string,
): Promise<Moved['notice']> {
  // No move ends in `pending`, so every move has its action.
  if (to === current.state || !Object.hasOwn(AUDIT_ACTION, to)) return undefined;
  const action = AUDIT_ACTION[to as keyof typeof AUDIT_ACTION];
  await recordAudit(deps.hooks, tx, {
    ...SYSTEM_SOURCE,
    action,
    target: { kind: 'custom-domain' },
    details: { name: current.name, from: current.state, to },
  });
  if (deps.mail === undefined || !NOTICES.includes(to)) return undefined;
  return { kind: to as DomainNotice, to: await serverAdminEmails(tx), detail };
}

async function sendNotices(
  deps: CheckDeps,
  scope: TenantScope,
  notices: readonly Moved['notice'][],
  name: string,
): Promise<void> {
  for (const notice of notices) {
    if (notice === undefined || notice.to.length === 0 || deps.mail === undefined) continue;
    try {
      await deps.mail(notice.to, domainEmail(notice.kind, name, notice.detail));
    } catch (error) {
      deps.log.warn(
        { err: error, job: CHECK_JOB, tenantId: scope.tenantId, notice: notice.kind },
        'custom domains: a mail was not sent',
      );
    }
  }
}
