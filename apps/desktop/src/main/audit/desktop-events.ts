/**
 * The events a desktop reports (desktop audit events spec §2.2; #355 for terminal sessions) and the
 * masking they share (§2.3). Pure: the callers (`send/`, the sequence runner, the SSH service) hand over
 * what happened and the clock. Electron-free.
 */
import { DESKTOP_AUDIT_LIMITS, isSensitiveQueryParam, redactUrl } from '@wirebench/engine';
import type {
  DesktopAuditEvent,
  DesktopRequestSentDetails,
  DesktopSshSessionDetails,
  SequenceOutcome,
  SequenceRunResult,
} from '@wirebench/engine';
import { createStreamMasker } from '@wirebench/ssh';
import { redactSecretValues } from '../redact.js';

const MARKER = /<redacted>|%3Credacted%3E/gi;

/** For a URL `new URL` cannot parse: the value of every sensitive query parameter still becomes the marker. */
function maskQueryText(text: string): string {
  return text.replace(/([?&;])([^=&#;]+)=([^&#;]*)/g, (whole, sep: string, name: string) => {
    let decoded = name;
    try {
      decoded = decodeURIComponent(name);
    } catch {
      /* keep the raw name */
    }
    return isSensitiveQueryParam(decoded) ? `${sep}${name}=<redacted>` : whole;
  });
}

/**
 * For a URL `new URL` cannot parse: a password in its userinfo becomes the marker. The authority runs
 * to the first `/`, `?` or `#`, and the userinfo to its last `@`, as a parser would read them.
 */
function maskUserinfoText(text: string): string {
  return text.replace(/\/\/([^/?#]*)@/, (whole, userinfo: string) => {
    const colon = userinfo.indexOf(':');
    return colon < 0 ? whole : `//${userinfo.slice(0, colon)}:<redacted>@`;
  });
}

/** Cuts `text` at `max`, before a redaction marker the cut would split. */
function cutWhole(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  for (const match of text.matchAll(MARKER)) {
    if (match.index < max && match.index + match[0].length > max) {
      end = match.index;
      break;
    }
  }
  return text.slice(0, end);
}

/**
 * The URL as it may leave the machine: credentials masked whatever the show-secrets toggle says. The
 * session secrets are masked before `redactUrl` (it re-encodes, which could hide one from the masker)
 * and again after it. A URL that does not parse gets the same masking by text: sensitive query values
 * and a userinfo password.
 */
export function maskAuditUrl(url: string): string {
  let parsable = true;
  try {
    new URL(url);
  } catch {
    parsable = false;
  }
  const first = redactSecretValues(url);
  const masked = redactSecretValues(
    parsable ? redactUrl(first, { show: false }) : maskUserinfoText(maskQueryText(first)),
  );
  return cutWhole(masked, DESKTOP_AUDIT_LIMITS.maxUrlLength);
}

export type RequestSentInput = Omit<DesktopRequestSentDetails, 'durationMs'> & { readonly durationMs: number };

export function requestSentEvent(input: RequestSentInput): DesktopAuditEvent {
  return {
    action: 'desktop.request_sent',
    details: {
      ...input,
      url: maskAuditUrl(input.url),
      durationMs: Math.max(0, Math.round(input.durationMs)),
      method: input.method === null ? null : input.method.slice(0, 256),
      requestName: input.requestName.slice(0, 256),
    },
  };
}

/** `cancelled` is for a run the user stopped; the engine's outcome has no such value. */
export function runFinishedEvent(
  result: SequenceRunResult,
  startedAt: string,
  now: Date,
  environment: string | null,
  cancelled = false,
): DesktopAuditEvent {
  const counts: Record<SequenceOutcome, number> = { passed: 0, failed: 0, errored: 0, skipped: 0 };
  const hosts = new Set<string>();
  for (const step of result.steps) {
    // A run of a step that a later run superseded (#347) does not count, so it counts as skipped.
    counts[step.retried === true ? 'skipped' : step.outcome]++;
    if (step.origin !== undefined) hosts.add(maskAuditUrl(step.origin));
  }
  return {
    action: 'desktop.run_finished',
    details: {
      sequenceId: result.sequenceId,
      sequenceName: result.name.slice(0, 256),
      outcome: cancelled ? 'cancelled' : result.outcome,
      ...counts,
      durationMs: Math.max(0, now.getTime() - new Date(startedAt).getTime()),
      hosts: [...hosts].slice(0, DESKTOP_AUDIT_LIMITS.maxHosts),
      environment,
      startedAt,
      sentAt: now.toISOString(),
    },
  };
}

/**
 * What the SSH service knows of a session when it ends, without its credentials: the type forbids a
 * password, key, passphrase or environment value, and the two free-text fields are masked below.
 */
export interface SshSessionInput {
  readonly protocol: DesktopSshSessionDetails['protocol'];
  readonly hostId: string;
  /** The target's address (the last hop's, the Telnet device's, or the serial device's path). */
  readonly address: string;
  readonly port: number;
  /** The login name; `''` for a serial line. */
  readonly user: string;
  /** The values the session signed in with or read into its environment: masked wherever they appear. */
  readonly secrets: readonly string[];
  readonly startedAt: Date;
  readonly endedAt: Date;
  /** `undefined` when the window closed the session, so the channel reported no exit. */
  readonly exit: { readonly code: number | null; readonly reason: 'exit' | 'lost' | 'closed' } | undefined;
}

/**
 * `text` with every secret of the session masked, as the terminal's own masker masks the screen, and
 * then the session's recorded secrets (`redactSecretValues`): a host whose address or login name was
 * read from a secret never shows it in the trail.
 */
function maskSessionText(text: string, secrets: readonly string[]): string {
  const masker = createStreamMasker();
  masker.add(secrets);
  const bytes = Buffer.from(text, 'utf8');
  const masked = Buffer.concat([masker.push(bytes), masker.flush()]).toString('utf8');
  return redactSecretValues(masked);
}

export function sshSessionEvent(input: SshSessionInput): DesktopAuditEvent {
  const address = maskSessionText(input.address, input.secrets).slice(0, DESKTOP_AUDIT_LIMITS.maxUrlLength);
  return {
    action: 'desktop.ssh_session',
    details: {
      protocol: input.protocol,
      hostId: input.hostId.slice(0, 128),
      address: address.length === 0 ? '-' : address,
      port: Math.min(65535, Math.max(0, Math.round(input.port))),
      user: maskSessionText(input.user, input.secrets).slice(0, 256),
      exitCode: input.exit?.code ?? null,
      reason: input.exit?.reason ?? 'closed',
      durationMs: Math.max(0, input.endedAt.getTime() - input.startedAt.getTime()),
      startedAt: input.startedAt.toISOString(),
      endedAt: input.endedAt.toISOString(),
      sentAt: input.endedAt.toISOString(),
    },
  };
}
