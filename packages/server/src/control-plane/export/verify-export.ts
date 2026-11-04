/**
 * An export's audit chain, verified with no database (hosted edition spec §22.9, §13 criterion 6): the rows of
 * `tables/audit_events.ndjson`, the anchor and the chain key from `manifest.json`, through the same walk
 * `admin audit verify` runs on a database. The export writes each row's chain columns as the chain reads them (a
 * time in the canonical UTC form, `abbrev(ip)`, `details` as PostgreSQL's `jsonb` text), so an auditor with the file
 * alone recomputes every link, and a byte edited after the server wrote it names its event.
 */
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { WirebenchError } from '@wirebench/engine';
import type { CanonicalRow } from '../../audit-log/chain/canonical.js';
import {
  verifyChainRows,
  type VerifyOptions,
  type VerifySummary,
  type WrongKey,
} from '../../audit-log/chain/verify.js';
import type { ChainAnchor, SealedRow } from '../../audit-log/repo.js';
import type { ExportManifest } from './export.js';
import { readTarGz } from './tar.js';

/** The `audit_events` column each canonical field is read from. */
const CANONICAL_COLUMNS: Readonly<Record<keyof CanonicalRow, string>> = {
  id: 'id',
  at: 'at',
  actorKind: 'actor_kind',
  actorUserId: 'actor_user_id',
  actorEmail: 'actor_email',
  actorTokenId: 'actor_token_id',
  actorWorkspaceId: 'actor_workspace_id',
  action: 'action',
  targetKind: 'target_kind',
  targetId: 'target_id',
  workspaceId: 'workspace_id',
  teamId: 'team_id',
  ip: 'ip',
  userAgent: 'user_agent',
  details: 'details',
};

const invalid = (why: string): WirebenchError =>
  new WirebenchError('export-archive-invalid', `the export archive is not valid: ${why}`);

/** A column's value as the chain's text: what the export wrote, a string or a JSON scalar. */
function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** One NDJSON line as a chain row; `undefined` for a row not sealed yet. */
function sealedRowOf(line: Record<string, unknown>): SealedRow | undefined {
  const seq = line['chain_seq'];
  if (seq === null || seq === undefined) return undefined;
  if (typeof seq !== 'string' || !/^-?\d+$/.test(seq))
    throw invalid('a chain_seq of audit_events.ndjson is not a number');
  const row = Object.fromEntries(
    Object.entries(CANONICAL_COLUMNS).map(([field, column]) => [field, text(line[column])]),
  ) as unknown as CanonicalRow;
  const hash = line['chain_hash'];
  return {
    seq: BigInt(seq),
    hash: typeof hash === 'string' ? Buffer.from(hash, 'base64') : Buffer.alloc(0),
    row,
  };
}

function anchorOf(anchor: NonNullable<NonNullable<ExportManifest['chain']>['anchor']>): ChainAnchor {
  return {
    seq: BigInt(anchor.seq),
    hash: Buffer.from(anchor.hash, 'hex'),
    keyId: anchor.keyId,
    headSeq: BigInt(anchor.headSeq),
    mac: Buffer.from(anchor.mac, 'hex'),
  };
}

export type ExportVerifyOutcome =
  /** The export carries no chain key: its server had none, and nothing was sealed. */
  | { readonly kind: 'no-key' }
  | (WrongKey & { readonly checksum: boolean })
  | (VerifySummary & {
      /** Whether `audit_events.ndjson` matches its SHA-256 in the manifest. */
      readonly checksum: boolean;
    });

/**
 * Verifies the export at `path`.
 *
 * @throws WirebenchError `export-archive-invalid` when it has no manifest or no audit file, or a line is not JSON
 */
export async function verifyExportChain(path: string, options: VerifyOptions = {}): Promise<ExportVerifyOutcome> {
  let manifest: ExportManifest | undefined;
  const sealed: SealedRow[] = [];
  let unsealed = 0;
  let sha256: string | undefined;
  for await (const entry of readTarGz(path)) {
    if (entry.name === 'manifest.json') {
      manifest = JSON.parse((await entry.buffer()).toString('utf8')) as ExportManifest;
    } else if (entry.name === 'tables/audit_events.ndjson') {
      const hash = createHash('sha256');
      // A character split across two chunks is held until its last byte.
      const decoder = new StringDecoder('utf8');
      let rest = '';
      const take = (line: string): void => {
        if (line === '') return;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
          throw invalid('a line of audit_events.ndjson is not JSON');
        }
        const row = sealedRowOf(parsed);
        if (row === undefined) unsealed++;
        else sealed.push(row);
      };
      for await (const chunk of entry.chunks()) {
        hash.update(chunk);
        const lines = (rest + decoder.write(chunk)).split('\n');
        rest = lines.pop() ?? '';
        for (const line of lines) take(line);
      }
      take(rest + decoder.end());
      sha256 = hash.digest('hex');
    }
  }
  if (manifest === undefined) throw invalid('it has no manifest.json');
  if (sha256 === undefined) throw invalid('it has no tables/audit_events.ndjson');
  const chain = manifest.chain;
  if (chain === null || chain === undefined) return { kind: 'no-key' };
  const checksum = manifest.tables['audit_events']?.sha256 === sha256;
  const key = Buffer.from(chain.keyHex, 'hex').toString('utf8');
  const outcome = await verifyChainRows(
    { anchor: chain.anchor === null ? undefined : anchorOf(chain.anchor), sealed, unsealed },
    key,
    options,
  );
  return { ...outcome, checksum };
}
