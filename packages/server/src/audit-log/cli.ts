/**
 * `wirebench-server admin audit export …` (audit-log spec §3.5): the lines the endpoint streams, to
 * stdout, for a scheduled collector on the box. It needs no license: the operator has the database. It
 * records `audit.exported` with the system actor. `admin audit verify` (audit-chain spec §3.4) is below.
 */
import { auditExportQuerySchema } from '@wirebench/engine';
import type { ServerCommand } from '../args.js';
import { recordAudit, SYSTEM_SOURCE, type Database, type Querier, type ServerHooks } from '../context.js';
import { ExitCode, type ServerIo } from '../io.js';
import { verifyChain, type BrokenLink, type VerifySummary } from './chain/verify.js';
import { exportedEvent, exportLines, filterOf } from './routes.js';

type AuditCommand = Extract<ServerCommand, { command: 'admin-audit-export' }>;

export async function runAuditCommand(
  command: AuditCommand,
  env: { readonly db: Querier; readonly hooks: ServerHooks; readonly now: () => Date },
  io: ServerIo,
): Promise<number> {
  const parsed = auditExportQuerySchema.safeParse({
    ...(command.from !== undefined ? { from: new Date(command.from).toISOString() } : {}),
    ...(command.to !== undefined ? { to: new Date(command.to).toISOString() } : {}),
    ...(command.action !== undefined ? { action: command.action } : {}),
    ...(command.workspace !== undefined ? { workspaceId: command.workspace } : {}),
  });
  if (!parsed.success) {
    io.stderr.write(`${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n')}\n`);
    return ExitCode.Config;
  }
  const query = parsed.data;
  const lines = exportLines(env.db, filterOf(query), (count) =>
    recordAudit(env.hooks, env.db, exportedEvent(SYSTEM_SOURCE, query, count)),
  );
  for await (const line of lines) io.stdout.write(line);
  return ExitCode.Ok;
}

type VerifyCommand = Extract<ServerCommand, { command: 'admin-audit-verify' }>;

const NO_KEY = 'WIREBENCH_SERVER_AUDIT_CHAIN_KEY: not set; admin audit verify needs the chain key';

/** The broken link in words: the spec's reasons and its two `--head` messages. */
function brokenText(broken: BrokenLink): string {
  const seq = broken.seq.toString();
  switch (broken.reason) {
    case 'head not found':
      return `head ${seq} not found: newer rows were removed`;
    case 'head does not match':
      return `head ${seq} does not match`;
    default:
      if (broken.anchor === true) return 'anchor edited';
      return `${broken.reason} at seq ${seq}${broken.id !== undefined ? ` (row ${broken.id})` : ''}`;
  }
}

function summaryText(summary: VerifySummary, head: VerifyCommand['head']): string {
  const range =
    summary.firstSeq === null || summary.lastSeq === null
      ? ''
      : `, seq ${summary.firstSeq.toString()} to ${summary.lastSeq.toString()}`;
  const lines = [`checked ${String(summary.checked)} sealed rows${range}; ${String(summary.unsealed)} unsealed`];
  if (summary.broken !== undefined) lines.push(`broken: ${brokenText(summary.broken)}`);
  else {
    if (head !== undefined) {
      lines.push(
        summary.headBeforeAnchor === true
          ? `head ${head.seq.toString()} is older than the kept chain`
          : `head ${head.seq.toString()} matches`,
      );
    }
    lines.push(summary.checked === 0 ? 'empty and intact' : 'intact');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * `wirebench-server admin audit verify [--head <seq>:<hex>] [--json]` (audit-chain spec §3.4): exit 0
 * intact, 1 broken, 2 with no key or the wrong one. It needs no license. The key never reaches the
 * output. It records `audit.verified` after the walk, outside its read-only snapshot, broken or not.
 */
export async function runVerifyCommand(
  command: VerifyCommand,
  env: { readonly db: Database; readonly hooks: ServerHooks; readonly key: string | undefined },
  io: ServerIo,
): Promise<number> {
  if (env.key === undefined) {
    io.stderr.write(`${NO_KEY}\n`);
    return ExitCode.Config;
  }
  const outcome = await verifyChain(env.db, env.key, command.head !== undefined ? { head: command.head } : {});
  if (outcome.kind === 'wrong-key') {
    io.stderr.write(`wrong key (chain key id ${outcome.chainKeyId})\n`);
    return ExitCode.Config;
  }
  const seq = (value: bigint | null) => (value === null ? null : value.toString());
  const details = {
    checked: outcome.checked,
    firstSeq: seq(outcome.firstSeq),
    lastSeq: seq(outcome.lastSeq),
    unsealed: outcome.unsealed,
    result: outcome.result,
    ...(outcome.broken !== undefined ? { brokenSeq: outcome.broken.seq.toString() } : {}),
  };
  if (command.json) {
    io.stdout.write(
      `${JSON.stringify({
        ...details,
        ...(outcome.broken !== undefined
          ? {
              broken: {
                seq: outcome.broken.seq.toString(),
                ...(outcome.broken.id !== undefined ? { id: outcome.broken.id } : {}),
                reason: outcome.broken.reason,
                message: brokenText(outcome.broken),
              },
            }
          : {}),
        ...(command.head !== undefined && outcome.broken === undefined
          ? { head: { seq: command.head.seq.toString(), olderThanKeptChain: outcome.headBeforeAnchor === true } }
          : {}),
      })}\n`,
    );
  } else io.stdout.write(summaryText(outcome, command.head));
  await recordAudit(env.hooks, env.db, {
    ...SYSTEM_SOURCE,
    action: 'audit.verified',
    target: { kind: 'server' },
    details,
  });
  return outcome.result === 'intact' ? ExitCode.Ok : ExitCode.Broken;
}
