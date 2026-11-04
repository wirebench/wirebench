/**
 * `wirebench-server admin audit export …` (audit-log spec §3.5): the lines the endpoint streams, to
 * stdout, for a scheduled collector on the box. It needs no license: the operator has the database. It
 * records `audit.exported` with the system actor. `admin audit verify` (audit-chain spec §3.4) is below.
 */
import { auditExportQuerySchema } from '@wirebench/engine';
import type { ServerCommand } from '../args.js';
import { recordAudit, SYSTEM_SOURCE, type ServerHooks } from '../context.js';
import { ExitCode, type ServerIo } from '../io.js';
import { verifyExportChain } from '../control-plane/export/verify-export.js';
import type { TenantDb } from '../tenancy/tenant-db.js';
import { verifyChain, type BrokenLink, type VerifySummary } from './chain/verify.js';
import { exportedEvent, exportLines, filterOf } from './routes.js';

type AuditCommand = Extract<ServerCommand, { command: 'admin-audit-export' }>;

export async function runAuditCommand(
  command: AuditCommand,
  env: { readonly db: TenantDb; readonly hooks: ServerHooks; readonly now: () => Date },
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
  /** `key` is the tenant's chain key (`chain/keys.ts`), not necessarily the configured one. */
  env: { readonly db: TenantDb; readonly hooks: ServerHooks; readonly key: string | undefined },
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

type VerifyExportCommand = Extract<ServerCommand, { command: 'admin-audit-verify-export' }>;

/** The `--json` line of a walk, as `admin audit verify` prints it. */
function summaryJson(summary: VerifySummary, head: VerifyCommand['head'], extra: Record<string, unknown> = {}): string {
  const seq = (value: bigint | null) => (value === null ? null : value.toString());
  return `${JSON.stringify({
    checked: summary.checked,
    firstSeq: seq(summary.firstSeq),
    lastSeq: seq(summary.lastSeq),
    unsealed: summary.unsealed,
    result: summary.result,
    ...(summary.broken !== undefined
      ? {
          broken: {
            seq: summary.broken.seq.toString(),
            ...(summary.broken.id !== undefined ? { id: summary.broken.id } : {}),
            reason: summary.broken.reason,
            message: brokenText(summary.broken),
          },
        }
      : {}),
    ...(head !== undefined && summary.broken === undefined
      ? { head: { seq: head.seq.toString(), olderThanKeptChain: summary.headBeforeAnchor === true } }
      : {}),
    ...extra,
  })}\n`;
}

/**
 * `wirebench-server admin audit verify --export <file> [--head <seq>:<hex>] [--json]` (hosted edition spec §22.9,
 * §13 criterion 6): an export's chain from its own `audit_events.ndjson`, anchor and key, with no database and no
 * configuration. Exit 0 intact, 1 broken (or the audit file not matching the manifest's checksum), 2 when the export
 * carries no key or the anchor names another. The key never reaches the output.
 */
export async function runVerifyExportCommand(command: VerifyExportCommand, io: ServerIo): Promise<number> {
  let outcome: Awaited<ReturnType<typeof verifyExportChain>>;
  try {
    outcome = await verifyExportChain(command.file, command.head !== undefined ? { head: command.head } : {});
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string') {
      io.stderr.write(`${code}: ${(error as Error).message}\n`);
      return ExitCode.Config;
    }
    throw error;
  }
  if (outcome.kind === 'no-key') {
    io.stderr.write('the export carries no chain key: its server had none, and nothing in it was sealed\n');
    return ExitCode.Config;
  }
  if (outcome.kind === 'wrong-key') {
    io.stderr.write(`wrong key (chain key id ${outcome.chainKeyId})\n`);
    return ExitCode.Config;
  }
  const mismatch = "tables/audit_events.ndjson does not match the manifest's checksum";
  if (command.json) {
    io.stdout.write(summaryJson(outcome, command.head, { checksum: outcome.checksum }));
  } else {
    io.stdout.write(summaryText(outcome, command.head));
    if (!outcome.checksum) io.stdout.write(`${mismatch}\n`);
  }
  return outcome.result === 'intact' && outcome.checksum ? ExitCode.Ok : ExitCode.Broken;
}
