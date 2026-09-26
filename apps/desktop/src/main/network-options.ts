/**
 * The CA bundle and proxy a send from main must honour, resolved from the preferences alone
 * (identity spec §5.3, assumption 7). Lifted out of `ProjectHost.trustAnchors` / `proxyFor` so a
 * call with no project open — the server client — gets the same trust and the same proxy as a
 * request send; `ProjectHost` now delegates here.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { rootCertificates } from 'node:tls';
import {
  isExcluded,
  resolveProxyFor,
  splitPemBundle,
  type Preferences,
  type ProxyConfig,
  type ProxyOptions,
  type TlsOptions,
} from '@wirebench/engine';
import type { ReadPicks } from './dialog-picks.js';
import { allowsReadPath } from './path-access.js';

/**
 * The trust anchors a send uses when a CA bundle is configured: the default roots followed by the
 * bundle's PEM anchors, since a `ca` given to Node replaces its default roots and the bundle is meant
 * to add to them. `undefined` (no `ca` at all, the default roots alone) when none is configured, it
 * cannot be read, or it fails the read rule: inside one of `roots`, or picked through a native dialog
 * this session. With no roots (no project) only a picked absolute path qualifies. Failing
 * quietly leaves verification stricter, never looser.
 */
export async function resolveTrustAnchors(input: {
  readonly caBundlePath: string | undefined;
  readonly roots: readonly string[];
  readonly picks: ReadPicks | undefined;
}): Promise<readonly string[] | undefined> {
  const path = input.caBundlePath;
  if (path === undefined || path.length === 0) return undefined;
  const root = input.roots[0];
  const resolved = root !== undefined ? resolvePath(root, path) : isAbsolute(path) ? path : undefined;
  if (resolved === undefined || !(await allowsReadPath(input.roots, input.picks, resolved))) return undefined;
  try {
    const anchors = splitPemBundle(await readFile(resolved, 'utf-8'));
    return anchors.length > 0 ? [...rootCertificates, ...anchors] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The proxy a send to `url` goes through, or `undefined` for direct. The manual proxy's
 * `passwordRef` is resolved here, in main, and only the resolved options reach the transport.
 * @throws WirebenchError `proxy-unsupported` for a SOCKS answer from the system (undici cannot dial it)
 */
export async function resolveProxy(input: {
  readonly url: string;
  readonly proxy: Preferences['proxy'];
  readonly getSecret: (ref: string) => Promise<string | undefined>;
  readonly resolveSystemProxy?: (url: string) => Promise<string | undefined>;
}): Promise<ProxyOptions | undefined> {
  const proxy = input.proxy;
  if (proxy.mode === 'none') return undefined;
  if (proxy.mode === 'system') {
    let hostname: string;
    try {
      hostname = new URL(input.url).hostname;
    } catch {
      return undefined;
    }
    // A host the user said to reach directly is not worth a PAC lookup, which can be slow.
    if (isExcluded(hostname, proxy.excludes)) return undefined;
    const pac = await input.resolveSystemProxy?.(input.url);
    return resolveProxyFor(input.url, { mode: 'system', excludes: proxy.excludes }, { resolveSystem: () => pac });
  }
  const config: ProxyConfig = {
    mode: 'manual',
    host: proxy.host ?? '',
    port: proxy.port ?? 0,
    excludes: proxy.excludes,
    ...(proxy.username !== undefined ? { username: proxy.username } : {}),
    ...(proxy.passwordRef !== undefined ? { passwordRef: proxy.passwordRef } : {}),
  };
  const password =
    proxy.passwordRef !== undefined && proxy.passwordRef.length > 0
      ? await input.getSecret(proxy.passwordRef)
      : undefined;
  return resolveProxyFor(input.url, config, { ...(password !== undefined ? { password } : {}) });
}

export interface MainHttpDeps {
  readonly preferences: () => Preferences;
  readonly picks?: ReadPicks;
  readonly getSecret: (ref: string) => Promise<string | undefined>;
  readonly resolveSystemProxy?: (url: string) => Promise<string | undefined>;
}

/** What a project-free send from main passes to `sendHttp` beyond the request itself. */
export async function mainHttpOptions(
  url: string,
  deps: MainHttpDeps,
): Promise<{ readonly tls?: TlsOptions; readonly proxy?: ProxyOptions }> {
  const preferences = deps.preferences();
  const ca = await resolveTrustAnchors({ caBundlePath: preferences.ssl.caBundlePath, roots: [], picks: deps.picks });
  const proxy = await resolveProxy({
    url,
    proxy: preferences.proxy,
    getSecret: deps.getSecret,
    ...(deps.resolveSystemProxy !== undefined ? { resolveSystemProxy: deps.resolveSystemProxy } : {}),
  });
  return {
    ...(ca !== undefined ? { tls: { ca: [...ca], minVersion: preferences.ssl.minVersion } } : {}),
    ...(proxy !== undefined ? { proxy } : {}),
  };
}
