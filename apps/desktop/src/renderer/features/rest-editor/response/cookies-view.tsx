/**
 * The cookies a response set, parsed into their attributes.
 *
 * A `Set-Cookie` line the engine could not parse is shown whole rather than dropped: an unparseable
 * cookie is exactly the thing a user is trying to see when they open this tab.
 */
import type { CookieWire, RestExchangeSummary } from '../../../../shared/wire-types.js';

export interface CookiesViewProps {
  readonly exchange: RestExchangeSummary;
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

/** The Cookies tab. */
export function CookiesView({ exchange }: CookiesViewProps) {
  if (exchange.cookies.length === 0) {
    return (
      <p data-testid="rest-response-cookies" className="p-3 text-sm text-fg-subtle">
        This response set no cookies.
      </p>
    );
  }

  return (
    <div data-testid="rest-response-cookies" className="overflow-auto p-2">
      <table aria-label="Response cookies" className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-hairline text-left tracking-wider text-fg-subtle uppercase">
            <th className="px-2 py-1 font-medium">Name</th>
            <th className="px-2 py-1 font-medium">Value</th>
            <th className="px-2 py-1 font-medium">Attributes</th>
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
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
