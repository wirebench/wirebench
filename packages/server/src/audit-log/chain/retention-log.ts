/**
 * The error retention logs when its window shows tampering (audit-chain spec §3.3): a link that does not
 * match, or a skipped sequence number. Retention then deletes nothing past that row, and the sweep would
 * hit it again every ten minutes, so each distinct seq is logged once per process.
 */
import type { FastifyBaseLogger } from 'fastify';

export class RetentionStopLog {
  private readonly logged = new Set<bigint>();

  constructor(private readonly log: FastifyBaseLogger) {}

  /** Retention stopped at `seq`: a gap or a link that does not match. */
  stoppedAt(seq: bigint): void {
    if (this.logged.has(seq)) return;
    this.logged.add(seq);
    this.log.error(
      { seq: seq.toString() },
      `audit chain retention stopped at seq ${seq.toString()}: run wirebench-server admin audit verify`,
    );
  }
}
