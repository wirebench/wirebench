/**
 * The one file that touches the native Kerberos binding (ADR-0019). Everything else goes through
 * `kerberos-token.ts`.
 *
 * The binding is loaded directly rather than through the `kerberos` package's JavaScript, because
 * that file only ever loads `../build/Release/kerberos.node` and the desktop app ships a vendored
 * copy elsewhere. Loading is lazy and memoised: nothing native is touched until a send needs it.
 *
 * The option keys are the ones the C++ reads in kerberos@7.0.0 (`flags`, `user`, `domain`,
 * `password`), not the `gssFlag`/`pass` its `index.d.ts` documents.
 */

import { createRequire } from 'node:module';

/** `GSS_MECH_OID_KRB5` in kerberos@7.0.0: the Kerberos mechanism (SSPI package `Kerberos` on Windows). */
export const GSS_MECH_OID_KRB5 = 9;
/** `GSS_C_MUTUAL_FLAG` in kerberos@7.0.0. */
export const GSS_C_MUTUAL_FLAG = 2;

export type KerberosAvailability =
  { readonly available: true } | { readonly available: false; readonly reason: string };

export interface KerberosInitInput {
  /** Already in the platform's form: `HTTP/host` on Windows, `HTTP@host` elsewhere. */
  readonly spn: string;
  readonly principal?: string;
  readonly user?: string;
  readonly domain?: string;
  readonly password?: string;
}

export interface KerberosClientLike {
  step(challengeBase64: string): Promise<string>;
  readonly contextComplete: boolean;
}

export interface KerberosProvider {
  availability(): KerberosAvailability;
  initClient(input: KerberosInitInput): Promise<KerberosClientLike>;
}

interface RawClient {
  step(challenge: string, callback: (error: Error | null, response?: string) => void): unknown;
  readonly contextComplete: boolean;
}
interface RawBinding {
  initializeClient(
    service: string,
    options: Record<string, unknown>,
    callback: (error: Error | null, client?: RawClient) => void,
  ): unknown;
}

type Loaded = { readonly binding: RawBinding } | { readonly reason: string };

export interface LoadKerberosOptions {
  /** The vendored binding; when absent, the installed `kerberos` package's own binding. */
  readonly bindingPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}

/** A provider over the binding at `bindingPath`. Never throws: a load failure becomes a reason. */
export function loadKerberosProvider(options: LoadKerberosOptions = {}): KerberosProvider {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  let loaded: Loaded | undefined;

  const load = (): Loaded => {
    if (loaded !== undefined) return loaded;
    const require = createRequire(import.meta.url);
    try {
      const path =
        options.bindingPath ??
        require.resolve('kerberos/package.json').replace(/package\.json$/, 'build/Release/kerberos.node');
      loaded = { binding: require(path) as RawBinding };
    } catch (error) {
      loaded = { reason: reasonFor(error, platform, arch) };
    }
    return loaded;
  };

  return {
    availability() {
      const state = load();
      return 'binding' in state ? { available: true } : { available: false, reason: state.reason };
    },
    async initClient(input) {
      const state = load();
      if (!('binding' in state)) throw new Error(state.reason);
      const raw = await callNative<RawClient>((callback) =>
        state.binding.initializeClient(
          input.spn,
          {
            mechOID: GSS_MECH_OID_KRB5,
            flags: GSS_C_MUTUAL_FLAG,
            ...(input.principal !== undefined ? { principal: input.principal } : {}),
            ...(input.user !== undefined ? { user: input.user } : {}),
            ...(input.domain !== undefined ? { domain: input.domain } : {}),
            ...(input.password !== undefined ? { password: input.password } : {}),
          },
          callback,
        ),
      );
      return {
        step: (challenge) => callNative<string>((callback) => raw.step(challenge, callback)),
        get contextComplete() {
          return raw.contextComplete;
        },
      };
    },
  };
}

/**
 * Calls a binding function in either of its shapes. The N-API binding takes a callback, but once
 * the `kerberos` package's lib/index.js loads anywhere in the process it replaces
 * `KerberosClient.prototype.step` on the shared native class with an async function that ignores
 * the callback. Promisifying alone then hangs, and the rejection goes unhandled.
 */
function callNative<T>(invoke: (callback: (error: Error | null, value?: T) => void) => unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (error: unknown, value?: T): void => {
      if (settled) return;
      settled = true;
      if (error !== null && error !== undefined) {
        reject(error instanceof Error ? error : new Error('The Kerberos binding failed.', { cause: error }));
      } else resolve(value as T);
    };
    try {
      const returned = invoke((error, value) => settle(error, value));
      if (isThenable<T>(returned))
        returned.then(
          (value) => settle(null, value),
          (error: unknown) => settle(error),
        );
    } catch (error) {
      settle(error);
    }
  });
}

function isThenable<T>(value: unknown): value is PromiseLike<T> {
  return typeof (value as { then?: unknown } | null)?.then === 'function';
}

function reasonFor(error: unknown, platform: NodeJS.Platform, arch: string): string {
  if (platform === 'win32' && arch === 'arm64') return 'Kerberos is not available on Windows on ARM.';
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'MODULE_NOT_FOUND') return 'The Kerberos component is not installed.';
  const message = error instanceof Error ? error.message : String(error);
  if (/libgssapi|libkrb5/.test(message)) {
    return `The Kerberos libraries could not be loaded (${message}). Install the krb5 libraries (libgssapi-krb5-2 or krb5-libs).`;
  }
  return `The Kerberos component could not be loaded: ${message}`;
}

let configured: KerberosProvider | undefined;
let installed: KerberosProvider | undefined;

/** Sets the provider every Kerberos send uses; `undefined` restores the installed package's. */
export function configureKerberos(provider: KerberosProvider | undefined): void {
  configured = provider;
}

/** The provider in force: the configured one, else the installed `kerberos` package's binding. */
export function kerberosProvider(): KerberosProvider {
  if (configured !== undefined) return configured;
  installed ??= loadKerberosProvider();
  return installed;
}
