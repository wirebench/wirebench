/** What the command line lends a send: the environment's secrets and proxy, nothing else (spec §3.1). */
import type { GetSecret, SendHost } from '@wirebench/engine';
import { proxyFromEnv } from './proxy-env.js';

export function cliSendHost(args: {
  readonly getSecret: GetSecret;
  readonly env: NodeJS.ProcessEnv;
  readonly onSecretValue: (value: string) => void;
}): SendHost {
  const proxyFor = proxyFromEnv(args.env);
  return {
    getSecret: args.getSecret,
    proxyFor: (url) => Promise.resolve(proxyFor(url)),
    onSecretValue: args.onSecretValue,
  };
}
