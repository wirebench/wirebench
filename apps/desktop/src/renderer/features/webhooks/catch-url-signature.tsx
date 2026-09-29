/**
 * A catch URL's *Signature* section (webhook-signatures §4): the scheme, a write-only secret shown
 * only as *● set …f789*, and *Reject unverified requests (401)*. Shown when editing an existing
 * catch URL on a server that has the module; the server refuses signature settings until its key
 * is set, and the section says so rather than letting a save fail. Without the key an editor can
 * still switch a signature off — choose *None*, or untick *Reject* — since the server takes both
 * without it, so a catch URL that answers 401 is never stuck.
 */
import { INPUT_CLASS } from '../team/roles.js';
import { Button } from '../../components/button.js';
import { SchemeFields } from './scheme-fields.js';
import { defaultScheme, SCHEME_KINDS, SCHEME_LABELS, schemeProblemOf, SIGNATURE_LIMITS } from './signature-text.js';
import type { SchemeKind } from './signature-text.js';
import type { CatchUrlWire, HooksUpdateRequestWire, SignatureSchemeWire } from '../../../shared/wire-types.js';

export interface SignatureForm {
  /** `null` is *None*. */
  readonly scheme: SignatureSchemeWire | null;
  /** A new secret; empty keeps the stored one. */
  readonly secret: string;
  /** The secret input is open: always when none is stored, after *Replace…* otherwise. */
  readonly replacing: boolean;
  readonly rejectUnverified: boolean;
}

export function signatureFormOf(hook: CatchUrlWire | undefined): SignatureForm {
  const stored = hook?.signature ?? null;
  return {
    scheme: stored?.scheme ?? null,
    secret: '',
    replacing: stored === null,
    rejectUnverified: hook?.rejectUnverified ?? false,
  };
}

export function signatureProblemOf(form: SignatureForm, hook: CatchUrlWire | undefined): string | undefined {
  if (form.scheme === null) return undefined;
  const stored = hook?.signature !== null && hook?.signature !== undefined;
  if (form.secret === '' && !stored) return 'Enter the secret the sender signs with.';
  if (form.secret.length > SIGNATURE_LIMITS.maxSecretLength)
    return `The secret is at most ${String(SIGNATURE_LIMITS.maxSecretLength)} characters.`;
  return schemeProblemOf(form.scheme);
}

const sameScheme = (a: SignatureSchemeWire | null, b: SignatureSchemeWire | null): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** The update fields this section adds, or `{}` when nothing in it changed. */
export function signatureRequestOf(
  form: SignatureForm,
  hook: CatchUrlWire | undefined,
): Pick<HooksUpdateRequestWire, 'signature' | 'rejectUnverified'> {
  const stored = hook?.signature?.scheme ?? null;
  if (form.scheme === null) return stored === null ? {} : { signature: null };
  const out: { signature?: HooksUpdateRequestWire['signature']; rejectUnverified?: boolean } = {};
  if (!sameScheme(form.scheme, stored) || form.secret !== '') {
    out.signature = { scheme: form.scheme, ...(form.secret !== '' ? { secret: form.secret } : {}) };
  }
  if (form.rejectUnverified !== (hook?.rejectUnverified ?? false)) out.rejectUnverified = form.rejectUnverified;
  return out;
}

const UNAVAILABLE_ID = 'catch-url-signature-unavailable';
const SECRET_LABEL_ID = 'catch-url-signature-secret-label';

export function SignatureSection({
  form,
  onChange,
  hook,
  readOnly,
}: {
  readonly form: SignatureForm;
  readonly onChange: (patch: Partial<SignatureForm>) => void;
  readonly hook: CatchUrlWire;
  readonly readOnly: boolean;
}) {
  const unavailable = hook.signatureAvailable === false;
  // Setting or changing a scheme or secret needs the server key; switching one off does not.
  const disabled = readOnly || unavailable;
  const rejectDisabled = readOnly || (unavailable && hook.rejectUnverified !== true);
  const describedBy = unavailable ? UNAVAILABLE_ID : undefined;
  const hint = hook.signature?.secret.hint ?? null;
  const secretStored = hook.signature !== null && hook.signature !== undefined;
  return (
    <fieldset data-testid="catch-url-signature" className="mt-4 border-t border-hairline pt-3">
      <legend className="text-sm font-medium text-fg-default">Signature</legend>
      {unavailable && (
        <p id={UNAVAILABLE_ID} data-testid="catch-url-signature-unavailable" className="mt-1 text-xs text-fg-subtle">
          The server has no WIREBENCH_SERVER_HOOKS_SECRET_KEY, so it cannot keep a signature secret. Ask its
          administrator to set one.
        </p>
      )}
      <label className="mt-2 block text-sm text-fg-subtle" htmlFor="catch-url-signature-scheme">
        Scheme
      </label>
      <select
        id="catch-url-signature-scheme"
        data-testid="catch-url-signature-scheme"
        disabled={readOnly}
        aria-describedby={describedBy}
        value={form.scheme?.kind ?? 'none'}
        onChange={(event) =>
          onChange(
            event.target.value === 'none'
              ? { scheme: null, rejectUnverified: false }
              : { scheme: defaultScheme(event.target.value as SchemeKind) },
          )
        }
        className={INPUT_CLASS}
      >
        <option value="none">None</option>
        {SCHEME_KINDS.map((kind) => (
          <option key={kind} value={kind} disabled={unavailable}>
            {SCHEME_LABELS[kind]}
          </option>
        ))}
      </select>
      {form.scheme !== null && (
        <>
          <SchemeFields
            scheme={form.scheme}
            onChange={(scheme) => onChange({ scheme })}
            disabled={disabled}
            prefix="catch-url-signature"
            describedBy={describedBy}
          />
          {form.replacing || !secretStored ? (
            <label className="mt-2 block text-sm text-fg-subtle" htmlFor="catch-url-signature-secret">
              Secret
            </label>
          ) : (
            <span id={SECRET_LABEL_ID} className="mt-2 block text-sm text-fg-subtle">
              Secret
            </span>
          )}
          {form.replacing || !secretStored ? (
            <input
              id="catch-url-signature-secret"
              data-testid="catch-url-signature-secret"
              type="password"
              autoComplete="off"
              disabled={disabled}
              aria-describedby={describedBy}
              value={form.secret}
              onChange={(event) => onChange({ secret: event.target.value })}
              className={INPUT_CLASS}
            />
          ) : (
            <div role="group" aria-labelledby={SECRET_LABEL_ID} className="mt-1 flex items-center gap-2">
              <span data-testid="catch-url-signature-secret-set" className="text-sm text-fg-default">
                {hint === null ? '● set' : `● set …${hint}`}
              </span>
              {!disabled && (
                <Button data-testid="catch-url-signature-replace" onClick={() => onChange({ replacing: true })}>
                  Replace…
                </Button>
              )}
            </div>
          )}
          <label className="mt-3 flex items-center gap-2 text-sm text-fg-default">
            <input
              type="checkbox"
              data-testid="catch-url-reject-unverified"
              disabled={rejectDisabled}
              aria-describedby={describedBy}
              checked={form.rejectUnverified}
              onChange={(event) => onChange({ rejectUnverified: event.target.checked })}
            />
            Reject unverified requests (401)
          </label>
        </>
      )}
    </fieldset>
  );
}
