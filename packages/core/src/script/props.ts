/**
 * The properties a script's `props.get` reads (spec §API): every name the `${name}` shorthand can
 * reach, resolved as the shorthand would resolve it, with secrets left out. A property whose value
 * is, or leads to, a secret does not resolve without the secrets, so it is simply absent: a script
 * reads a secret only through `secrets.get`, and only when its request lists it.
 */
import { expand, type PropertyScopes } from '../project/properties.js';

/** At most this many properties are handed to a script. */
const MAX_PROPERTIES = 2_000;

export function scriptProperties(scopes: PropertyScopes): Record<string, string> {
  const withoutSecrets: PropertyScopes = { ...scopes, secrets: {} };
  const names = new Set<string>();
  for (const map of [scopes.env, scopes.workspace, scopes.project, scopes.global]) {
    for (const name of Object.keys(map ?? {})) names.add(name);
  }
  const out: Record<string, string> = {};
  for (const name of names) {
    if (Object.keys(out).length >= MAX_PROPERTIES) break;
    if (!/^[A-Za-z_][\w.-]*$/.test(name)) continue;
    const result = expand(`\${${name}}`, withoutSecrets);
    if (result.unresolved.length === 0) out[name] = result.text;
  }
  return out;
}
