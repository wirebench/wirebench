/**
 * What a browser caller on the agent may reach (hosted edition spec §18.1, ADR-0035): the `agent.*` group
 * and nothing else of the registry. The desktop's own window may call nearly every channel; a page on the
 * team server's address is not inside the signed app, and a compromised server or an injected script must
 * not become file access or a shell on every paired machine. Every other channel answers
 * `host-capability-missing`, a channel added to the registry later included, until someone decides
 * otherwise here.
 */
import type { Capability } from '@wirebench/host';

/** The one channel group a browser caller reaches. */
export const AGENT_GROUP = 'agent';

/** Whether a browser caller on the agent may call `channel`. */
export function isAgentChannel(channel: string): boolean {
  return channel.startsWith(`${AGENT_GROUP}.`) && channel.length > AGENT_GROUP.length + 1;
}

/**
 * The capabilities a browser tab may use through the agent, while `agent.send` runs a bundle (§2's browser
 * subset): none of them is a channel the page can call by itself. The hello names the platform's own,
 * cut to these, and only those a bundle send really has: `secret-sources` waits for #792 (a source-backed
 * name answers `secret-missing` on the agent), and `team-secrets` is claimed only by an embedder that resolves
 * them (the desktop, through {@link browserCapabilities}'s `teamSecrets`). `ssh` is served by nothing yet,
 * and no opt-in is recorded for it (both agents pair with `sshOptIn: false`), so it is not here; the
 * renderer-gated ones of slice 2 (`listen`, `windows`, `accounts`, `reveal-secrets`) are refused too.
 */
export const BROWSER_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  'send:public',
  'send:private',
  'kerberos',
]);

/**
 * The platform's capabilities a browser caller is told of, in the platform's order. `teamSecrets` adds
 * `team-secrets` (when the platform has it) for an embedder whose bundle sends resolve them: the desktop's.
 */
export function browserCapabilities(
  platform: ReadonlySet<Capability>,
  options: { readonly teamSecrets?: boolean } = {},
): Capability[] {
  return [...platform].filter(
    (capability) =>
      BROWSER_CAPABILITIES.has(capability) || (capability === 'team-secrets' && options.teamSecrets === true),
  );
}
