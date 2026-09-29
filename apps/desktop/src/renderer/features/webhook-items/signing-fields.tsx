/**
 * The signing controls (webhook-signatures §5.2): *Inherit* (when the node can inherit), *None*,
 * or a scheme with its fields, a keychain secret, and the CI name a pipeline supplies it under.
 *
 * The secret is a {@link SecretField}: only its keychain reference ever reaches the project. The CI
 * name is upper-cased as it is typed and held back while it breaks the project file's `envName`
 * rule — shown with an inline error, and reported through `onProblemChange` so a dialog can refuse
 * to save — since main would refuse it anyway and a saved one would make the project unloadable.
 * A scheme field main would refuse (a bad header name, a tolerance out of range) is held back the
 * same way: the fields show the draft, and only a scheme `schemeProblemOf` accepts is passed on.
 */
import { useEffect, useState } from 'react';
import { SecretField } from '../../components/secret-field.js';
import { INPUT_CLASS } from '../team/roles.js';
import { SchemeFields } from '../webhooks/scheme-fields.js';
import { defaultScheme, SCHEME_KINDS, SCHEME_LABELS, schemeProblemOf } from '../webhooks/signature-text.js';
import type { SchemeKind } from '../webhooks/signature-text.js';
import { ciNameOf, ciNameProblemOf } from './signing.js';
import type { WebhookSigningWire } from '../../../shared/wire-types.js';

type WebhookSigningScheme = Extract<WebhookSigningWire, { mode: 'sign' }>['scheme'];

const LABEL_CLASS = 'mt-2 block text-sm text-fg-subtle';

export function SigningFields({
  value,
  onChange,
  inherit,
  nodeName,
  disabled = false,
  registerFlush,
  onProblemChange,
}: {
  /** The node's own signing; `undefined` is *Inherit*. */
  readonly value: WebhookSigningWire | undefined;
  /** `undefined` chooses *Inherit* (offered only when `inherit` is true). */
  readonly onChange: (next: WebhookSigningWire | undefined) => void;
  readonly inherit: boolean;
  /** Pre-fills the CI name. */
  readonly nodeName: string;
  readonly disabled?: boolean;
  /** The secret field's flush: a secret typed but not saved on its own is stored when it runs. */
  readonly registerFlush?: (flush: (() => Promise<string | undefined>) | undefined) => void;
  /** What would stop a save right now (a CI name or scheme field main would refuse), or `undefined`. */
  readonly onProblemChange?: (problem: string | undefined) => void;
}) {
  const secretEnv = value?.mode === 'sign' ? (value.secretEnv ?? '') : '';
  // What is in the CI name box: the saved name, or a typed one the envName rule refuses.
  const [ciDraft, setCiDraft] = useState(secretEnv);
  useEffect(() => {
    setCiDraft(secretEnv);
  }, [secretEnv]);

  const savedScheme = value?.mode === 'sign' ? value.scheme : undefined;
  // What the scheme fields show: the saved scheme, or an edit of it `schemeProblemOf` refuses.
  const [schemeDraft, setSchemeDraft] = useState(savedScheme);
  const savedSchemeKey = JSON.stringify(savedScheme ?? null);
  useEffect(() => {
    setSchemeDraft((JSON.parse(savedSchemeKey) as WebhookSigningScheme | null) ?? undefined);
  }, [savedSchemeKey]);

  const ciProblem = value?.mode === 'sign' ? ciNameProblemOf(ciDraft) : undefined;
  const schemeProblem = value?.mode === 'sign' && schemeDraft !== undefined ? schemeProblemOf(schemeDraft) : undefined;
  const problem = ciProblem ?? schemeProblem;
  useEffect(() => {
    onProblemChange?.(problem);
  }, [problem, onProblemChange]);

  const mode = value === undefined ? 'inherit' : value.mode === 'none' ? 'none' : value.scheme.kind;
  const choose = (next: string): void => {
    if (next === 'inherit') return onChange(undefined);
    if (next === 'none') return onChange({ mode: 'none' });
    const kind = next as SchemeKind;
    const kept = value?.mode === 'sign' ? value : undefined;
    const ciName = kept?.secretEnv ?? ciNameOf(nodeName);
    setCiDraft(ciName);
    onChange({
      mode: 'sign',
      scheme: kept?.scheme.kind === kind ? kept.scheme : defaultScheme(kind),
      ...(kept?.secretRef !== undefined ? { secretRef: kept.secretRef } : {}),
      secretEnv: ciName,
    });
  };
  return (
    <div data-testid="signing-fields">
      <label className={LABEL_CLASS} htmlFor="signing-mode">
        Signing
      </label>
      <select
        id="signing-mode"
        data-testid="signing-mode"
        disabled={disabled}
        value={mode}
        onChange={(event) => choose(event.target.value)}
        className={INPUT_CLASS}
      >
        {inherit && <option value="inherit">Inherit</option>}
        <option value="none">None</option>
        {SCHEME_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {SCHEME_LABELS[kind]}
          </option>
        ))}
      </select>
      {value?.mode === 'sign' && (
        <>
          <SchemeFields
            scheme={schemeDraft ?? value.scheme}
            onChange={(scheme) => {
              setSchemeDraft(scheme);
              if (schemeProblemOf(scheme) === undefined) onChange({ ...value, scheme });
            }}
            disabled={disabled}
            prefix="signing"
          />
          {schemeProblem !== undefined && (
            <p role="alert" data-testid="signing-scheme-problem" className="mt-1 text-xs text-status-danger">
              {schemeProblem}
            </p>
          )}
          <span id="signing-secret-label" className={LABEL_CLASS}>
            Signing secret
          </span>
          <div role="group" aria-labelledby="signing-secret-label" className="mt-1">
            <SecretField
              label="Signing secret"
              value={value.secretRef}
              disabled={disabled}
              {...(registerFlush !== undefined ? { registerFlush } : {})}
              onChange={(ref) => {
                // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
                const { secretRef: _old, ...rest } = value;
                onChange(ref === undefined ? rest : { ...rest, secretRef: ref });
              }}
            />
          </div>
          <label className={LABEL_CLASS} htmlFor="signing-ci-name">
            CI name (WIREBENCH_SECRET_…)
          </label>
          <input
            id="signing-ci-name"
            data-testid="signing-ci-name"
            disabled={disabled}
            value={ciDraft}
            aria-invalid={ciProblem !== undefined}
            onChange={(event) => {
              const next = event.target.value.toUpperCase();
              setCiDraft(next);
              if (ciNameProblemOf(next) !== undefined) return;
              // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
              const { secretEnv: _old, ...rest } = value;
              onChange(next === '' ? rest : { ...rest, secretEnv: next });
            }}
            className={`${INPUT_CLASS} font-mono`}
          />
          {ciProblem !== undefined && (
            <p role="alert" data-testid="signing-ci-name-problem" className="mt-1 text-xs text-status-danger">
              {ciProblem}
            </p>
          )}
        </>
      )}
    </div>
  );
}
