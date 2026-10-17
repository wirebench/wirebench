/** The schedules dialogs, mounted once in the shell: the schedule dialog, its secrets, and the delete confirmation. */
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { ScheduleDialog } from './schedule-dialog.js';
import { schedulesActions } from './schedules-actions.js';
import { useSchedulesDialogs } from './schedules-dialogs-state.js';
import { ScheduleSecretsDialog } from './secrets-dialog.js';

export function SchedulesDialogs() {
  const confirmDelete = useSchedulesDialogs((state) => state.confirmDelete);
  const closeDelete = useSchedulesDialogs((state) => state.closeDelete);
  return (
    <>
      <ConfirmDialog
        open={confirmDelete !== undefined}
        onOpenChange={(open) => {
          if (!open) closeDelete();
        }}
        title="Delete schedule?"
        description="Deletes the schedule, its run history and its secrets for everyone in the workspace."
        confirmLabel="Delete"
        destructive
        testId="schedule-delete-confirm"
        onConfirm={() => {
          if (confirmDelete !== undefined) void schedulesActions.remove(confirmDelete.scheduleId);
        }}
      />
      <ScheduleDialog />
      <ScheduleSecretsDialog />
    </>
  );
}
