import type { SendHost } from '#core/run/host';

export function testHost(secrets: Readonly<Record<string, string>> = {}, extra: Partial<SendHost> = {}): SendHost {
  return { getSecret: (ref) => Promise.resolve(secrets[ref]), ...extra };
}
