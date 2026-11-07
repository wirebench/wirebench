/**
 * User settings → Password (settings split spec §4). The three fields live in this component only; they go out once
 * through `account.changePassword` and are cleared after every answer, success or refusal.
 */
import { useState, type FormEvent } from 'react';
import type { AccountProfileWire } from '@shared/wire-base.js';
import { Button } from '../../../components/button.js';
import { SettingsGroup, SettingsItem } from '../../../components/settings-grid.js';
import { MIN_PASSWORD_LENGTH } from '../../account/password-rules.js';
import { useUserSettingsStore } from '../../../state/user-settings.js';
import { USER_INPUT } from './profile-page.js';

const CHANGED = 'Password changed. Your other devices were signed out.';

export function PasswordPage({ profile }: { readonly profile: AccountProfileWire }) {
  const changePassword = useUserSettingsStore((state) => state.changePassword);
  // An account without a password yet (single sign-on only) sets one without a current one.
  const hasPassword = profile.methods.local;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ readonly ok: boolean; readonly message: string } | undefined>(undefined);
  const ready =
    !pending && next.length >= MIN_PASSWORD_LENGTH && repeat === next && (!hasPassword || current.length > 0);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!ready) return;
    setPending(true);
    const answer = await changePassword(hasPassword ? current : undefined, next);
    setCurrent('');
    setNext('');
    setRepeat('');
    setPending(false);
    setResult(answer.ok ? { ok: true, message: CHANGED } : { ok: false, message: answer.message });
  };

  const field = (
    id: string,
    label: string,
    value: string,
    set: (value: string) => void,
    autoComplete: 'current-password' | 'new-password',
  ) => (
    <>
      <label className="mt-3 block text-sm text-fg-subtle first:mt-0" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        data-testid={id}
        type="password"
        autoComplete={autoComplete}
        value={value}
        onChange={(event) => {
          set(event.target.value);
        }}
        className={`${USER_INPUT} mt-1`}
      />
    </>
  );

  return (
    <form
      data-testid="user-password"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <SettingsGroup
        title={hasPassword ? 'Change your password' : 'Set a password'}
        hint={`At least ${String(MIN_PASSWORD_LENGTH)} characters. Every other device you are signed in on is signed out.`}
      >
        <SettingsItem>
          {hasPassword && field('user-password-current', 'Current password', current, setCurrent, 'current-password')}
          {field('user-password-new', 'New password', next, setNext, 'new-password')}
          {field('user-password-repeat', 'Repeat the new password', repeat, setRepeat, 'new-password')}
          {repeat.length > 0 && repeat !== next && (
            <p className="mt-1 text-xs text-fg-subtle">The two new passwords differ.</p>
          )}
          <div className="mt-3 flex items-center gap-3">
            <Button type="submit" variant="primary" data-testid="user-password-submit" disabled={!ready}>
              {hasPassword ? 'Change password' : 'Set password'}
            </Button>
            {result !== undefined && (
              <p
                data-testid="user-password-result"
                role={result.ok ? 'status' : 'alert'}
                className={`text-sm ${result.ok ? 'text-fg-muted' : 'text-status-danger'}`}
              >
                {result.message}
              </p>
            )}
          </div>
        </SettingsItem>
      </SettingsGroup>
    </form>
  );
}
