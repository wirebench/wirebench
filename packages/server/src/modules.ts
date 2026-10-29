import type { ServerModule } from './context.js';
import { agentModule } from './agent/module.js';
import { auditLogModule } from './audit-log/module.js';
import { ciTokensModule } from './ci-tokens/module.js';
import { hooksModule } from './hooks/module.js';
import { hostModule } from './host/module.js';
import { identityModule } from './identity/module.js';
import { licensingModule } from './licensing/module.js';
import { liveModule } from './live/module.js';
import { ssoModule } from './sso/module.js';
import { syncModule } from './sync/module.js';
import { schedulesModule } from './schedules/module.js';
import { sessionLogsModule } from './session-logs/module.js';
import { teamsModule } from './teams/module.js';
import { terminalSharesModule } from './terminal-shares/module.js';

/**
 * The modules a production process runs, in registration order. Tests pass their own list.
 * licensing comes right after identity: its routes need identity's guard, and identity's seat checks
 * read `ctx.license` at request time.
 * server-sync comes after teams-access: its routes are guarded by teams-access's role rule.
 * webhook-capture comes next: its routes use the same guard, and the hub listens to its
 * announcements (webhook-capture §3.1).
 * ci-tokens comes after webhook-capture: a CI token may call only that module's capture reads.
 * live-updates comes last. It resolves roles through teams-access, and `@fastify/websocket` wraps
 * only the routes registered after it in the shared scope.
 * scheduled-runs comes after live-updates, whose hub listens to its announcement; its routes use
 * teams-access's role guard and read `ctx.license`.
 * audit-log comes last: its routes sit behind identity's guard and read `ctx.license`; its hook is found at
 * call time, so fire sites in earlier modules reach it.
 * sso comes after audit-log: its migration names `teams` and `audit_events`, and its routes use identity's
 * guard, teams-access's repository and the audit hook (saml-scim spec §5).
 * session-logs comes after them: its migration names `workspaces` and `users`, its routes use teams-access's
 * role guard and `ctx.license`, and it records audit events (team session logs spec A1).
 * terminal-shares comes after live-updates: its socket route needs the `@fastify/websocket` live registers
 * (team session logs and sharing spec B1).
 * host comes last: its socket route needs the same plugin, its hosts' live clients run live's socket loop,
 * and it closes the sockets of a session that `sessionEnded` reports (hosted edition spec §17.3). It
 * registers nothing while the browser client is off.
 * agent comes after host (hosted edition spec §18.2): it announces `agentUnpaired` for the server host,
 * which does not listen yet. It too registers nothing while the browser client is off.
 */
export const BUILTIN_MODULES: readonly ServerModule[] = [
  identityModule(),
  licensingModule(),
  teamsModule(),
  syncModule(),
  hooksModule(),
  ciTokensModule(),
  liveModule(),
  schedulesModule(),
  auditLogModule(),
  ssoModule(),
  sessionLogsModule(),
  terminalSharesModule(),
  hostModule(),
  agentModule(),
];
