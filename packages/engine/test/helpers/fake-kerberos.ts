import type { KerberosClientLike, KerberosInitInput, KerberosProvider } from '../../src/http/auth/kerberos-native.js';

export interface FakeKerberos extends KerberosProvider {
  readonly inits: KerberosInitInput[];
  readonly steps: string[];
  /** Settles every hung call successfully. */
  release(): void;
  /** Settles every hung call with a GSS failure. */
  fail(): void;
}

/**
 * A scriptable provider: the first step returns `token` (base64), a later step fails when `verifyFails`.
 * With `hang`, that call (`init`, the first `step`, or the `verify` step) waits for `release()` or `fail()`.
 */
export function fakeKerberos(
  options: {
    readonly unavailable?: string;
    readonly initError?: string;
    readonly token?: string;
    readonly verifyFails?: boolean;
    readonly hang?: 'init' | 'step' | 'verify';
  } = {},
): FakeKerberos {
  const inits: KerberosInitInput[] = [];
  const steps: string[] = [];
  const hung: { settle: () => void; reject: (error: Error) => void }[] = [];
  const held = <T>(value: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      hung.push({ settle: () => void value().then(resolve, reject), reject });
    });
  return {
    inits,
    steps,
    release: () => hung.splice(0).forEach((call) => call.settle()),
    fail: () => hung.splice(0).forEach((call) => call.reject(new Error('GSS failure: hung call failed'))),
    availability: () =>
      options.unavailable !== undefined ? { available: false, reason: options.unavailable } : { available: true },
    initClient(input) {
      inits.push(input);
      if (options.unavailable !== undefined) return Promise.reject(new Error(options.unavailable));
      if (options.initError !== undefined) return Promise.reject(new Error(options.initError));
      let complete = false;
      const client: KerberosClientLike = {
        step(challenge) {
          steps.push(challenge);
          const answer = (): Promise<string> => {
            if (challenge === '') return Promise.resolve(options.token ?? Buffer.from('ap-req').toString('base64'));
            if (options.verifyFails === true) return Promise.reject(new Error('GSS failure: Bad integrity check'));
            complete = true;
            return Promise.resolve('');
          };
          const hangs = challenge === '' ? options.hang === 'step' : options.hang === 'verify';
          return hangs ? held(answer) : answer();
        },
        get contextComplete() {
          return complete;
        },
      };
      return options.hang === 'init' ? held(() => Promise.resolve(client)) : Promise.resolve(client);
    },
  };
}
