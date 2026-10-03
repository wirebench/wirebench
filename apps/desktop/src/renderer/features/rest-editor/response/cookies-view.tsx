/**
 * The cookies a response set, parsed into their attributes, with what the workspace cookie jar did
 * with each (cookie jar spec §3).
 *
 * A `Set-Cookie` line the engine could not parse is shown whole rather than dropped: an unparseable
 * cookie is exactly the thing a user is trying to see when they open this tab.
 */
import { Button } from '../../../components/button.js';
import { openCookiesTab } from '../../cookies/cookie-actions.js';
import type { CookieJarVerdictWire, CookieWire, RestExchangeSummary } from '../../../../shared/wire-types.js';

export interface CookiesViewProps {
  readonly exchange: RestExchangeSummary;
}

const IGNORED: Readonly<Record<Exclude<NonNullable<CookieJarVerdictWire['reason']>, 'deleted'>, string>> = {
  'domain-mismatch': 'the domain does not match the host',
  'domain-not-allowed': 'the domain is not allowed',
  'secure-over-http': 'Secure over plain http',
  'too-large': 'too large',
  malformed: 'not a cookie',
};

/** "stored", "deleted from the jar" or "ignored: <why>"; `undefined` when the send had no jar. */
export function jarNote(cookie: CookieWire): string | undefined {
  const verdict = cookie.jar;
  if (verdict === undefined) {
    return undefined;
  }
  if (verdict.stored) {
    return 'stored';
  }
  const reason = verdict.reason ?? 'malformed';
  return reason === 'deleted' ? 'deleted from the jar' : `ignored: ${IGNORED[reason]}`;
}

/** The attributes column for one cookie. */
function attributes(cookie: CookieWire): string {
  return [
    cookie.domain !== undefined ? `Domain=${cookie.domain}` : undefined,
    cookie.path !== undefined ? `Path=${cookie.path}` : undefined,
    cookie.expires !== undefined ? `Expires=${cookie.expires}` : undefined,
    cookie.maxAge !== undefined ? `Max-Age=${String(cookie.maxAge)}` : undefined,
    cookie.sameSite !== undefined ? `SameSite=${cookie.sameSite}` : undefined,
    cookie.secure === true ? 'Secure' : undefined,
    cookie.httpOnly === true ? 'HttpOnly' : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' · ');
}

function ManageLink() {
  return (
    <div className="flex justify-end">
      <Button variant="ghost" data-testid="rest-cookies-manage" onClick={openCookiesTab}>
        Manage cookies
      </Button>
    </div>
  );
}

/** The Cookies tab. */
export function CookiesView({ exchange }: CookiesViewProps) {
  if (exchange.cookies.length === 0) {
    return (
      <div data-testid="rest-response-cookies" className="p-2">
        <ManageLink />
        <p className="px-1 text-sm text-fg-subtle">This response set no cookies.</p>
      </div>
    );
  }

  return (
    <div data-testid="rest-response-cookies" className="overflow-auto p-2">
      <ManageLink />
      <table aria-label="Response cookies" className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-hairline text-left tracking-wider text-fg-subtle uppercase">
            <th className="px-2 py-1 font-medium">Name</th>
            <th className="px-2 py-1 font-medium">Value</th>
            <th className="px-2 py-1 font-medium">Attributes</th>
            <th className="px-2 py-1 font-medium">Jar</th>
          </tr>
        </thead>
        <tbody>
          {exchange.cookies.map((cookie, index) => (
            <tr key={`${cookie.name}:${String(index)}`} data-testid="rest-cookie-row" className="align-top font-mono">
              <td className="px-2 py-0.5 break-words text-fg-default">{cookie.name}</td>
              <td className="px-2 py-0.5 break-words text-fg-muted">
                {cookie.malformed === true ? (
                  <span className="text-status-warning">could not be parsed</span>
                ) : (
                  cookie.value
                )}
              </td>
              <td className="px-2 py-0.5 break-words text-fg-subtle">{attributes(cookie)}</td>
              <td data-testid="rest-cookie-jar" className="px-2 py-0.5 font-sans text-fg-subtle">
                {jarNote(cookie) ?? ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
