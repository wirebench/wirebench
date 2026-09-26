/**
 * The Authentication section for fetching a definition document: an OpenAPI or AsyncAPI URL in the
 * Import dialog, and another URL in the REST Update Definition chooser.
 *
 * It is {@link AuthFields} narrowed to the three schemes a definition fetch can send — Basic, a
 * bearer token and an API key, in a header or the query — so every secret is still a `SecretField`
 * and only a `secretRef` ever leaves the form. The helpers turn the form's value into what the
 * channels take, and decide when a stored credential may be offered for a URL.
 */
import { AuthFields } from './auth-fields.js';
import type { AuthConfigWire, DefinitionAuthWire } from '../../shared/wire-types.js';

/** The schemes a definition fetch can send, in the form's order. */
export const DEFINITION_AUTH_TYPES: readonly AuthConfigWire['type'][] = ['none', 'basic', 'bearer', 'api-key'];

/** The form's starting value: no credentials. */
export const NO_DEFINITION_AUTH: AuthConfigWire = { type: 'none' };

/**
 * The form's value as a channel takes it: only the fields a definition fetch uses, and `undefined`
 * for **None** or for a scheme whose secret was never entered — sending half a credential would
 * only turn into a refusal from the server.
 */
export function toDefinitionAuthWire(auth: AuthConfigWire | undefined): DefinitionAuthWire | undefined {
  switch (auth?.type) {
    case 'basic':
      return auth.passwordRef === undefined
        ? undefined
        : { type: 'basic', username: auth.username ?? '', passwordRef: auth.passwordRef };
    case 'bearer':
      return auth.tokenRef === undefined
        ? undefined
        : {
            type: 'bearer',
            tokenRef: auth.tokenRef,
            ...(auth.scheme !== undefined && auth.scheme.trim() !== '' ? { scheme: auth.scheme.trim() } : {}),
          };
    case 'api-key': {
      const name = auth.name?.trim() ?? '';
      return auth.valueRef === undefined || name === ''
        ? undefined
        : { type: 'api-key', name, in: auth.in ?? 'header', valueRef: auth.valueRef };
    }
    default:
      return undefined;
  }
}

/** True when both are URLs on the same origin: the only case a stored credential is offered for. */
export function sameOrigin(a: string, b: string): boolean {
  if (!URL.canParse(a) || !URL.canParse(b)) {
    return false;
  }
  return new URL(a).origin === new URL(b).origin;
}

export interface DefinitionAuthFieldsProps {
  readonly auth: AuthConfigWire;
  readonly onChange: (auth: AuthConfigWire) => void;
  /** Receives the form's flush, which stores any secret typed but not saved; see {@link AuthFields}. */
  readonly registerFlush?: (flush: (() => Promise<AuthConfigWire | undefined>) | undefined) => void;
}

/** The section: the scheme, its fields, and where the credentials are sent. */
export function DefinitionAuthFields({ auth, onChange, registerFlush }: DefinitionAuthFieldsProps) {
  return (
    <fieldset data-testid="definition-auth" className="flex flex-col gap-2">
      <legend className="text-xs font-medium text-fg-muted">Authentication</legend>
      <AuthFields
        scope="Definition"
        auth={auth}
        types={DEFINITION_AUTH_TYPES}
        preemptiveOption={false}
        // *Not configured* sends nothing either, so it reads as None rather than a second empty choice.
        onChange={(next) => onChange(next ?? NO_DEFINITION_AUTH)}
        {...(registerFlush !== undefined ? { registerFlush } : {})}
      />
      <p className="text-xs text-fg-subtle">
        Sent only to this URL’s own scheme, host and port — never to a redirect or a referenced document elsewhere.
      </p>
    </fieldset>
  );
}
