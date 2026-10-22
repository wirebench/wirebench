/**
 * `wirebench ssh forward` (#460, `docs/specs/2026-10-12-ssh-forwarding-layouts-design.md` D7): its options,
 * help and parsing. It is parsed apart from the other verbs because its `--port` repeats (`<rule>=<n>`)
 * where `mock`'s takes one number.
 */
import { parseArgs } from 'node:util';
import { secretSourcesOptionsFrom } from './source-secrets.js';
import type { CliSecretSourcesOptions } from './source-secrets.js';
import type { FeatureArgs } from './features.js';
import { UsageError } from './usage-error.js';

const USAGE = 'wirebench ssh forward <host> [rule…] | --group <id>';

export const SSH_HELP = `${USAGE} [--workspace <dir>] [--port <rule>=<n>]… [--host-key SHA256:<b64>]…
                      [--known-hosts <file>] [--allow-network-bind] [--no-secret-sources]
                      [--trust-secret-sources | --trust-secret-sources-hash <h>] [--json] [-q]

Opens a host's port forwarding rules from the workspace's hosts.yaml, the same tunnels the app would,
and keeps them open until Ctrl-C (SIGINT) or SIGTERM. Exit 0 when stopped, 2 for a usage problem, 3
when a secret is missing, a host key is not trusted, a port is taken, the host refuses a rule or
reconnecting gives up.

<host>                 A host's id in hosts.yaml. Jump hosts are dialled as the app dials them.
[rule…]                Rule ids to start. None = every rule switched on for the host.
--group <id>           Start every rule of a forwarding group instead, across its hosts. Any rule
                       that fails ends the run, as with one host.
--workspace <dir>      The workspace folder. Default: the nearest workspace.yaml above this folder.
--port <rule>=<n>      Listen on <n> instead of the rule's port (1-65535). Repeatable. With --group,
                       name the rule as <host>/<rule>.
--host-key SHA256:<b64>
                       Accept this host key fingerprint, on any hop, for this run only. Repeatable.
--known-hosts <file>   Trusted host keys to check against instead of the app's ssh-known-hosts.json
                       in its data folder. Read only: neither file is ever written.
--allow-network-bind   Allow a rule that listens on an address other than loopback.
--no-secret-sources    Read secrets from WIREBENCH_SECRET_<NAME> only; skip the workspace's
                       secret sources.
--trust-secret-sources Use the workspace's shared secret sources as they are.
--trust-secret-sources-hash <hash>
                       Use them only if the mapping's hash is <hash> (secrets list prints it).
--json                 One JSON object per line for every status change, instead of text.
-q, --quiet            Print nothing but errors.

Secrets come from WIREBENCH_SECRET_<NAME> (the name in \${secret:NAME}, upper-cased), then the
workspace's secret sources. An agent host uses SSH_AUTH_SOCK (Pageant on Windows).`;

export interface SshForwardArgs {
  readonly command: 'ssh-forward';
  /** Absent with `group`. */
  readonly host?: string;
  readonly rules: readonly string[];
  /** A forwarding group's id (#583): its rules on every host it names. */
  readonly group?: string;
  readonly workspace?: string;
  readonly ports: Readonly<Record<string, number>>;
  /** 'SHA256:<b64>' each. */
  readonly hostKeys: readonly string[];
  readonly knownHosts?: string;
  readonly allowNetworkBind: boolean;
  readonly secretSources: CliSecretSourcesOptions;
  readonly json: boolean;
  readonly quiet: boolean;
}

/** A SHA-256 fingerprint as OpenSSH prints it: base64 without padding (43 characters), padding tolerated. */
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]+={0,2}$/;

function parsePort(spec: string): readonly [string, number] {
  const match = /^([^=]+)=(\d+)$/.exec(spec);
  const port = Number(match?.[2]);
  if (match === null || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UsageError(`--port must be "<rule>=<port>" with a port from 1 to 65535, got "${spec}"`);
  }
  return [match[1] as string, port];
}

/** Parses `ssh …` after the verb, or answers its help. */
export function parseSsh(
  argv: readonly string[],
): (SshForwardArgs | { readonly command: 'help'; readonly topic: 'ssh' }) & FeatureArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        workspace: { type: 'string' },
        group: { type: 'string' },
        port: { type: 'string', multiple: true },
        'host-key': { type: 'string', multiple: true },
        'known-hosts': { type: 'string' },
        'allow-network-bind': { type: 'boolean' },
        'no-secret-sources': { type: 'boolean' },
        'trust-secret-sources': { type: 'boolean' },
        'trust-secret-sources-hash': { type: 'string' },
        json: { type: 'boolean' },
        quiet: { type: 'boolean', short: 'q' },
        help: { type: 'boolean', short: 'h' },
        // Every verb takes it (feature switches spec §5.1); `ssh forward` has nothing to switch.
        features: { type: 'string' },
      },
    });
  } catch (error) {
    if (error instanceof TypeError) throw new UsageError(error.message);
    throw error;
  }
  const { values, positionals } = parsed;
  if (values.help === true) return { command: 'help', topic: 'ssh' };
  const [sub, host, ...rules] = positionals;
  if (sub !== 'forward') {
    throw new UsageError(`${USAGE}: unknown subcommand "${sub ?? ''}"`);
  }
  const group = values.group;
  if (group !== undefined && host !== undefined) {
    throw new UsageError(`${USAGE}: --group starts the group's own rules; name no host or rule`);
  }
  if (group === undefined && host === undefined) {
    throw new UsageError(`${USAGE}: <host> or --group is required`);
  }
  const hostKeys = values['host-key'] ?? [];
  for (const key of hostKeys) {
    if (!FINGERPRINT.test(key)) {
      throw new UsageError(`--host-key takes a SHA256:<base64> fingerprint as the refusal prints it, got "${key}"`);
    }
  }
  return {
    command: 'ssh-forward',
    ...(host === undefined ? {} : { host }),
    rules,
    ...(group === undefined ? {} : { group }),
    ...(values.workspace !== undefined ? { workspace: values.workspace } : {}),
    ports: Object.fromEntries((values.port ?? []).map(parsePort)),
    hostKeys,
    ...(values['known-hosts'] !== undefined ? { knownHosts: values['known-hosts'] } : {}),
    allowNetworkBind: values['allow-network-bind'] === true,
    secretSources: secretSourcesOptionsFrom(values),
    json: values.json === true,
    quiet: values.quiet === true,
    ...(values.features !== undefined ? { features: values.features } : {}),
  };
}
