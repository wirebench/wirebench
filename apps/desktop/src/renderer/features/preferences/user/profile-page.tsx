/**
 * User settings → Profile (settings split spec §4): your name, which you can change, and your email and sign-in
 * methods, which the server owns.
 */
import { useState } from 'react';
import type { AccountProfileWire } from '@shared/wire-base.js';
import { SettingsGroup, SettingsItem } from '../../../components/settings-grid.js';
import { MAX_DISPLAY_NAME_LENGTH, useUserSettingsStore } from '../../../state/user-settings.js';

export const USER_INPUT =
  'h-row w-full min-w-0 rounded-md border border-hairline-strong bg-surface-raised px-2 text-sm text-fg-default focus:outline-none focus:ring-1 focus:ring-accent read-only:text-fg-subtle';

/** "Password", then one line per identity provider. */
export function methodLines(methods: AccountProfileWire['methods']): string[] {
  return [
    ...(methods.local ? ['Password'] : []),
    ...methods.oidc.map((provider) => `Single sign-on · ${provider.issuer}`),
  ];
}

export function ProfilePage({ profile }: { readonly profile: AccountProfileWire }) {
  const rename = useUserSettingsStore((state) => state.rename);
  const [draft, setDraft] = useState(profile.user.displayName);
  const [error, setError] = useState<string | undefined>(undefined);
  const lines = methodLines(profile.methods);

  const save = async (): Promise<void> => {
    const name = draft.trim();
    if (name === profile.user.displayName) {
      setDraft(name);
      setError(undefined);
      return;
    }
    if (name.length === 0 || name.length > MAX_DISPLAY_NAME_LENGTH) {
      setError(`Enter a name of 1 to ${String(MAX_DISPLAY_NAME_LENGTH)} characters.`);
      return;
    }
    const answer = await rename(name);
    if (answer.ok) {
      setDraft(name);
      setError(undefined);
    } else {
      setError(answer.message);
    }
  };

  return (
    <div data-testid="user-profile">
      <SettingsGroup title="You">
        <SettingsItem>
          <label className="block text-sm text-fg-subtle" htmlFor="user-profile-name">
            Name
          </label>
          <input
            id="user-profile-name"
            data-testid="user-profile-name"
            value={draft}
            maxLength={MAX_DISPLAY_NAME_LENGTH + 1}
            aria-invalid={error !== undefined}
            {...(error === undefined ? {} : { 'aria-describedby': 'user-profile-name-error' })}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            onBlur={() => {
              void save();
            }}
            onKeyDown={(event) => {
              // Enter saves through blur, so one edit is never sent twice.
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') {
                setDraft(profile.user.displayName);
                setError(undefined);
              }
            }}
            className={`${USER_INPUT} mt-1`}
          />
          {error !== undefined && (
            <p
              id="user-profile-name-error"
              data-testid="user-profile-name-error"
              role="alert"
              className="mt-1 text-xs text-status-danger"
            >
              {error}
            </p>
          )}
          <label className="mt-3 block text-sm text-fg-subtle" htmlFor="user-profile-email">
            Email
          </label>
          <input
            id="user-profile-email"
            data-testid="user-profile-email"
            value={profile.user.email}
            readOnly
            className={`${USER_INPUT} mt-1`}
          />
        </SettingsItem>
      </SettingsGroup>
      <SettingsGroup title="How you sign in" hint="Set by the server; a server admin changes these.">
        <SettingsItem>
          <div data-testid="user-profile-methods" className="flex flex-col gap-1 text-sm text-fg-default">
            {lines.length === 0 ? (
              <span className="text-fg-subtle">No sign-in method yet.</span>
            ) : (
              lines.map((line) => <span key={line}>{line}</span>)
            )}
          </div>
        </SettingsItem>
      </SettingsGroup>
    </div>
  );
}
