/**
 * The built-in `owasp` rule set (#342 spec §4): the OWASP API Security Top 10 items a definition
 * alone can show — an API with no authentication, credentials sent over plain HTTP, and security
 * requirements that name schemes or OAuth scopes the document never defines.
 *
 * Each rule reads the whole (resolved) document from its root, because a requirement is only
 * meaningful against the schemes the document declares, wherever those are.
 */

import type { JsonObject, JsonPath, LintFunction, LintRule } from './rules.js';
import { at, isObject, openapi2, operationsOf } from './rules.js';

const RULESET = 'owasp';

/** The declared security schemes, by name: `components.securitySchemes`, or 2.0's `securityDefinitions`. */
function schemesOf(root: JsonObject): JsonObject {
  if (openapi2(root)) {
    const definitions = root['securityDefinitions'];
    return isObject(definitions) ? definitions : {};
  }
  const components = root['components'];
  const schemes = isObject(components) ? components['securitySchemes'] : undefined;
  return isObject(schemes) ? schemes : {};
}

/** One security requirements list and where it sits. */
interface Requirements {
  readonly list: readonly unknown[];
  readonly path: JsonPath;
}

/** The document's own requirements, then each operation's. */
function requirementsOf(root: JsonObject): Requirements[] {
  const found: Requirements[] = [];
  const global = root['security'];
  if (Array.isArray(global)) found.push({ list: global, path: ['security'] });
  const paths = root['paths'];
  if (!isObject(paths)) return found;
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, operation] of operationsOf(item)) {
      const security = operation['security'];
      if (Array.isArray(security)) found.push({ list: security, path: ['paths', path, method, 'security'] });
    }
  }
  return found;
}

const securityDefined: LintFunction = (input, _options, context) => {
  if (!isObject(input)) return [];
  return Object.keys(schemesOf(input)).length > 0
    ? []
    : [at(context.path, 'The API defines no security scheme, so nothing in it is authenticated')];
};

/**
 * An operation nothing protects: no requirement of its own and none on the document. `security: []`
 * on the operation is a deliberate "public", so it passes. Only checked once schemes exist; without
 * any, `owasp-security-defined` has already said so.
 */
const operationSecurity: LintFunction = (input, _options, context) => {
  if (!isObject(input) || Object.keys(schemesOf(input)).length === 0) return [];
  const global = input['security'];
  const paths = input['paths'];
  if (!isObject(paths) || (Array.isArray(global) && global.length > 0)) return [];
  const results = [];
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, operation] of operationsOf(item)) {
      if (!Array.isArray(operation['security'])) {
        const message = `${method.toUpperCase()} ${path} has no security requirement`;
        results.push(at(context.path, message, 'paths', path, method));
      }
    }
  }
  return results;
};

/**
 * The host of an `http://` URL, or `undefined` for any other URL. Read by hand rather than with
 * `URL`: a server URL is often a template (`http://{env}.api.test`), which `URL` refuses.
 */
export function plainHttpHost(url: string): string | undefined {
  if (url.slice(0, 7).toLowerCase() !== 'http://') return undefined;
  const rest = url.slice(7);
  const end = rest.search(/[/?#]/);
  const authority = end === -1 ? rest : rest.slice(0, end);
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  if (hostPort.startsWith('[')) return hostPort.slice(0, hostPort.indexOf(']') + 1).toLowerCase();
  const colon = hostPort.indexOf(':');
  return (colon === -1 ? hostPort : hostPort.slice(0, colon)).toLowerCase();
}

/** A host on this machine, where plain HTTP never crosses a network. */
export function loopback(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

const plainHttpUrl: LintFunction = (input, _options, context) => {
  if (typeof input !== 'string') return [];
  const host = plainHttpHost(input);
  return host === undefined || loopback(host)
    ? []
    : [at(context.path, `${input} is plain HTTP; credentials and tokens sent to it travel unencrypted`)];
};

/** Swagger 2.0's `schemes: [http]`, unless the `host` is this machine. */
const plainHttpScheme: LintFunction = (input, _options, context) => {
  if (!isObject(input)) return [];
  const schemes = input['schemes'];
  if (!Array.isArray(schemes)) return [];
  const rawHost = input['host'];
  const host = typeof rawHost === 'string' ? (rawHost.split(':')[0] ?? '').toLowerCase() : '';
  if (host !== '' && loopback(host)) return [];
  const index = schemes.findIndex((scheme) => typeof scheme === 'string' && scheme.toLowerCase() === 'http');
  return index === -1
    ? []
    : [
        at(
          context.path,
          'The API is served over plain HTTP; credentials sent to it travel unencrypted',
          'schemes',
          index,
        ),
      ];
};

const schemeUndefined: LintFunction = (input, _options, context) => {
  if (!isObject(input)) return [];
  const schemes = schemesOf(input);
  const results = [];
  for (const { list, path } of requirementsOf(input)) {
    for (const [index, requirement] of list.entries()) {
      if (!isObject(requirement)) continue;
      for (const name of Object.keys(requirement)) {
        if (!(name in schemes)) {
          results.push(at(context.path, `Security scheme "${name}" is not defined`, ...path, index, name));
        }
      }
    }
  }
  return results;
};

/** The scopes an OAuth 2 scheme defines, across all its flows (3.x) or on itself (2.0). */
function scopesOf(scheme: JsonObject): Set<string> {
  const scopes = new Set<string>();
  const add = (holder: unknown): void => {
    if (!isObject(holder)) return;
    const defined = holder['scopes'];
    if (isObject(defined)) for (const scope of Object.keys(defined)) scopes.add(scope);
  };
  add(scheme);
  const flows = scheme['flows'];
  if (isObject(flows)) for (const flow of Object.values(flows)) add(flow);
  return scopes;
}

const scopeUndefined: LintFunction = (input, _options, context) => {
  if (!isObject(input)) return [];
  const schemes = schemesOf(input);
  const results = [];
  for (const { list, path } of requirementsOf(input)) {
    for (const [index, requirement] of list.entries()) {
      if (!isObject(requirement)) continue;
      for (const [name, requested] of Object.entries(requirement)) {
        const scheme = schemes[name];
        if (!isObject(scheme) || scheme['type'] !== 'oauth2' || !Array.isArray(requested)) continue;
        const defined = scopesOf(scheme);
        for (const [scopeIndex, scope] of requested.entries()) {
          if (typeof scope === 'string' && !defined.has(scope)) {
            const message = `OAuth scope "${scope}" is not defined by "${name}"`;
            results.push(at(context.path, message, ...path, index, name, scopeIndex));
          }
        }
      }
    }
  }
  return results;
};

const OAUTH_URLS = 'authorizationUrl,tokenUrl,refreshUrl';

export const OWASP_RULES: readonly LintRule[] = [
  {
    id: 'owasp-security-defined',
    severity: 'error',
    ruleset: RULESET,
    description: 'The API defines at least one security scheme (OWASP API2: broken authentication).',
    body: { given: '$', then: { function: securityDefined } },
  },
  {
    id: 'owasp-operation-security',
    severity: 'warning',
    ruleset: RULESET,
    description: 'Every operation is protected, or declares `security: []` to be public on purpose.',
    body: { given: '$', then: { function: operationSecurity } },
  },
  {
    id: 'owasp-plain-http',
    severity: 'error',
    ruleset: RULESET,
    description: 'Servers and OAuth endpoints use HTTPS, so credentials never travel unencrypted (OWASP API8).',
    body: {
      given: [
        '$.servers[*].url',
        '$.paths[*].servers[*].url',
        '$.paths[*][*].servers[*].url',
        `$.components.securitySchemes[*].flows[*][${OAUTH_URLS}]`,
        `$.securityDefinitions[*][${OAUTH_URLS}]`,
      ],
      then: { function: plainHttpUrl },
    },
  },
  {
    id: 'owasp-plain-http-scheme',
    severity: 'error',
    ruleset: RULESET,
    description: 'A Swagger 2.0 API is not served over plain HTTP (OWASP API8).',
    body: { given: '$', formats: [openapi2], then: { function: plainHttpScheme } },
  },
  {
    id: 'owasp-security-scheme-undefined',
    severity: 'error',
    ruleset: RULESET,
    description: 'Every security requirement names a scheme the document defines.',
    body: { given: '$', then: { function: schemeUndefined } },
  },
  {
    id: 'owasp-oauth-scope-undefined',
    severity: 'error',
    ruleset: RULESET,
    description:
      'Every OAuth scope a requirement asks for is defined by its scheme (OWASP API5: function-level authorization).',
    body: { given: '$', then: { function: scopeUndefined } },
  },
];
