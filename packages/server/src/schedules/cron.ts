/**
 * A schedule's timing (scheduled-runs spec §3.1): five-field cron in an IANA time zone, at most one run a
 * minute. A shortcut is stored as the cron it means, so a read shows one form. Pure.
 */
import { Cron } from 'croner';
import type { WirebenchError } from '@wirebench/engine';
import { cronInvalid, zoneInvalid } from './errors.js';

const PRESETS: Readonly<Record<string, string>> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
};

/** Digits, month and day names, `*`, ranges, lists and steps: the standard five fields, none of the extensions. */
const FIELD = /^[0-9A-Za-z*,/-]+$/;
const NAMES = new Set([
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
  'SUN',
  'MON',
  'TUE',
  'WED',
  'THU',
  'FRI',
  'SAT',
]);

function isStandardField(field: string): boolean {
  return FIELD.test(field) && (field.match(/[A-Za-z]+/g) ?? []).every((word) => NAMES.has(word.toUpperCase()));
}

/** `every 5m` and `every 2h`, which must divide the hour and the day so every interval is equal. */
function fromEvery(text: string): string | WirebenchError | undefined {
  const match = /^every\s+(\d{1,2})\s*([mh])$/i.exec(text);
  if (match === null) {
    return undefined;
  }
  const count = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  if (unit === 'm') {
    if (count < 1 || count > 30 || 60 % count !== 0) {
      return cronInvalid('every <n>m needs n to divide 60 (1, 2, 3, 4, 5, 6, 10, 12, 15, 20 or 30)');
    }
    return count === 1 ? '* * * * *' : `*/${count} * * * *`;
  }
  if (count < 1 || count > 12 || 24 % count !== 0) {
    return cronInvalid('every <n>h needs n to divide 24 (1, 2, 3, 4, 6, 8 or 12)');
  }
  return count === 1 ? '0 * * * *' : `0 */${count} * * *`;
}

/** Whether `zone` is an IANA time zone this runtime knows. */
export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The canonical cron for what a workspace admin typed, checked in `zone`.
 *
 * @returns the five fields, single-spaced, or the problem to answer (`schedules-cron-invalid`,
 *   `schedules-zone-invalid`)
 */
export function parseSchedule(text: string, zone: string): { readonly cron: string } | WirebenchError {
  if (!isTimeZone(zone)) {
    return zoneInvalid(zone);
  }
  const trimmed = text.trim();
  const preset = PRESETS[trimmed.toLowerCase()];
  const every = preset === undefined ? fromEvery(trimmed) : undefined;
  if (every !== undefined && typeof every !== 'string') {
    return every;
  }
  const cron = preset ?? every ?? trimmed.split(/\s+/).join(' ');
  const fields = cron.split(' ');
  if (fields.length !== 5) {
    return cronInvalid(`expected five fields (minute hour day-of-month month day-of-week), found ${fields.length}`);
  }
  if (!fields.every(isStandardField)) {
    return cronInvalid('a field holds a character standard cron does not use');
  }
  try {
    const job = new Cron(cron, { timezone: zone, mode: '5-part', paused: true });
    if (job.nextRun() === null) {
      return cronInvalid('it never fires');
    }
  } catch (error) {
    return cronInvalid(error instanceof Error ? error.message.replace(/\.$/, '') : 'it does not parse');
  }
  return { cron };
}

/** The first fire of `cron` in `zone` strictly after `after`, or null when there is none. */
export function nextFire(cron: string, zone: string, after: Date): Date | null {
  return new Cron(cron, { timezone: zone, mode: '5-part', paused: true }).nextRun(after);
}
