/**
 * The counts on the REST tabs that hold rows: Params and Headers on the request, Headers on the
 * response. Each reads like the Assertions count beside it — a number, and nothing when there is
 * nothing — so a glance at the strip says where the request's rows are.
 */
import type { RestBodyWire } from '@shared/kinds/rest/wire.js';
import type { KeyValueWire } from '@shared/wire-base.js';

/** The rows a table sends: switched on and named. The empty add row is never one of them. */
export function rowsBadge(rows: readonly Pick<KeyValueWire, 'name' | 'enabled'>[]): string | undefined {
  const count = rows.filter((row) => row.enabled && row.name !== '').length;
  return count === 0 ? undefined : String(count);
}

/** The headers a response came back with, counted as the Headers tab lists them: a repeat counts twice. */
export function responseHeadersBadge(http: {
  readonly headers: Readonly<Record<string, string>>;
  readonly rawHeaders?: readonly (readonly [string, string])[] | undefined;
}): string | undefined {
  const count = http.rawHeaders?.length ?? Object.keys(http.headers).length;
  return count === 0 ? undefined : String(count);
}

/**
 * The dot on the Body tab: there when the request would send a body, the same mark Scripts carries.
 * A body is not a list of rows, so it gets no number.
 */
export function bodyBadge(body: RestBodyWire): string | undefined {
  switch (body.kind) {
    case 'none':
      return undefined;
    case 'raw':
      return body.text.trim() === '' ? undefined : '●';
    case 'form':
      return rowsBadge(body.fields) === undefined ? undefined : '●';
    case 'multipart':
      return body.parts.some((part) => part.enabled && part.name !== '') ? '●' : undefined;
    case 'binary':
      return body.source.kind === 'path' && body.source.path === '' ? undefined : '●';
    case 'graphql':
      return body.query.trim() === '' ? undefined : '●';
  }
}
