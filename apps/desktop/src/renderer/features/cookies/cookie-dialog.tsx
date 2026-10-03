import { useId, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { KV_INPUT_CLASS } from '../../components/kv-table.js';
import type { CookieKeyWire, StoredCookieWire } from '../../../shared/wire-types.js';

/** An epoch-ms instant as a `datetime-local` value, in local time. */
export function toLocalInput(ms: number): string {
  const date = new Date(ms);
  const pad = (part: number): string => String(part).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A `datetime-local` value as epoch ms; `undefined` for an empty field (a session cookie) or nonsense. */
export function fromLocalInput(text: string): number | undefined {
  if (text.trim() === '') {
    return undefined;
  }
  const ms = new Date(text).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

type FieldName = 'name' | 'value' | 'domain' | 'path' | 'expires';
type FieldErrors = Partial<Record<FieldName, string>>;

const MAX_COOKIE_BYTES = 4096;

/** Mirrors the wire schema, so a refusal shows on its field before anything is sent. */
/** The value check alone, for the in-place edit; the same rules as the dialog's Value field. */
export function cookieValueError(name: string, value: string): string | undefined {
  return validate({ name, value, domain: 'x', path: '/', expires: '' }).value;
}

function validate(fields: {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly expires: string;
}): FieldErrors {
  const errors: FieldErrors = {};
  if (fields.name === '') {
    errors.name = 'A cookie needs a name.';
  } else if (/[;=\s]/.test(fields.name)) {
    errors.name = 'A name has no semicolon, equals sign or whitespace.';
  }
  if (/[;\r\n\0]/.test(fields.value)) {
    errors.value = 'A value has no semicolon or line break.';
  } else if (new TextEncoder().encode(fields.name + fields.value).length > MAX_COOKIE_BYTES) {
    errors.value = 'A cookie, name and value together, is at most 4096 bytes.';
  }
  if (fields.domain === '') {
    errors.domain = 'A cookie needs a domain.';
  }
  if (!fields.path.startsWith('/')) {
    errors.path = 'A path starts with /.';
  }
  if (fields.expires.trim() !== '' && fromLocalInput(fields.expires) === undefined) {
    errors.expires = 'Expires is not a date and time.';
  }
  return errors;
}

function Field({
  label,
  value,
  onChange,
  error,
  type = 'text',
  placeholder,
}: {
  readonly error?: string | undefined;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly type?: string;
  readonly placeholder?: string;
}) {
  const id = useId();
  return (
    <>
      <label htmlFor={id} className="text-fg-muted">
        {label}
      </label>
      <input
        id={id}
        type={type}
        data-testid={`cookie-field-${label.toLowerCase()}`}
        className={KV_INPUT_CLASS}
        value={value}
        placeholder={placeholder}
        aria-invalid={error !== undefined}
        aria-describedby={error === undefined ? undefined : `${id}-error`}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      {error !== undefined && (
        <p
          id={`${id}-error`}
          role="alert"
          data-testid={`cookie-error-${label.toLowerCase()}`}
          className="col-start-2 -mt-1 text-xs text-status-danger"
        >
          {error}
        </p>
      )}
    </>
  );
}

function Flag({
  label,
  checked,
  onChange,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-sm text-fg-default">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      {label}
    </label>
  );
}

export interface CookieDialogProps {
  readonly open: boolean;
  /** The cookie being edited; `undefined` adds one. */
  readonly cookie: StoredCookieWire | undefined;
  readonly onOpenChange: (open: boolean) => void;
  /** `replaces` names the edited cookie when its name, domain or path changed. */
  readonly onSave: (cookie: StoredCookieWire, replaces: CookieKeyWire | undefined) => void;
}

/** **Edit cookie** and **Add cookie** (cookie jar spec §3). Add needs the value, so the dialog shows it; a row also edits it in place. */
export function CookieDialog({ open, cookie, onOpenChange, onSave }: CookieDialogProps) {
  const [name, setName] = useState(cookie?.name ?? '');
  const [value, setValue] = useState(cookie?.value ?? '');
  const [domain, setDomain] = useState(cookie?.domain ?? '');
  const [path, setPath] = useState(cookie?.path ?? '/');
  const [expires, setExpires] = useState(cookie?.expiresAt === undefined ? '' : toLocalInput(cookie.expiresAt));
  const [secure, setSecure] = useState(cookie?.secure ?? false);
  const [httpOnly, setHttpOnly] = useState(cookie?.httpOnly ?? false);
  const [hostOnly, setHostOnly] = useState(cookie?.hostOnly ?? true);
  const [errors, setErrors] = useState<FieldErrors>({});

  const save = (): void => {
    const nextName = name.trim();
    const nextDomain = domain.trim().replace(/^\./, '').toLowerCase();
    const nextPath = path.trim() === '' ? '/' : path.trim();
    const found = validate({ name: nextName, value, domain: nextDomain, path: nextPath, expires });
    setErrors(found);
    if (Object.keys(found).length > 0) {
      return;
    }
    // The field holds minutes only: an untouched field keeps the exact expiry it was opened with.
    const expiresAt =
      cookie?.expiresAt !== undefined && expires === toLocalInput(cookie.expiresAt)
        ? cookie.expiresAt
        : fromLocalInput(expires);
    const next: StoredCookieWire = {
      name: nextName,
      value,
      domain: nextDomain,
      hostOnly,
      path: nextPath,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      secure,
      httpOnly,
      ...(cookie?.sameSite !== undefined ? { sameSite: cookie.sameSite } : {}),
      createdAt: cookie?.createdAt ?? Date.now(),
    };
    const replaces =
      cookie !== undefined && (cookie.name !== next.name || cookie.domain !== next.domain || cookie.path !== next.path)
        ? { name: cookie.name, domain: cookie.domain, path: cookie.path }
        : undefined;
    onSave(next, replaces);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          aria-describedby={undefined}
          data-testid="cookie-dialog"
          className="fixed top-1/2 left-1/2 w-[28rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <Dialog.Title className="text-md font-medium text-fg-default">
            {cookie === undefined ? 'Add cookie' : 'Edit cookie'}
          </Dialog.Title>
          <div className="mt-3 grid grid-cols-[6rem_1fr] items-center gap-2 text-sm">
            <Field label="Name" error={errors.name} value={name} onChange={setName} />
            <Field label="Value" error={errors.value} value={value} onChange={setValue} />
            <Field
              label="Domain"
              error={errors.domain}
              value={domain}
              onChange={setDomain}
              placeholder="api.example.com"
            />
            <Field label="Path" error={errors.path} value={path} onChange={setPath} />
            <Field label="Expires" error={errors.expires} type="datetime-local" value={expires} onChange={setExpires} />
          </div>
          <p className="mt-1 text-xs text-fg-subtle">Leave Expires empty for a session cookie, which is never saved.</p>
          <div className="mt-3 flex gap-4">
            <Flag label="Secure" checked={secure} onChange={setSecure} />
            <Flag label="HttpOnly" checked={httpOnly} onChange={setHttpOnly} />
            <Flag label="Host only" checked={hostOnly} onChange={setHostOnly} />
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button>Cancel</Button>
            </Dialog.Close>
            <Button variant="primary" data-testid="cookie-dialog-save" onClick={save}>
              Save
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
