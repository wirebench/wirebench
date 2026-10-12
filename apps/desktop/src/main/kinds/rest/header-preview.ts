/**
 * `request.restHeaders`: the headers a REST send would put on the wire, for the Headers tab, before
 * anything is sent (spec `2026-10-11-generated-headers-preview-design.md`).
 *
 * The request is resolved as its send resolves it (`previewRest`) and its headers come from the
 * engine's `previewRestHeaders`, the rows `sendRest` itself merges. Credentials go on as the cURL
 * export puts them: read only while the session shows secrets, a masked stand-in otherwise. An
 * OAuth2 token is never fetched here; a cached one is used. A JWT is signed (or the fresh one
 * reused) only while secrets show.
 */
import { CURL_REDACTED, jwtSendAuth, previewRestHeaders } from '@wirebench/engine';
import type { SendAuth } from '@wirebench/engine';
import type {
  RequestRestHeadersRequest,
  RequestRestHeadersResponse,
  RestHeaderRowWire,
} from '../../../shared/kinds/rest/wire.js';
import { cachedAccessToken, placeholderAuth, shownAuth, type RequestChannelDeps } from '../../ipc/request.js';
import { redactHeaders } from '../../redact.js';
import { previewRest, type RestPreview, type SendThroughEngineDeps } from '../../send/exchange.js';

/** The credentials the preview applies, and a note when the header they make is not known yet. */
async function previewAuth(
  deps: RequestChannelDeps,
  resolved: RestPreview,
  show: boolean,
): Promise<{ readonly auth?: SendAuth; readonly note?: string }> {
  const config = resolved.auth;
  switch (config.type) {
    case 'oauth2': {
      const token = cachedAccessToken(deps, config);
      return token !== undefined
        ? { auth: { type: 'oauth2', accessToken: token } }
        : { note: 'No OAuth2 access token is cached: the Authorization header is added when one is fetched at send.' };
    }
    case 'kerberos':
      // Only the scheme is shown, so no ticket is asked for and no secret is read.
      return { auth: { type: 'kerberos' } };
    default: {
      // A JWT is signed through the app's source while secrets show, so the row is the token the
      // next send carries; a stand-in otherwise, as for every other credential.
      const auth = show ? await shownAuth(deps, resolved) : placeholderAuth(config);
      return auth !== undefined ? { auth } : {};
    }
  }
}

/** The extra header names a credential may use that the masker cannot know by name: an API key's or a JWT's. */
function keyHeaders(resolved: RestPreview): string[] {
  const { auth } = resolved;
  if (auth.type === 'jwt' && auth.in === 'header') return [jwtSendAuth(auth, '').name];
  return auth.type === 'api-key' && auth.in === 'header' ? [auth.name] : [];
}

/** The `request.restHeaders` answer for one request; no headers when it is not a REST request. */
export async function restHeaders(
  deps: RequestChannelDeps,
  sendDeps: SendThroughEngineDeps,
  request: RequestRestHeadersRequest,
): Promise<RequestRestHeadersResponse> {
  const resolved = await previewRest(sendDeps, request.requestId, request.draft);
  if (resolved === undefined) return { headers: [] };
  const show = deps.showSecrets?.get() ?? false;
  const { auth, note } = await previewAuth(deps, resolved, show);
  const jar = deps.cookies?.();
  const rows = await previewRestHeaders({
    ...resolved.input,
    ...(auth !== undefined ? { auth } : {}),
    ...(jar !== undefined ? { jar: { host: jar, send: resolved.item.request.settings.sendCookies === true } } : {}),
  });
  const extraHeaders = keyHeaders(resolved);
  const headers: RestHeaderRowWire[] = rows.map((row) => {
    const value = show
      ? row.value
      : (redactHeaders({ [row.name]: row.value }, { show, extraHeaders })[row.name] ?? row.value);
    const masked = value !== row.value || value.includes(CURL_REDACTED);
    return { name: row.name, value, source: row.source, state: row.state, ...(masked ? { masked: true } : {}) };
  });
  return { headers, ...(note !== undefined ? { notes: [note] } : {}) };
}
