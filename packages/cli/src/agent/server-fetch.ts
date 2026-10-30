/**
 * How the headless agent calls its pairing servers (pair, unpair, nonce redeem, port change): through the
 * proxy the conventional variables name (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, either case), as its sends
 * go, and straight to a server on this machine's loopback or link-local addresses, whatever `NO_PROXY`
 * says (`directHost`).
 */
import { Agent, EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import type { AgentBundleFetch } from './agent-runtime.js';
import { directHost } from './node-platform.js';

function first(env: NodeJS.ProcessEnv, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

function directUrl(url: string): boolean {
  try {
    return directHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** A `fetch` for the pairing servers that obeys `env`'s proxy variables. */
export function serverFetch(env: NodeJS.ProcessEnv): AgentBundleFetch {
  const httpsProxy = first(env, ['HTTPS_PROXY', 'https_proxy']);
  const httpProxy = first(env, ['HTTP_PROXY', 'http_proxy']);
  const noProxy = first(env, ['NO_PROXY', 'no_proxy']);
  const direct = new Agent();
  const proxied: Dispatcher =
    httpsProxy === undefined && httpProxy === undefined
      ? direct
      : new EnvHttpProxyAgent({
          ...(httpsProxy !== undefined ? { httpsProxy } : {}),
          ...(httpProxy !== undefined ? { httpProxy } : {}),
          ...(noProxy !== undefined ? { noProxy } : {}),
        });
  return async (url, init) => {
    const dispatcher = directUrl(url) ? direct : proxied;
    const response = await undiciFetch(url, { ...(init as unknown as Parameters<typeof undiciFetch>[1]), dispatcher });
    return response as unknown as Response;
  };
}
