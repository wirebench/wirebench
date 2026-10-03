/**
 * Builds the forward sink the configuration names (issue #209): `syslog+tcp:` and `syslog+tls:` make a
 * {@link SyslogSink}, `https:` (and loopback `http:`) an {@link HttpsSink}. The CA file is read here,
 * once, at start; a file that cannot be read or holds no certificate is a configuration error.
 * Config has already validated the URL, the token and the CA file's combination with the scheme.
 */
import { readFile } from 'node:fs/promises';
import { splitPemBundle } from '@wirebench/engine';
import { ConfigError, type ServerConfig } from '../../config.js';
import { FORWARD_TIMEOUT_MS, type ForwardSink } from './forwarder.js';
import { HttpsSink } from './https-sink.js';
import { SyslogSink } from './syslog-sink.js';
import { reason } from './trust.js';

const CA_VARIABLE = 'WIREBENCH_SERVER_AUDIT_FORWARD_CA_FILE';

export type ForwardConfig = Pick<ServerConfig, 'auditForwardUrl' | 'auditForwardToken' | 'auditForwardCaFile'>;

/** The sink for `config`, or `undefined` when forwarding is not configured. */
export async function sinkFromConfig(config: ForwardConfig): Promise<ForwardSink | undefined> {
  if (config.auditForwardUrl === undefined) return undefined;
  const url = new URL(config.auditForwardUrl);
  const ca = config.auditForwardCaFile === undefined ? undefined : await readCa(config.auditForwardCaFile);
  if (url.protocol === 'syslog+tcp:' || url.protocol === 'syslog+tls:') {
    const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
    return new SyslogSink({
      host,
      port: Number(url.port),
      timeoutMs: FORWARD_TIMEOUT_MS,
      ...(url.protocol === 'syslog+tls:' ? { tls: ca !== undefined ? { ca } : {} } : {}),
    });
  }
  return new HttpsSink({
    url: url.href,
    timeoutMs: FORWARD_TIMEOUT_MS,
    ...(config.auditForwardToken !== undefined ? { token: config.auditForwardToken } : {}),
    ...(ca !== undefined ? { ca } : {}),
  });
}

async function readCa(path: string): Promise<string> {
  let pem: string;
  try {
    pem = await readFile(path, 'utf8');
  } catch (error) {
    throw new ConfigError([{ variable: CA_VARIABLE, message: `could not be read: ${reason(error)}` }]);
  }
  if (splitPemBundle(pem).length === 0)
    throw new ConfigError([{ variable: CA_VARIABLE, message: 'holds no PEM certificate' }]);
  return pem;
}
