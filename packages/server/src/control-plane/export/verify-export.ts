/**
 * An export's audit chain, verified with no database (hosted edition spec §22.9, §13 criterion 6): the rows of
 * `tables/audit_events.ndjson`, the anchor and the chain key from `manifest.json`, through the same walk
 * `admin audit verify` runs on a database. The export writes each row's chain columns as the chain reads them (a
 * time in the canonical UTC form, `abbrev(ip)`, `details` as PostgreSQL's `jsonb` text), so an auditor with the file
 * alone recomputes every link, and a byte edited after the server wrote it names its event.
 */
import { createHash, type Hash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { WirebenchError } from '@wirebench/engine';
import type { CanonicalRow } from '../../audit-log/chain/canonical.js';
import {
  walkChain,
  type ChainReader,
  type VerifyOptions,
  type VerifySummary,
  type WrongKey,
} from '../../audit-log/chain/verify.js';
import type { ChainAnchor, SealedRow } from '../../audit-log/repo.js';
import { MANIFEST_MAX_BYTES, parseManifest, type ExportManifest } from './export.js';
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

/** Every line of `chunks` as JSON, `hash` fed every byte; a character split across two chunks waits for its last byte. */
async function* linesOf(chunks: AsyncIterable<Buffer>, hash: Hash): AsyncGenerator<Record<string, unknown>> {
  const decoder = new StringDecoder('utf8');
  let rest = '';
  const parse = (line: string): Record<string, unknown> => {
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw invalid('a line of audit_events.ndjson is not JSON');
    }
  };
  for await (const chunk of chunks) {
    hash.update(chunk);
    const lines = (rest + decoder.write(chunk)).split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) if (line !== '') yield parse(line);
  }
  const last = rest + decoder.end();
  if (last !== '') yield parse(last);
}

/**
 * The walk's reader over a stream of lines: sealed rows a page at a time, in the file's order (the export writes them
 * in chain order, and the walk reports any other as a break), unsealed ones counted on the way. The count drains the
 * rest of the stream, so it is complete whenever the walk asks for it.
 */
function streamReader(lines: AsyncGenerator<Record<string, unknown>>, anchor: ChainAnchor | undefined): ChainReader {
  let unsealed = 0;
  let done = false;
  const next = async (): Promise<SealedRow | undefined> => {
    while (!done) {
      const read = await lines.next();
      if (read.done === true) {
        done = true;
        break;
      }
      const row = sealedRowOf(read.value);
      if (row !== undefined) return row;
      unsealed++;
    }
    return undefined;
  };
  return {
    anchor: () => Promise.resolve(anchor),
    page: async (_after, limit) => {
      const page: SealedRow[] = [];
      while (page.length < limit) {
        const row = await next();
        if (row === undefined) break;
        page.push(row);
      }
      return page;
    },
    unsealed: async () => {
      while (await next()) {
        // Drained: only the count is wanted now.
      }
      return unsealed;
    },
  };
}

/**
 * Verifies the export at `path`, streaming its audit rows: nothing but a page of them is held at a time.
 * `manifest.json` must come first, as the export writes it, and be at most 16 MB.
 *
 * @throws WirebenchError `export-archive-invalid` when it has no manifest first or no audit file, or a line is not
 *   JSON
 */
export async function verifyExportChain(path: string, options: VerifyOptions = {}): Promise<ExportVerifyOutcome> {
  let manifest: ExportManifest | undefined;
  for await (const entry of readTarGz(path)) {
    if (manifest === undefined) {
      if (entry.name !== 'manifest.json') throw invalid('manifest.json is not its first file');
      if (entry.size > MANIFEST_MAX_BYTES) throw invalid('the manifest is larger than any export writes');
      manifest = parseManifest(await entry.buffer(), 'export-archive-invalid');
      if (manifest.chain === null || manifest.chain === undefined) return { kind: 'no-key' };
      continue;
    }
    if (entry.name !== 'tables/audit_events.ndjson') continue;
    const chain = manifest.chain!;
    const hash = createHash('sha256');
    const reader = streamReader(
      linesOf(entry.chunks(), hash),
      chain.anchor === null ? undefined : anchorOf(chain.anchor),
    );
    const outcome = await walkChain(reader, Buffer.from(chain.keyHex, 'hex').toString('utf8'), options);
    // A wrong key returns before any row: the rest is read for the checksum all the same.
    await reader.unsealed();
    return { ...outcome, checksum: manifest.tables['audit_events']?.sha256 === hash.digest('hex') };
  }
  throw invalid(manifest === undefined ? 'it has no manifest.json' : 'it has no tables/audit_events.ndjson');
}
