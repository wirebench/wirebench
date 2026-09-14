/**
 * The credentials a REST request sends: which level they come from, and the form for the type.
 *
 * A request inherits by default, and the label says what it would inherit *from* — the folder chain
 * up to the API — because "inherit" with nothing behind it means the request goes out unauthenticated
 * and the user should be able to see that without opening three other tabs.
 *
 * Every scheme is editable here, through the same {@link AuthFields} an API, a folder and a SOAP
 * endpoint use. OAuth2 additionally gets its token panel, which needs the request's own id: main
 * reads the configuration from the model by owner, so the panel names the owner and nothing else.
 */
import { AuthFields } from '../../components/auth-fields.js';
import { OAuth2StatusPanel } from './oauth2-status.js';
import type { AuthConfigWire } from '../../../shared/wire-types.js';

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

/** How one scheme reads wherever a source line names it. */
export function authTypeLabel(type: string): string {
  return TYPE_LABEL[type] ?? type;
}

export interface RestAuthTabProps {
  /** The request this tab edits, for the OAuth2 panel's owner. */
  readonly requestId: string;
  readonly auth: AuthConfigWire;
  /**
   * Where the credentials actually come from when this request inherits: the nearest folder or the
   * API that configures something, already resolved by the caller.
   */
  readonly inheritedFrom?: { readonly label: string; readonly type: string } | undefined;
  readonly onChange: (auth: AuthConfigWire) => void;
}

/** The Auth tab. */
export function RestAuthTab({ requestId, auth, inheritedFrom, onChange }: RestAuthTabProps) {
  return (
    <div data-testid="rest-auth" className="flex flex-col gap-3 overflow-auto p-3">
      <p data-testid="rest-auth-source" className="text-sm text-fg-muted">
        {auth.type !== 'inherit'
          ? `Set on this request · ${authTypeLabel(auth.type)}`
          : inheritedFrom === undefined
            ? 'Inherited · nothing above this request configures credentials'
            : `Inherited from ${inheritedFrom.label} · ${authTypeLabel(inheritedFrom.type)}`}
      </p>

      <AuthFields
        scope="Request"
        inheritable
        auth={auth.type === 'inherit' ? undefined : auth}
        onChange={(next) => {
          onChange(next ?? { type: 'inherit' });
        }}
        oauth2Status={auth.type === 'oauth2' ? <OAuth2StatusPanel ownerId={requestId} grant={auth.grant} /> : undefined}
      />
    </div>
  );
}
