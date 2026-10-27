import { create } from 'zustand';
import type { LogSwitchTarget, LogSwitches } from '@shared/session-log-switch.js';
import type { HostsFileWire } from '@shared/ssh-wire.js';
import { showToast } from '../../components/toast.js';
import { ipc } from '../../state/ipc-client.js';
import { ancestorsOf } from './hosts-store.js';

/** Whether the hosts in `groupId` are logged: the group's own switch, else the nearest group above that has one. */
export function groupLogged(file: HostsFileWire, switches: LogSwitches, groupId: string): boolean {
  const chain = [...ancestorsOf(file, 'group', groupId).map((g) => g.id), groupId];
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const own = switches[`group:${chain[i] as string}`];
    if (own !== undefined) return own;
  }
  return false;
}

interface LogSwitchesState {
  /** The open workspace's switches on this machine, keyed `host:<id>` / `group:<id>`. */
  switches: LogSwitches;
  /** The workspace's server records every SSH session (#430): the switches show as on and cannot be changed. */
  team: boolean;
  /** Reads them again; a failure keeps what was shown. */
  load: () => Promise<void>;
  /** Sets a host's or group's own switch (`null` clears it), then reads them again. */
  set: (target: LogSwitchTarget, on: boolean | null) => Promise<void>;
}

/** The session-log switches (#414), shared by the host details panel and a group's menu so both stay in step. */
export const useLogSwitchesStore = create<LogSwitchesState>()((set, get) => ({
  switches: {},
  team: false,
  load: async () => {
    try {
      const result = await ipc().sessionLog.switches({});
      if (result.ok) set({ switches: result.value.switches, team: result.value.team === true });
    } catch {
      // Nothing to read is not worth a message: the switch shows what it showed.
    }
  },
  set: async (target, on) => {
    try {
      const result = await ipc().sessionLog.setSwitch({ target, on });
      if (!result.ok) showToast(result.error.message);
    } catch {
      showToast('The session log switch could not be saved');
    }
    await get().load();
  },
}));
