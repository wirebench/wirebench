/**
 * The durable queue of desktop audit events (desktop audit events spec §2.4): one JSON file per event
 * in a folder, named by a zero-padded sequence so a directory listing is the order, each written
 * atomically. Past the cap the oldest are deleted and counted in `dropped.json`, which travels with
 * the next batch. Each entry is stamped with the account that queued it (`{ userId, event }`): the stamp
 * stays here, only the event goes on the wire, and the reporter sends an entry only as that account.
 * Electron-free.
 */
import { DESKTOP_AUDIT_LIMITS, desktopAuditEventSchema, nodeFs, writeFileAtomic } from '@wirebench/engine';
import type { DesktopAuditEvent } from '@wirebench/engine';
import { join } from 'node:path';

const outboxes = new Map<string, AuditOutbox>();

/** One outbox per folder for the process: two instances could pick the same sequence number. */
export function outboxFor(dir: string): AuditOutbox {
  let outbox = outboxes.get(dir);
  if (outbox === undefined) {
    outbox = new AuditOutbox(dir);
    outboxes.set(dir, outbox);
  }
  return outbox;
}

const EVENT_FILE = /^\d{10}\.json$/;
const DROPPED_FILE = 'dropped.json';

export interface OutboxItem {
  readonly name: string;
  /** The account that queued the event; never sent. */
  readonly userId: string;
  readonly event: DesktopAuditEvent;
}

export class AuditOutbox {
  private nextSeq: number | undefined;
  private readonly max: number;
  /** Appends run one at a time: the sequence and the cap check are read-modify-write. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly dir: string,
    options: { readonly max?: number } = {},
  ) {
    this.max = options.max ?? DESKTOP_AUDIT_LIMITS.maxOutbox;
  }

  append(event: DesktopAuditEvent, userId: string): Promise<void> {
    return this.serial(async () => {
      const names = await this.names();
      this.nextSeq ??= (names.length > 0 ? Number(names[names.length - 1]!.slice(0, 10)) : 0) + 1;
      const name = `${String(this.nextSeq++).padStart(10, '0')}.json`;
      await writeFileAtomic(nodeFs, join(this.dir, name), JSON.stringify({ userId, event }));
      names.push(name);
      const over = names.length - this.max;
      if (over > 0) {
        await this.rmAll(names.slice(0, over));
        await this.writeDropped((await this.dropped()) + over);
      }
    });
  }

  /**
   * The oldest `n` events. A file that is unreadable, carries no owner, or is no longer a valid event is
   * deleted and counted as dropped, not returned.
   */
  async peek(n: number): Promise<OutboxItem[]> {
    const items: OutboxItem[] = [];
    for (const name of await this.names()) {
      if (items.length >= n) break;
      try {
        const entry = JSON.parse((await nodeFs.readFile(join(this.dir, name))).toString('utf-8')) as {
          readonly userId?: unknown;
          readonly event?: unknown;
        } | null;
        const parsed = desktopAuditEventSchema.safeParse(entry?.event);
        if (typeof entry?.userId === 'string' && entry.userId.length > 0 && parsed.success) {
          items.push({ name, userId: entry.userId, event: parsed.data });
          continue;
        }
      } catch {
        /* unreadable: handled below */
      }
      await this.remove([name]);
      await this.addDropped(1);
    }
    return items;
  }

  remove(names: readonly string[]): Promise<void> {
    return this.serial(() => this.rmAll(names));
  }

  clear(): Promise<void> {
    return this.serial(async () => {
      await this.rmAll([...(await this.names()), DROPPED_FILE]);
    });
  }

  async dropped(): Promise<number> {
    try {
      const parsed = JSON.parse((await nodeFs.readFile(join(this.dir, DROPPED_FILE))).toString('utf-8')) as {
        readonly count?: unknown;
      };
      return typeof parsed.count === 'number' && parsed.count > 0 ? Math.floor(parsed.count) : 0;
    } catch {
      return 0;
    }
  }

  /** Counts events that were discarded outside the cap (a batch the server refused, a corrupt file). */
  addDropped(count: number): Promise<void> {
    return this.serial(async () => {
      if (count > 0) await this.writeDropped((await this.dropped()) + count);
    });
  }

  /** Subtracts what a batch carried; events dropped while it was in flight stay counted. */
  clearDropped(count?: number): Promise<void> {
    return this.serial(async () => {
      const left = count === undefined ? 0 : Math.max(0, (await this.dropped()) - count);
      await this.writeDropped(left);
    });
  }

  private async writeDropped(count: number): Promise<void> {
    if (count <= 0) await this.rmAll([DROPPED_FILE]);
    else await writeFileAtomic(nodeFs, join(this.dir, DROPPED_FILE), JSON.stringify({ count }));
  }

  private async names(): Promise<string[]> {
    try {
      return (await nodeFs.readdir(this.dir))
        .map((e) => e.name)
        .filter((n) => EVENT_FILE.test(n))
        .sort();
    } catch {
      return [];
    }
  }

  private async rmAll(names: readonly string[]): Promise<void> {
    for (const name of names) await nodeFs.rm(join(this.dir, name), { force: true });
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
