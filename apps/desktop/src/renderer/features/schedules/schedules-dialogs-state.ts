/** Which schedules dialog is open: the schedule dialog (create or edit), its secrets, or a confirmation. */
import { create } from 'zustand';
import type { ScheduleTargetWire } from '@shared/schedules-wire.js';

/** `scheduleId` `undefined` creates a schedule, with `target` filled in by **Schedule…** on a row. */
export interface ScheduleEdit {
  readonly scheduleId: string | undefined;
  readonly target?: ScheduleTargetWire;
}

interface SchedulesDialogsState {
  readonly edit: ScheduleEdit | undefined;
  readonly secrets: { readonly scheduleId: string } | undefined;
  readonly confirmDelete: { readonly scheduleId: string } | undefined;
  readonly openEdit: (edit: ScheduleEdit) => void;
  readonly closeEdit: () => void;
  readonly openSecrets: (scheduleId: string) => void;
  readonly closeSecrets: () => void;
  readonly askDelete: (scheduleId: string) => void;
  readonly closeDelete: () => void;
}

export const useSchedulesDialogs = create<SchedulesDialogsState>((set) => ({
  edit: undefined,
  secrets: undefined,
  confirmDelete: undefined,
  openEdit: (edit) => set({ edit }),
  closeEdit: () => set({ edit: undefined }),
  openSecrets: (scheduleId) => set({ secrets: { scheduleId } }),
  closeSecrets: () => set({ secrets: undefined }),
  askDelete: (scheduleId) => set({ confirmDelete: { scheduleId } }),
  closeDelete: () => set({ confirmDelete: undefined }),
}));
