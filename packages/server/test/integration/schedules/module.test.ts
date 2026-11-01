import { afterEach, expect, it } from 'vitest';
import { describeDb } from '../../helpers/database.js';
import { schedulesHarness, type SchedulesCast } from '../../helpers/schedules.js';

let c: SchedulesCast | undefined;
afterEach(async () => {
  await c?.close();
  c = undefined;
});

const capabilities = async (cast: SchedulesCast): Promise<string[]> =>
  (await cast.h.app.inject({ method: 'GET', url: '/api/v1/meta' })).json<{ capabilities: string[] }>().capabilities;

describeDb('the scheduled-runs module (scheduled-runs §4, §6)', () => {
  it('migrates its four tables', async () => {
    c = await schedulesHarness({ enterprise: false });
    const tables = await c.h.tdb.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = $1 and table_name like 'schedule%' order by 1`,
      [c.h.db.schema],
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual([
      'schedule_alert_outbox',
      'schedule_results',
      'schedule_runs',
      'schedules',
    ]);
  });

  it('announces its capability, and switched off it is not there at all', async () => {
    c = await schedulesHarness({ enterprise: false });
    expect(await capabilities(c)).toContain('scheduled-runs');
    await c.close();
    c = await schedulesHarness({ enterprise: false, env: { WIREBENCH_SERVER_SCHEDULES_ENABLED: 'false' } });
    expect(await capabilities(c)).not.toContain('scheduled-runs');
  });
});
