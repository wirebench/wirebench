/**
 * Opening a schedule's tab, and what the Schedules node's, a schedule's and a runnable row's menus run
 * (#517). The tab id — `schedule:<scheduleId>` — is fixed here because the explorer, the tab and the
 * delete all use it. Every change re-reads the list at once: the live message reaches only finished runs.
 */
import { showToast } from '../../components/toast.js';
import { useEditorsStore } from '../../state/editors.js';
import { ipc } from '../../state/ipc-client.js';
import { useSchedulesStore } from '../../state/schedules.js';
import { useSyncStore } from '../../state/sync.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import { useSchedulesDialogs } from './schedules-dialogs-state.js';

export function scheduleTabId(scheduleId: string): string {
  return `schedule:${scheduleId}`;
}

/** Opens (or focuses) the schedule's tab. One the store does not list is ignored. */
export function openScheduleTab(scheduleId: string): void {
  const schedule = useSchedulesStore.getState().schedules.find((candidate) => candidate.id === scheduleId);
  if (schedule === undefined) return;
  useEditorsStore
    .getState()
    .open({ id: scheduleTabId(scheduleId), kind: 'schedule', title: schedule.name, scheduleId });
}

/** Whether the caller may change schedules: a workspace admin of a server that runs them. */
export function canManageSchedules(): boolean {
  return useSchedulesStore.getState().available === true && useSyncStore.getState().status.role === 'admin';
}

function refOf(scheduleId: string): { url: string; workspaceId: string; scheduleId: string } | undefined {
  const server = useSchedulesStore.getState().server;
  return server === undefined ? undefined : { url: server.url, workspaceId: server.workspaceId, scheduleId };
}

const ALERT_KIND_LABEL = { email: 'Email', slack: 'Slack', teams: 'Teams', webhook: 'Webhook' } as const;

export const schedulesActions = {
  newSchedule(): void {
    useSchedulesDialogs.getState().openEdit({ scheduleId: undefined });
  },

  /** **Schedule…** on a project, API, folder, request or sequence row: a new schedule that runs it. */
  async scheduleEntity(entityId: string): Promise<void> {
    const result = await ipc().schedules.targetFor({ entityId });
    if (!result.ok) {
      showToast(`Could not schedule this: ${result.error.message}`);
      return;
    }
    if (result.value.target === null) {
      showToast('There is nothing a schedule can run here.');
      return;
    }
    const projectId = result.value.target.project;
    const project = useWorkspaceStore.getState().workspace?.projects.find((candidate) => candidate.id === projectId);
    if (project?.source === 'linked') {
      showToast('A linked project is not on the server, so a schedule cannot run it.');
      return;
    }
    useSchedulesDialogs.getState().openEdit({ scheduleId: undefined, target: result.value.target });
  },

  edit(scheduleId: string): void {
    useSchedulesDialogs.getState().openEdit({ scheduleId });
  },

  secrets(scheduleId: string): void {
    useSchedulesDialogs.getState().openSecrets(scheduleId);
  },

  confirmDelete(scheduleId: string): void {
    useSchedulesDialogs.getState().askDelete(scheduleId);
  },

  async remove(scheduleId: string): Promise<void> {
    const ref = refOf(scheduleId);
    if (ref === undefined) return;
    const result = await ipc().schedules.remove(ref);
    if (!result.ok) {
      showToast(`Could not delete the schedule: ${result.error.message}`);
      return;
    }
    useEditorsStore.getState().close(scheduleTabId(scheduleId));
    await useSchedulesStore.getState().refresh();
  },

  /** Pauses a running schedule, or resumes a paused one. */
  async setEnabled(scheduleId: string, enabled: boolean): Promise<void> {
    const ref = refOf(scheduleId);
    if (ref === undefined) return;
    const result = await ipc().schedules.update({ ...ref, enabled });
    if (!result.ok) {
      showToast(`Could not ${enabled ? 'resume' : 'pause'} the schedule: ${result.error.message}`);
      return;
    }
    await useSchedulesStore.getState().refresh();
  },

  async runNow(scheduleId: string): Promise<void> {
    const ref = refOf(scheduleId);
    if (ref === undefined) return;
    const result = await ipc().schedules.runNow(ref);
    if (!result.ok) {
      showToast(`Could not start a run: ${result.error.message}`);
      return;
    }
    showToast(result.value.run.status === 'skipped' ? 'Skipped: the last run is still going' : 'Run queued');
    await useSchedulesStore.getState().runChanged(scheduleId);
  },

  async cancelRun(scheduleId: string, runId: string): Promise<void> {
    const ref = refOf(scheduleId);
    if (ref === undefined) return;
    const result = await ipc().schedules.cancelRun({ ...ref, runId });
    if (!result.ok) {
      showToast(`Could not cancel the run: ${result.error.message}`);
      return;
    }
    await useSchedulesStore.getState().runChanged(scheduleId);
  },

  /** Sends a test message to every alert target and says how each went. */
  async testAlerts(scheduleId: string): Promise<void> {
    const ref = refOf(scheduleId);
    if (ref === undefined) return;
    const result = await ipc().schedules.testAlerts(ref);
    if (!result.ok) {
      showToast(`Could not send a test alert: ${result.error.message}`);
      return;
    }
    const results = result.value.results;
    if (results.length === 0) {
      showToast('This schedule has no alert targets.');
      return;
    }
    const failed = results.filter((entry) => !entry.ok);
    showToast(
      failed.length === 0
        ? `Test alert sent to ${String(results.length)} target${results.length === 1 ? '' : 's'}`
        : `Test alert failed for ${failed
            .map((entry) => `${ALERT_KIND_LABEL[entry.kind]} ${String(entry.index + 1)}: ${entry.error ?? 'failed'}`)
            .join('; ')}`,
    );
  },
};
