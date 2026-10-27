/** How a schedule and its runs read in the view (#517). Pure. */
import type {
  AlertTargetWire,
  ScheduleRunStatusWire,
  ScheduleRunWire,
  ScheduleTargetWire,
} from '@shared/schedules-wire.js';
import type { ScheduleState } from '../../state/schedules.js';

export const STATE_LABEL: Readonly<Record<ScheduleState, string>> = {
  ok: 'Passing',
  failing: 'Failing',
  paused: 'Paused',
  never: 'Not run yet',
};

/** The dot's colour, by state. */
export const STATE_DOT: Readonly<Record<ScheduleState, string>> = {
  ok: 'bg-status-success',
  failing: 'bg-status-danger',
  paused: 'bg-fg-subtle',
  never: 'border border-fg-subtle',
};

export const STATUS_TONE: Readonly<Record<ScheduleRunStatusWire, string>> = {
  queued: 'text-fg-muted',
  running: 'text-status-warning',
  passed: 'text-status-success',
  failed: 'text-status-danger',
  errored: 'text-status-danger',
  skipped: 'text-fg-subtle',
  cancelled: 'text-fg-subtle',
};

/** Whether a run can still be cancelled. */
export function isOpen(run: Pick<ScheduleRunWire, 'status'>): boolean {
  return run.status === 'queued' || run.status === 'running';
}

/** A cron line as words (every 5 minutes, hourly, daily at 07:30), for the shapes the dialog's shortcuts make; anything else as written. */
export function describeCron(cron: string): string {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return cron;
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
  const rest = `${day} ${month} ${weekday}`;
  const every = /^\*\/(\d+)$/.exec(minute);
  if (every !== null && hour === '*' && rest === '* * *') return `Every ${every[1]!} minutes`;
  if (minute === '*' && hour === '*' && rest === '* * *') return 'Every minute';
  const everyHours = /^\*\/(\d+)$/.exec(hour);
  if (/^\d+$/.test(minute) && everyHours !== null && rest === '* * *') return `Every ${everyHours[1]!} hours`;
  if (/^\d+$/.test(minute) && hour === '*' && rest === '* * *') return 'Hourly';
  const at = /^\d+$/.test(minute) && /^\d+$/.test(hour) ? `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}` : '';
  if (at !== '' && rest === '* * *') return `Daily at ${at}`;
  if (at !== '' && day === '*' && month === '*' && /^\d$/.test(weekday)) {
    const name = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'][
      Number(weekday)
    ];
    return `${name ?? ''} at ${at}`;
  }
  return cron;
}

/** What a target runs, in a line: names are the open workspace's when it knows them. */
export function describeTarget(
  target: ScheduleTargetWire,
  names: { readonly project?: string; readonly environment?: string },
): string {
  const project = names.project ?? target.project;
  const what =
    target.sequences !== undefined && target.sequences.length > 0
      ? `${String(target.sequences.length)} sequence${target.sequences.length === 1 ? '' : 's'}`
      : target.select !== undefined && target.select.length > 0
        ? target.select.join(', ')
        : 'everything';
  const environment = target.environment === undefined ? '' : ` · ${names.environment ?? target.environment}`;
  return `${project}: ${what}${environment}`;
}

export function alertTargetLabel(target: AlertTargetWire): string {
  switch (target.kind) {
    case 'email':
      return `Email ${target.to.join(', ')}`;
    case 'slack':
      return `Slack ${target.host} …${target.hint}`;
    case 'teams':
      return `Teams ${target.host} …${target.hint}`;
    case 'webhook':
      return `Webhook ${target.host} …${target.hint}${target.signed ? ' (signed)' : ''}`;
  }
}

export function durationText(ms: number): string {
  return ms < 1000 ? `${String(Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** A run's counts in a line: `11 passed, 1 failed`. */
export function countsText(run: Pick<ScheduleRunWire, 'summary' | 'reason'>): string {
  const summary = run.summary;
  if (summary === null) return run.reason ?? '';
  const parts = [`${String(summary.passed)} passed`];
  if (summary.failed > 0) parts.push(`${String(summary.failed)} failed`);
  if (summary.errored > 0) parts.push(`${String(summary.errored)} errored`);
  if (summary.skipped > 0) parts.push(`${String(summary.skipped)} skipped`);
  return parts.join(', ');
}

export function timeText(iso: string | null): string {
  if (iso === null) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}
