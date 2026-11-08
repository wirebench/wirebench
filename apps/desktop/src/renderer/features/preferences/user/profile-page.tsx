/**
 * User settings → Profile (settings split spec §4, user profile spec §3): your cover and photo, your name, username
 * and about text, which you can change, and your email and sign-in methods, which the server owns. Each field saves
 * on its own; a refusal shows the server's words under that field and keeps what you typed.
 */
import { useRef, useState } from 'react';
import type { AccountImageKindWire, AccountProfileWire } from '@shared/wire-base.js';
import { Button } from '../../../components/button.js';
import { PersonAvatar, usePersonImage } from '../../../components/person-avatar.js';
import { SettingsGroup, SettingsItem } from '../../../components/settings-grid.js';
import {
  MAX_ABOUT_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_USERNAME_LENGTH,
  USERNAME_HINT,
  usernameProblem,
  useUserSettingsStore,
} from '../../../state/user-settings.js';
import { CropDialog } from './crop-dialog.js';

export const USER_INPUT =
  'h-row w-full min-w-0 rounded-md border border-hairline-strong bg-surface-raised px-2 text-sm text-fg-default focus:outline-none focus:ring-1 focus:ring-accent read-only:text-fg-subtle';

/** What the file picker offers (spec §3); a GIF gives its first frame. */
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

/** "Password", then one line per identity provider. */
export function methodLines(methods: AccountProfileWire['methods']): string[] {
  return [
    ...(methods.local ? ['Password'] : []),
    ...methods.oidc.map((provider) => `Single sign-on · ${provider.issuer}`),
  ];
}

function FieldError({ id, message }: { readonly id: string; readonly message: string | undefined }) {
  if (message === undefined) return null;
  return (
    <p id={id} data-testid={id} role="alert" className="mt-1 text-xs text-status-danger">
      {message}
    </p>
  );
}

const describedBy = (id: string, error: string | undefined) => (error === undefined ? {} : { 'aria-describedby': id });

function NameField({ profile }: { readonly profile: AccountProfileWire }) {
  const rename = useUserSettingsStore((state) => state.rename);
  const [draft, setDraft] = useState(profile.user.displayName);
  const [error, setError] = useState<string | undefined>(undefined);

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
    <>
      <label className="block text-sm text-fg-subtle" htmlFor="user-profile-name">
        Name
      </label>
      <input
        id="user-profile-name"
        data-testid="user-profile-name"
        value={draft}
        maxLength={MAX_DISPLAY_NAME_LENGTH + 1}
        aria-invalid={error !== undefined}
        {...describedBy('user-profile-name-error', error)}
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
      <FieldError id="user-profile-name-error" message={error} />
    </>
  );
}

function UsernameField({ profile }: { readonly profile: AccountProfileWire }) {
  const setUsername = useUserSettingsStore((state) => state.setUsername);
  const serverError = useUserSettingsStore((state) => state.errors.username);
  const clearError = useUserSettingsStore((state) => state.clearError);
  const saved = profile.user.username ?? '';
  const [draft, setDraft] = useState(saved);
  const [localError, setLocalError] = useState<string | undefined>(undefined);
  const error = localError ?? serverError;

  const save = async (): Promise<void> => {
    const typed = draft.trim();
    if (typed.toLowerCase() === saved.toLowerCase()) {
      setDraft(saved);
      setLocalError(undefined);
      clearError('username');
      return;
    }
    const problem = typed.length === 0 ? undefined : usernameProblem(typed);
    if (problem !== undefined) {
      setLocalError(problem);
      return;
    }
    setLocalError(undefined);
    const answer = await setUsername(typed.length === 0 ? null : typed);
    // What the server stored (lower-cased); a refusal keeps the draft.
    if (answer.ok) setDraft(useUserSettingsStore.getState().profile?.user.username ?? '');
  };

  return (
    <>
      <label className="mt-3 block text-sm text-fg-subtle" htmlFor="user-profile-username">
        Username
      </label>
      <div
        className={`${USER_INPUT} mt-1 flex items-center gap-0.5 focus-within:ring-1 focus-within:ring-accent`}
        data-testid="user-profile-username-box"
      >
        <span aria-hidden="true" className="text-fg-subtle select-none">
          @
        </span>
        <input
          id="user-profile-username"
          data-testid="user-profile-username"
          value={draft}
          maxLength={MAX_USERNAME_LENGTH + 1}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={error !== undefined}
          aria-describedby={error === undefined ? 'user-profile-username-hint' : 'user-profile-username-error'}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onBlur={() => {
            void save();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') {
              setDraft(saved);
              setLocalError(undefined);
              clearError('username');
            }
          }}
          className="h-full min-w-0 flex-1 bg-transparent text-sm text-fg-default focus:outline-none"
        />
      </div>
      {error === undefined ? (
        <p id="user-profile-username-hint" className="mt-1 text-xs text-fg-subtle">
          {USERNAME_HINT}
        </p>
      ) : (
        <FieldError id="user-profile-username-error" message={error} />
      )}
    </>
  );
}

function AboutField({ profile }: { readonly profile: AccountProfileWire }) {
  const setAbout = useUserSettingsStore((state) => state.setAbout);
  const error = useUserSettingsStore((state) => state.errors.about);
  const [draft, setDraft] = useState(profile.user.about);

  const save = async (): Promise<void> => {
    const about = draft.trim();
    if (about === profile.user.about) return;
    const answer = await setAbout(about);
    if (answer.ok) setDraft(useUserSettingsStore.getState().profile?.user.about ?? about);
  };

  return (
    <>
      <div className="mt-3 flex items-baseline justify-between">
        <label className="block text-sm text-fg-subtle" htmlFor="user-profile-about">
          About you
        </label>
        <span data-testid="user-profile-about-count" className="text-xs text-fg-faint tabular-nums">
          {`${String(draft.length)} / ${String(MAX_ABOUT_LENGTH)}`}
        </span>
      </div>
      <textarea
        id="user-profile-about"
        data-testid="user-profile-about"
        rows={4}
        value={draft}
        maxLength={MAX_ABOUT_LENGTH}
        placeholder="Tell people more about you…"
        aria-invalid={error !== undefined}
        {...describedBy('user-profile-about-error', error)}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onBlur={() => {
          void save();
        }}
        className="mt-1 w-full min-w-0 resize-y rounded-md border border-hairline-strong bg-surface-raised px-2 py-1.5 text-sm text-fg-default placeholder:text-fg-faint focus:ring-1 focus:ring-accent focus:outline-none"
      />
      <FieldError id="user-profile-about-error" message={error} />
    </>
  );
}

/** The cover band with the photo over its lower left edge (spec §3), and the controls that change each. */
function ProfileImages({ url, profile }: { readonly url: string | undefined; readonly profile: AccountProfileWire }) {
  const setImage = useUserSettingsStore((state) => state.setImage);
  const removeImage = useUserSettingsStore((state) => state.removeImage);
  const clearError = useUserSettingsStore((state) => state.clearError);
  const errors = useUserSettingsStore((state) => state.errors);
  const photoInput = useRef<HTMLInputElement | null>(null);
  const coverInput = useRef<HTMLInputElement | null>(null);
  const [crop, setCrop] = useState<{ readonly kind: AccountImageKindWire; readonly file: File } | undefined>(undefined);
  const { user } = profile;
  const cover = usePersonImage(url, user.id, 'cover', user.cover?.version);

  const picked = (kind: AccountImageKindWire, input: HTMLInputElement): void => {
    const file = input.files?.[0];
    // Cleared at once, so picking the same file again still opens the dialog.
    input.value = '';
    if (file === undefined) return;
    clearError(kind);
    setCrop({ kind, file });
  };

  const fileInput = (kind: AccountImageKindWire, ref: typeof photoInput) => (
    <input
      ref={ref}
      type="file"
      accept={IMAGE_ACCEPT}
      hidden
      tabIndex={-1}
      aria-hidden="true"
      data-testid={`user-profile-${kind}-input`}
      onChange={(event) => {
        picked(kind, event.currentTarget);
      }}
    />
  );

  return (
    <div data-testid="user-profile-images">
      <div data-testid="user-profile-cover" className="relative aspect-[3/1] w-full bg-accent-surface">
        {cover !== undefined && (
          <img
            src={cover}
            alt=""
            data-testid="user-profile-cover-image"
            draggable={false}
            className="h-full w-full object-cover"
          />
        )}
        <div className="absolute top-2 right-2 flex gap-1">
          <Button
            data-testid="user-profile-cover-change"
            onClick={() => {
              coverInput.current?.click();
            }}
          >
            Change cover…
          </Button>
          {user.cover !== null && (
            <Button
              data-testid="user-profile-cover-remove"
              onClick={() => {
                void removeImage('cover');
              }}
            >
              Remove
            </Button>
          )}
        </div>
      </div>
      <div className="px-4 pb-3">
        {/* Half the 96 px photo over the band; positioned so it paints above it. */}
        <div className="relative -mt-12 flex">
          <PersonAvatar
            url={url}
            userId={user.id}
            name={user.displayName}
            photo={user.photo}
            size="lg"
            className="ring-4 ring-surface-raised"
            testId="user-profile-photo"
          />
        </div>
        <div className="mt-2 flex gap-1">
          <Button
            variant="ghost"
            data-testid="user-profile-photo-change"
            onClick={() => {
              photoInput.current?.click();
            }}
          >
            Change photo…
          </Button>
          {user.photo !== null && (
            <Button
              variant="ghost"
              data-testid="user-profile-photo-remove"
              onClick={() => {
                void removeImage('photo');
              }}
            >
              Remove
            </Button>
          )}
        </div>
        <FieldError id="user-profile-photo-error" message={errors.photo} />
        <FieldError id="user-profile-cover-error" message={errors.cover} />
      </div>
      {fileInput('photo', photoInput)}
      {fileInput('cover', coverInput)}
      <CropDialog
        open={crop !== undefined}
        kind={crop?.kind ?? 'photo'}
        file={crop?.file}
        onCancel={() => {
          if (crop !== undefined) clearError(crop.kind);
          setCrop(undefined);
        }}
        onSave={async (data) => {
          if (crop === undefined) return;
          const answer = await setImage(crop.kind, data);
          // The dialog shows a refusal and stays open, so another crop can be tried.
          if (!answer.ok) throw new Error(answer.message);
          setCrop(undefined);
        }}
      />
    </div>
  );
}

export function ProfilePage({ profile }: { readonly profile: AccountProfileWire }) {
  const url = useUserSettingsStore((state) => state.url);
  const lines = methodLines(profile.methods);

  return (
    <div data-testid="user-profile">
      <SettingsGroup title="You">
        <ProfileImages url={url} profile={profile} />
        <SettingsItem>
          <NameField profile={profile} />
          <UsernameField profile={profile} />
          <AboutField profile={profile} />
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
