import { isWirebenchError } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import { isTimeZone, nextFire, parseSchedule } from '../../../src/schedules/cron.js';

function cronOf(text: string, zone = 'UTC'): string {
  const parsed = parseSchedule(text, zone);
  if (isWirebenchError(parsed)) {
    throw parsed;
  }
  return parsed.cron;
}

function codeOf(text: string, zone = 'UTC'): string | undefined {
  const parsed = parseSchedule(text, zone);
  return isWirebenchError(parsed) ? parsed.code : undefined;
}

describe('parseSchedule (scheduled-runs §3.1)', () => {
  it('keeps five-field cron, single-spaced', () => {
    expect(cronOf('*/5   * * * *')).toBe('*/5 * * * *');
    expect(cronOf('0 9-17 * * MON-FRI')).toBe('0 9-17 * * MON-FRI');
    expect(cronOf('15,45 8 1 JAN,JUL *')).toBe('15,45 8 1 JAN,JUL *');
  });

  it('turns the shortcuts into the cron they mean', () => {
    expect(cronOf('@hourly')).toBe('0 * * * *');
    expect(cronOf('@DAILY')).toBe('0 0 * * *');
    expect(cronOf('@weekly')).toBe('0 0 * * 0');
    expect(cronOf('@monthly')).toBe('0 0 1 * *');
    expect(cronOf('every 1m')).toBe('* * * * *');
    expect(cronOf('every 5m')).toBe('*/5 * * * *');
    expect(cronOf('every 15m')).toBe('*/15 * * * *');
    expect(cronOf('every 1h')).toBe('0 * * * *');
    expect(cronOf('every 6h')).toBe('0 */6 * * *');
  });

  it('refuses an every that would give unequal intervals', () => {
    expect(codeOf('every 7m')).toBe('schedules-cron-invalid');
    expect(codeOf('every 45m')).toBe('schedules-cron-invalid');
    expect(codeOf('every 5h')).toBe('schedules-cron-invalid');
    expect(codeOf('every 0m')).toBe('schedules-cron-invalid');
  });

  it('refuses what is not standard five-field cron', () => {
    expect(codeOf('* * * *')).toBe('schedules-cron-invalid');
    expect(codeOf('0 * * * * *')).toBe('schedules-cron-invalid');
    expect(codeOf('0 0 L * *')).toBe('schedules-cron-invalid');
    expect(codeOf('0 0 ? * *')).toBe('schedules-cron-invalid');
    expect(codeOf('61 * * * *')).toBe('schedules-cron-invalid');
    expect(codeOf('0 25 * * *')).toBe('schedules-cron-invalid');
    expect(codeOf('0 0 30 2 *')).toBe('schedules-cron-invalid');
    expect(codeOf('hourly')).toBe('schedules-cron-invalid');
  });

  it('refuses a zone it does not know', () => {
    expect(isTimeZone('Europe/Vienna')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
    expect(codeOf('@hourly', 'Mars/Olympus')).toBe('schedules-zone-invalid');
  });
});

describe('nextFire', () => {
  it('is the next fire strictly after the time given', () => {
    expect(nextFire('*/5 * * * *', 'UTC', new Date('2026-10-13T10:00:00.000Z'))?.toISOString()).toBe(
      '2026-10-13T10:05:00.000Z',
    );
    expect(nextFire('*/5 * * * *', 'UTC', new Date('2026-10-13T10:02:30.000Z'))?.toISOString()).toBe(
      '2026-10-13T10:05:00.000Z',
    );
  });

  it('reads the fields in the schedule zone', () => {
    // 09:00 in Vienna is 07:00 UTC in summer time and 08:00 UTC in winter time.
    expect(nextFire('0 9 * * *', 'Europe/Vienna', new Date('2026-07-01T00:00:00.000Z'))?.toISOString()).toBe(
      '2026-07-01T07:00:00.000Z',
    );
    expect(nextFire('0 9 * * *', 'Europe/Vienna', new Date('2026-12-01T00:00:00.000Z'))?.toISOString()).toBe(
      '2026-12-01T08:00:00.000Z',
    );
  });

  it('across spring forward, a time that does not exist that day does not stop the schedule', () => {
    // America/New_York skips 02:00–03:00 on 2026-03-08.
    const fire = nextFire('30 2 * * *', 'America/New_York', new Date('2026-03-08T05:00:00.000Z'));
    expect(fire).not.toBeNull();
    expect(fire!.getTime()).toBeGreaterThan(new Date('2026-03-08T05:00:00.000Z').getTime());
    expect(fire!.getTime()).toBeLessThan(new Date('2026-03-10T00:00:00.000Z').getTime());
  });

  it('across fall back, the repeated wall-clock hour fires once, as cron does', () => {
    // Europe/Vienna repeats 02:00–03:00 on 2026-10-25: 00:00Z and 01:00Z are both 02:00 there.
    let at = new Date('2026-10-24T23:30:00.000Z');
    const fires: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      at = nextFire('0 * * * *', 'Europe/Vienna', at)!;
      fires.push(at.toISOString());
    }
    expect(fires).toEqual([
      '2026-10-25T00:00:00.000Z',
      '2026-10-25T02:00:00.000Z',
      '2026-10-25T03:00:00.000Z',
      '2026-10-25T04:00:00.000Z',
    ]);
  });

  it('after a long gap, the next fire is the next one after the time given, not a missed one', () => {
    expect(nextFire('0 * * * *', 'UTC', new Date('2026-10-16T10:20:00.000Z'))?.toISOString()).toBe(
      '2026-10-16T11:00:00.000Z',
    );
  });
});
