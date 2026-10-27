import { EnumSetting, NumberSetting, SettingsGroup, TextSetting } from '../../../components/settings-grid.js';
import { TERMINAL_CHARSETS, terminalTypeProblem } from '@shared/terminal-charsets.js';
import { PREFERENCE_LIMITS } from '../../../state/preference-limits.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../../state/preferences-defaults.js';
import type { SectionProps } from './section-props.js';

const DEFAULTS = DEFAULT_PREFERENCES_WIRE.ssh;

/**
 * Preferences → SSH (#571): the connection defaults every host falls back to when neither it, its groups nor
 * their identities set the value. Host and group forms show a value from here as "from Preferences".
 */
export function SshSection({ preferences, update, locked = () => false }: SectionProps) {
  const ssh = preferences.ssh;
  return (
    <SettingsGroup
      title="Connection defaults"
      hint="Used by every host that does not set its own, directly, through a group or through an identity."
    >
      <TextSetting
        label="Default user"
        setting="ssh.user"
        testId="preferences-ssh-user"
        value={ssh.user ?? ''}
        placeholder="None"
        trim
        locked={locked('ssh.user')}
        validate={(user) => (/\s/.test(user) ? 'A user name has no spaces' : undefined)}
        onCommit={(user) => {
          update({ ssh: { user } });
        }}
        hint="The user a host connects as when nothing nearer names one. Empty leaves it to each host."
      />
      <NumberSetting
        label="Keep-alive"
        value={ssh.keepAlive}
        {...PREFERENCE_LIMITS['ssh.keepAlive']}
        unit="s"
        placeholder={String(DEFAULTS.keepAlive)}
        setting="ssh.keepAlive"
        testId="preferences-ssh-keep-alive"
        locked={locked('ssh.keepAlive')}
        onCommit={(keepAlive) => {
          update({ ssh: { keepAlive: keepAlive ?? DEFAULTS.keepAlive } });
        }}
        hint="Seconds between the messages that keep an idle connection open; 0 sends none."
      />
      <NumberSetting
        label="Connect timeout"
        value={ssh.connectTimeout}
        {...PREFERENCE_LIMITS['ssh.connectTimeout']}
        unit="s"
        placeholder={String(DEFAULTS.connectTimeout)}
        setting="ssh.connectTimeout"
        testId="preferences-ssh-connect-timeout"
        locked={locked('ssh.connectTimeout')}
        onCommit={(connectTimeout) => {
          update({ ssh: { connectTimeout: connectTimeout ?? DEFAULTS.connectTimeout } });
        }}
        hint="Seconds to wait for a server to answer before the connection gives up."
      />
      <TextSetting
        label="Terminal type"
        setting="ssh.term"
        testId="preferences-ssh-term"
        value={ssh.term}
        placeholder={DEFAULTS.term}
        trim
        monospace
        locked={locked('ssh.term')}
        validate={(term) => (term === '' ? undefined : terminalTypeProblem(term))}
        onCommit={(term) => {
          update({ ssh: { term: term === '' ? DEFAULTS.term : term } });
        }}
        hint="The TERM a shell is opened with. Older servers and network devices may need vt100 or xterm."
      />
      <EnumSetting
        label="Character set"
        setting="ssh.charset"
        testId="preferences-ssh-charset"
        display="select"
        value={ssh.charset}
        options={TERMINAL_CHARSETS.map((c) => ({ value: c.id, label: c.label }))}
        locked={locked('ssh.charset')}
        onChange={(charset) => {
          update({ ssh: { charset } });
        }}
        hint="How the terminal reads and writes text. Change it for a server that does not use UTF-8."
      />
    </SettingsGroup>
  );
}
