/**
 * The durable queue of desktop audit events (desktop audit events spec §2.4): one JSON file per event
 * in a folder, named by a zero-padded sequence so a directory listing is the order, each written
 * atomically. Past the cap the oldest are deleted and counted in `dropped.json`, which travels with
 * the next batch. Electron-free.
 */
import { DESKTOP_AUDIT_LIMITS, desktopAuditEventSchema, nodeFs, writeFileAtomic } from '@wirebench/engine';
import type { DesktopAuditEvent } from '@wirebench/engine';
import { join } from 'node:path';

const EVENT_FILE = /^\d{10}\.json$/;
const DROPPED_FILE = 'dropped.json';

export interface OutboxItem {
  readonly name: string;
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

  append(event: DesktopAuditEvent): Promise<void> {
    return this.serial(async () => {
      const names = await this.names();
      this.nextSeq ??= (names.length > 0 ? Number(names[names.length - 1]!.slice(0, 10)) : 0) + 1;
      const name = `${String(this.nextSeq++).padStart(10, '0')}.json`;
      await writeFileAtomic(nodeFs, join(this.dir, name), JSON.stringify(event));
      names.push(name);
      const over = names.length - this.max;
      if (over > 0) {
        await this.rmAll(names.slice(0, over));
        await this.writeDropped((await this.dropped()) + over);
      }
    });
  }

  /** The oldest `n` events. A file that is unreadable or no longer a valid event is deleted, not returned. */
  async peek(n: number): Promise<OutboxItem[]> {
    const items: OutboxItem[] = [];
    for (const name of await this.names()) {
      if (items.length >= n) break;
      try {
        const parsed = desktopAuditEventSchema.safeParse(
          JSON.parse((await nodeFs.readFile(join(this.dir, name))).toString('utf-8')),
        );
        if (parsed.success) {
          items.push({ name, event: parsed.data });
          continue;
        }
      } catch {
        /* unreadable: handled below */
      }
      await this.rmAll([name]);
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
