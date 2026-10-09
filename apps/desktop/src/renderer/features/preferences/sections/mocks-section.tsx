import { BooleanSetting, SettingsGroup } from '../../../components/settings-grid.js';
import type { SectionProps } from './section-props.js';

/**
 * Mock services (#59). One setting, off by default: a started mock listens on loopback, reachable from
 * this machine only. Turning this on binds every interface, and a mock tab then says so; no project
 * file can turn it on.
 */
export function MocksSection({ preferences, update, locked = () => false }: SectionProps) {
  return (
    <SettingsGroup title="Mock services">
      <BooleanSetting
        label="Listen on all interfaces"
        testId="preferences-mocks-all-interfaces"
        value={preferences.mocks.listenOnAllInterfaces}
        locked={locked('mocks.listenOnAllInterfaces')}
        onChange={(listenOnAllInterfaces) => update({ mocks: { listenOnAllInterfaces } })}
        hint="Off, a mock answers this machine only. On, anything that can reach this machine can call it. Applies to mocks started afterwards."
      />
    </SettingsGroup>
  );
}
