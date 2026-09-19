import type { ProxyOptions } from '@wirebench/engine';
import { UsageError } from './args.js';

/** Parses one proxy variable eagerly, so a typo is exit 2 before anything is sent. */
function parseProxy(name: string, raw: string | undefined): ProxyOptions | undefined {
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`${name} is not a valid URL`);
  }
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  url.username = '';
  url.password = '';
  return {
    url: url.toString(),
    ...(username.length > 0 || password.length > 0 ? { auth: { username, password } } : {}),
  };
}

/** The first set variable of `names`, with the name it was found under. */
function first(env: NodeJS.ProcessEnv, names: readonly string[]): readonly [string, string | undefined] {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.length > 0) {
      return [name, value];
    }
  }
  return [names[0] ?? '', undefined];
}

/**
 * The proxy for each URL a run sends to, from the conventional variables: a pipeline has no
 * preferences to read one from, and these are what every other tool on the runner already obeys.
 *
 * @throws UsageError when a proxy variable is not a URL.
 */
export function proxyFromEnv(env: NodeJS.ProcessEnv): (url: string) => ProxyOptions | undefined {
  const https = parseProxy(...first(env, ['HTTPS_PROXY', 'https_proxy']));
  const http = parseProxy(...first(env, ['HTTP_PROXY', 'http_proxy']));
  const noProxy = (first(env, ['NO_PROXY', 'no_proxy'])[1] ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  const bypassed = (host: string): boolean =>
    noProxy.some((entry) => {
      if (entry === '*') {
        return true;
      }
      const suffix = entry.startsWith('.') ? entry.slice(1) : entry;
      return host === suffix || host.endsWith(`.${suffix}`);
    });

  return (target) => {
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      return undefined;
    }
    const proxy = parsed.protocol === 'https:' ? https : parsed.protocol === 'http:' ? http : undefined;
    if (proxy === undefined || bypassed(parsed.hostname.toLowerCase())) {
      return undefined;
    }
    return proxy;
  };
}
