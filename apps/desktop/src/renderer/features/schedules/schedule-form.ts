/**
 * The schedule dialog's form as data (#517): what it starts from, what the server would refuse, and the
 * request it sends. Pure, so every rule is unit-tested without mounting the dialog.
 *
 * An alert target's URL is write-only: a read shows its host and last four characters. So the alerts
 * are sent only when the user changed them, and then a kept Slack, Teams or webhook target must have
 * its URL entered again.
 */
import type {
  AlertTargetInputWire,
  AlertTargetWire,
  ScheduleChoiceWire,
  ScheduleTargetWire,
  ScheduleWire,
} from '@shared/schedules-wire.js';

/** The server's bounds (scheduled-runs spec §3, `SCHEDULE_LIMITS`), restated: the engine is not a renderer import. */
export const SCHEDULE_FORM_LIMITS = {
  maxNameLength: 100,
  maxTimeoutMinutes: 120,
  defaultTimeoutMinutes: 15,
  maxMuteAfter: 100,
  defaultMuteAfter: 3,
  maxTargets: 10,
  maxEmailRecipients: 20,
  minWebhookSecret: 16,
} as const;

export type AlertKind = AlertTargetWire['kind'];

export interface AlertRow {
  readonly kind: AlertKind;
  /** Email: the addresses, separated by commas or spaces. */
  readonly to: string;
  /** Slack, Teams, webhook: the URL, empty for a kept one until entered again. */
  readonly url: string;
  /** Webhook: the signing secret, empty for none. */
  readonly secret: string;
  /** A kept target's `host …hint`, shown as the URL field's placeholder. */
  readonly was?: string;
}

/** What runs: the whole project, the APIs, folders and requests picked, or sequences. */
export type ScheduleMode = 'all' | 'pick' | 'sequences';

export interface ScheduleForm {
  readonly name: string;
  readonly schedule: string;
  readonly timeZone: string;
  readonly projectId: string;
  /** An environment's id, or `''` for none. */
  readonly environment: string;
  readonly mode: ScheduleMode;
  /** The ids of the picked choices. */
  readonly picked: readonly string[];
  /** Selectors of the schedule no choice of the open workspace stands for: kept as they are. */
  readonly extraSelectors: readonly string[];
  readonly sequences: readonly string[];
  readonly timeoutMinutes: string;
  readonly bail: boolean;
  readonly allowProtected: boolean;
  readonly insecureTls: boolean;
  readonly enabled: boolean;
  /** Whether the alerts were changed; untouched, an edit leaves them as they are. */
  readonly alertsTouched: boolean;
  readonly alerts: readonly AlertRow[];
  readonly muteAfter: string;
}

export function emptyAlertRow(kind: AlertKind): AlertRow {
  return { kind, to: '', url: '', secret: '' };
}

function alertRowOf(target: AlertTargetWire): AlertRow {
  if (target.kind === 'email') return { kind: 'email', to: target.to.join(', '), url: '', secret: '' };
  return { kind: target.kind, to: '', url: '', secret: '', was: `${target.host} …${target.hint}` };
}

/** The form a dialog opens with: the schedule's own values, a **Schedule…** target, or the defaults. */
export function formOf(
  schedule: ScheduleWire | undefined,
  options: { readonly target?: ScheduleTargetWire; readonly timeZone: string; readonly projectId?: string },
): ScheduleForm {
  const target = schedule?.target ?? options.target;
  const sequences = target?.sequences ?? [];
  const select = target?.select ?? [];
  return {
    name: schedule?.name ?? '',
    schedule: schedule?.cron ?? '',
    timeZone: schedule?.timeZone ?? options.timeZone,
    projectId: target?.project ?? options.projectId ?? '',
    environment: target?.environment ?? '',
    mode: sequences.length > 0 ? 'sequences' : select.length > 0 ? 'pick' : 'all',
    picked: [],
    extraSelectors: select,
    sequences,
    timeoutMinutes: String(schedule?.options.timeoutMinutes ?? SCHEDULE_FORM_LIMITS.defaultTimeoutMinutes),
    bail: schedule?.options.bail ?? false,
    allowProtected: schedule?.options.allowProtected ?? false,
    insecureTls: schedule?.options.insecureTls ?? false,
    enabled: schedule?.enabled ?? true,
    alertsTouched: false,
    alerts: (schedule?.alerts.targets ?? []).map(alertRowOf),
    muteAfter: String(schedule?.alerts.muteAfter ?? SCHEDULE_FORM_LIMITS.defaultMuteAfter),
  };
}

/**
 * Lays the target's selectors over the project's choices once they are known: a choice whose every
 * selector the target names is picked, and what is left stays a selector of its own.
 */
export function withChoices(form: ScheduleForm, choices: readonly ScheduleChoiceWire[]): ScheduleForm {
  const wanted = new Set(form.extraSelectors);
  const picked = choices.filter(
    (choice) => choice.selectors.length > 0 && choice.selectors.every((selector) => wanted.has(selector)),
  );
  const covered = new Set(picked.flatMap((choice) => choice.selectors));
  return {
    ...form,
    picked: picked.map((choice) => choice.id),
    extraSelectors: form.extraSelectors.filter((selector) => !covered.has(selector)),
  };
}

const whole = (text: string, min: number, max: number): boolean =>
  /^\d+$/.test(text.trim()) && Number(text) >= min && Number(text) <= max;

export function addressesOf(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((address) => address.trim())
    .filter((address) => address.length > 0);
}

function isHttpsUrl(text: string): boolean {
  try {
    const url = new URL(text.trim());
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

/** The first thing the server would refuse, in the words the dialog shows; `undefined` when none. */
export function problemOf(form: ScheduleForm): string | undefined {
  const name = form.name.trim();
  if (name.length === 0) return 'Give the schedule a name.';
  if (name.length > SCHEDULE_FORM_LIMITS.maxNameLength)
    return `Names are at most ${String(SCHEDULE_FORM_LIMITS.maxNameLength)} characters.`;
  if (form.schedule.trim().length === 0) return 'Say when it runs: cron, @hourly, @daily, @weekly or every 5m.';
  if (form.timeZone.trim().length === 0) return 'Pick a time zone.';
  if (form.projectId === '') return 'Pick the project it runs.';
  if (form.mode === 'pick' && form.picked.length === 0 && form.extraSelectors.length === 0)
    return 'Pick at least one API, folder or request.';
  if (form.mode === 'sequences' && form.sequences.length === 0) return 'Pick at least one sequence.';
  if (!whole(form.timeoutMinutes, 1, SCHEDULE_FORM_LIMITS.maxTimeoutMinutes))
    return `The timeout is 1 to ${String(SCHEDULE_FORM_LIMITS.maxTimeoutMinutes)} minutes.`;
  if (!form.alertsTouched) return undefined;
  if (!whole(form.muteAfter, 0, SCHEDULE_FORM_LIMITS.maxMuteAfter))
    return `Mute after is 0 to ${String(SCHEDULE_FORM_LIMITS.maxMuteAfter)} failing runs (0 never mutes).`;
  if (form.alerts.length > SCHEDULE_FORM_LIMITS.maxTargets)
    return `At most ${String(SCHEDULE_FORM_LIMITS.maxTargets)} alert targets.`;
  for (const [index, row] of form.alerts.entries()) {
    const which = `Alert ${String(index + 1)}`;
    if (row.kind === 'email') {
      const addresses = addressesOf(row.to);
      if (addresses.length === 0) return `${which}: enter at least one email address.`;
      if (addresses.length > SCHEDULE_FORM_LIMITS.maxEmailRecipients)
        return `${which}: at most ${String(SCHEDULE_FORM_LIMITS.maxEmailRecipients)} addresses.`;
      const bad = addresses.find((address) => !/^[^@\s]+@[^@\s]+$/.test(address));
      if (bad !== undefined) return `${which}: "${bad}" is not an email address.`;
      continue;
    }
    if (row.url.trim() === '')
      return row.was === undefined
        ? `${which}: enter the URL.`
        : `${which}: enter the URL again (only ${row.was} can be read back).`;
    if (!isHttpsUrl(row.url)) return `${which}: the URL must start with https:// and carry no user name or password.`;
    if (row.kind === 'webhook' && row.secret !== '' && row.secret.length < SCHEDULE_FORM_LIMITS.minWebhookSecret)
      return `${which}: a signing secret is at least ${String(SCHEDULE_FORM_LIMITS.minWebhookSecret)} characters.`;
  }
  return undefined;
}

/** The selectors the form's picks stand for, each once, in pick order. */
export function selectorsOf(form: ScheduleForm, choices: readonly ScheduleChoiceWire[]): string[] {
  const byId = new Map(choices.map((choice) => [choice.id, choice]));
  const all = [...form.picked.flatMap((id) => byId.get(id)?.selectors ?? []), ...form.extraSelectors];
  return [...new Set(all)];
}

function alertTargetOf(row: AlertRow): AlertTargetInputWire {
  if (row.kind === 'email') return { kind: 'email', to: addressesOf(row.to) };
  if (row.kind === 'webhook')
    return { kind: 'webhook', url: row.url.trim(), ...(row.secret !== '' ? { secret: row.secret } : {}) };
  return { kind: row.kind, url: row.url.trim() };
}

/** What the dialog sends: the whole schedule on create, and on edit everything but untouched alerts. */
export function requestOf(form: ScheduleForm, choices: readonly ScheduleChoiceWire[]) {
  const target: ScheduleTargetWire = {
    project: form.projectId,
    ...(form.environment !== '' ? { environment: form.environment } : {}),
    ...(form.mode === 'pick' ? { select: selectorsOf(form, choices) } : {}),
    ...(form.mode === 'sequences' ? { sequences: [...form.sequences] } : {}),
  };
  return {
    name: form.name.trim(),
    schedule: form.schedule.trim(),
    timeZone: form.timeZone.trim(),
    target,
    options: {
      timeoutMinutes: Number(form.timeoutMinutes),
      bail: form.bail,
      allowProtected: form.allowProtected,
      insecureTls: form.insecureTls,
    },
    enabled: form.enabled,
    ...(form.alertsTouched
      ? { alerts: { targets: form.alerts.map(alertTargetOf), muteAfter: Number(form.muteAfter) } }
      : {}),
  };
}
