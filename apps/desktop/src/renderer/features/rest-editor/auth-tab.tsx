/**
 * The credentials a REST request sends: which level they come from, and the form for the type.
 *
 * A request inherits by default, and the label says what it would inherit *from* — the folder chain
 * up to the API — because "inherit" with nothing behind it means the request goes out unauthenticated
 * and the user should be able to see that without opening three other tabs.
 *
 * Only the four schemes the shared form already covers are editable here: `inherit`, `none`, `basic`
 * and `ntlm`. Bearer, API key and OAuth2 are shown read-only, naming the level that configures them,
 * until the auth-UI task adds their forms — a half-built form that silently dropped a token would be
 * worse than one that says where to go.
 */
import { AuthFields } from '../../components/auth-fields.js';
import type { AuthConfigWire, EndpointAuthWire } from '../../../shared/wire-types.js';

/** The four types this form can edit. */
const EDITABLE = ['inherit', 'none', 'basic', 'ntlm'] as const;

/** Whether the shared form can edit this configuration. */
export function isEditableHere(auth: AuthConfigWire | undefined): boolean {
  return auth === undefined || (EDITABLE as readonly string[]).includes(auth.type);
}

/** How each scheme reads in the source line. */
const TYPE_LABEL: Readonly<Record<string, string>> = {
  inherit: 'inherited',
  none: 'none',
  basic: 'Basic',
  ntlm: 'NTLM',
  bearer: 'Bearer token',
  'api-key': 'API key',
  oauth2: 'OAuth2',
};

export interface RestAuthTabProps {
  readonly auth: AuthConfigWire;
  /**
   * Where the credentials actually come from when this request inherits: the nearest folder or the
   * API that configures something, already resolved by the caller.
   */
  readonly inheritedFrom?: { readonly label: string; readonly type: string } | undefined;
  readonly onChange: (auth: AuthConfigWire) => void;
}

/** The Auth tab. */
export function RestAuthTab({ auth, inheritedFrom, onChange }: RestAuthTabProps) {
  const editable = isEditableHere(auth);

  return (
    <div data-testid="rest-auth" className="flex flex-col gap-3 overflow-auto p-3">
      <p data-testid="rest-auth-source" className="text-sm text-fg-muted">
        {auth.type !== 'inherit'
          ? `Set on this request · ${TYPE_LABEL[auth.type] ?? auth.type}`
          : inheritedFrom === undefined
            ? 'Inherited · nothing above this request configures credentials'
            : `Inherited from ${inheritedFrom.label} · ${TYPE_LABEL[inheritedFrom.type] ?? inheritedFrom.type}`}
      </p>

      {editable ? (
        <AuthFields
          scope="Request"
          auth={auth.type === 'inherit' ? undefined : (auth as EndpointAuthWire)}
          onChange={(next) => {
            onChange(next === null ? { type: 'inherit' } : next);
          }}
        />
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-fg-default">
            This request uses {TYPE_LABEL[auth.type] ?? auth.type}, which is configured on the API.
          </p>
          <p className="text-sm text-fg-subtle">
            Its fields are not editable from here yet. Clearing them back to inherited is, so nothing is trapped.
          </p>
          <div>
            <button
              type="button"
              data-testid="rest-auth-clear"
              className="rounded-md border border-hairline-strong px-2 py-1 text-sm text-fg-default hover:bg-surface-hover"
              onClick={() => {
                onChange({ type: 'inherit' });
              }}
            >
              Inherit instead
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
