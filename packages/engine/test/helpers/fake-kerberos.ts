import type { KerberosClientLike, KerberosInitInput, KerberosProvider } from '../../src/http/auth/kerberos-native.js';

export interface FakeKerberos extends KerberosProvider {
  readonly inits: KerberosInitInput[];
  readonly steps: string[];
}

/** A scriptable provider: the first step returns `token` (base64), a later step fails when `verifyFails`. */
export function fakeKerberos(
  options: {
    readonly unavailable?: string;
    readonly initError?: string;
    readonly token?: string;
    readonly verifyFails?: boolean;
  } = {},
): FakeKerberos {
  const inits: KerberosInitInput[] = [];
  const steps: string[] = [];
  return {
    inits,
    steps,
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
          if (challenge === '') return Promise.resolve(options.token ?? Buffer.from('ap-req').toString('base64'));
          if (options.verifyFails === true) return Promise.reject(new Error('GSS failure: Bad integrity check'));
          complete = true;
          return Promise.resolve('');
        },
        get contextComplete() {
          return complete;
        },
      };
      return Promise.resolve(client);
    },
  };
}
