/**
 * The metrics' closed set of attributes (hosted edition spec §20.8). A metric names a tenant by its uuid, never by a
 * slug or a name; every other attribute is a closed set or a route template. Nothing from a request's content, a
 * header, a URL or a user is ever an attribute: the builders below are the only way an attribute is made, and each
 * coerces what it is given into its shape, so an unexpected value becomes `none`, `unmatched` or `_OTHER`, never
 * itself. {@link attributeProblem} is what the attribute sweep test checks every recorded data point with.
 */
import { SCHEDULE_RUN_STATUSES } from '@wirebench/engine';
import { CANONICAL_UUID } from '../../tenancy/scope.js';

export const TENANT = 'wirebench.tenant.id';
export const ROUTE = 'http.route';
export const METHOD = 'http.request.method';
export const STATUS_CLASS = 'http.response.status_class';
export const OUTCOME = 'wirebench.send.outcome';
export const BUDGET = 'wirebench.budget';
export const RUN_STATUS = 'wirebench.schedule.run.status';
export const POOL = 'wirebench.db.pool';

/** A tenant's attribute value when the request or event has none (`/healthz`, an unresolved host). */
export const NO_TENANT = 'none';
/** The route of a request no route matched: a 404's path is the caller's, so it is never recorded. */
export const UNMATCHED_ROUTE = 'unmatched';
/** A method outside {@link METHODS}, as the OpenTelemetry HTTP conventions spell it. */
export const OTHER_METHOD = '_OTHER';

export const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
export const SEND_OUTCOMES = ['ok', 'failed', 'refused'] as const;
/** The budgets of spec §20.7 a send is refused by: the per-minute bucket and the concurrent slots. */
export const BUDGETS = ['sends', 'concurrency'] as const;
export const POOLS = ['app', 'lock'] as const;

export type SendOutcome = (typeof SEND_OUTCOMES)[number];
export type BudgetName = (typeof BUDGETS)[number];
export type PoolName = (typeof POOLS)[number];

/**
 * A Fastify route template: `/` and path segments of letters, digits, `.`, `_`, `-`, or a `:param` or `*`. No query,
 * no scheme, no `@`, so never a URL or an email.
 */
const ROUTE_TEMPLATE = /^(\/(:?[A-Za-z0-9._-]+|\*)?)+$/;

/** Each key and the shape of its values: the closed set the sweep test checks every data point against. */
const SHAPES: { readonly [key: string]: (value: unknown) => boolean } = {
  [TENANT]: (value) => value === NO_TENANT || (typeof value === 'string' && CANONICAL_UUID.test(value)),
  [ROUTE]: (value) => value === UNMATCHED_ROUTE || (typeof value === 'string' && ROUTE_TEMPLATE.test(value)),
  [METHOD]: (value) => value === OTHER_METHOD || (METHODS as readonly unknown[]).includes(value),
  [STATUS_CLASS]: (value) => typeof value === 'string' && /^[1-5]xx$/.test(value),
  [OUTCOME]: (value) => (SEND_OUTCOMES as readonly unknown[]).includes(value),
  [BUDGET]: (value) => (BUDGETS as readonly unknown[]).includes(value),
  [RUN_STATUS]: (value) => (SCHEDULE_RUN_STATUSES as readonly unknown[]).includes(value),
  [POOL]: (value) => (POOLS as readonly unknown[]).includes(value),
};

export const ATTRIBUTE_KEYS: readonly string[] = Object.keys(SHAPES);

/** A URL (a scheme, a protocol-relative start or a query) or an email, whatever the key: never an attribute value. */
const URL_OR_EMAIL = /:\/\/|^\/\/|[?#@]/;

/**
 * Why `key = value` is not allowed on a metric, or `undefined` when it is: a key outside the closed set, a value
 * shaped like a URL or an email, or one out of its key's shape (a slug or a name where a tenant's uuid goes).
 */
export function attributeProblem(key: string, value: unknown): string | undefined {
  const shape = Object.hasOwn(SHAPES, key) ? SHAPES[key] : undefined;
  if (shape === undefined) return `${key} is not one of the metrics' attributes`;
  if (typeof value === 'string' && URL_OR_EMAIL.test(value)) return `${key} has a value shaped like a URL or an email`;
  if (!shape(value)) return `${key} has a value out of its shape`;
  return undefined;
}

/** The tenant's uuid, or `none`. */
export function tenantValue(tenantId: string | undefined): string {
  return tenantId !== undefined && CANONICAL_UUID.test(tenantId) ? tenantId : NO_TENANT;
}

/** The route template as Fastify registered it, or `unmatched` (a 404, or anything not shaped like a template). */
export function routeValue(template: string | undefined): string {
  return template !== undefined && ROUTE_TEMPLATE.test(template) ? template : UNMATCHED_ROUTE;
}

export function methodValue(method: string): string {
  return (METHODS as readonly string[]).includes(method) ? method : OTHER_METHOD;
}

/** `2xx` for 200 to 299, and so on; a code outside 100 to 599 counts as `5xx`. */
export function statusClassValue(statusCode: number): string {
  const hundreds = Math.floor(statusCode / 100);
  return `${String(hundreds >= 1 && hundreds <= 5 ? hundreds : 5)}xx`;
}
