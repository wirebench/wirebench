/**
 * Streams session logs to Wirebench Server while their sessions run (team session logs spec A2, #430).
 * A log under a recording workspace gets an `<id>.upload.json` beside it, saying where it goes and how
 * many bytes of its append-only `<id>.log` the server holds. A send follows a write by about two seconds,
 * so a burst of output goes out as one chunk; the end is sent once everything is. A failure backs off and
 * tries again; the server's own size wins over the local count (a 409 reopens the log to learn it).
 *
 * Nothing here throws into a session: an upload that cannot continue stops, says so in the main log and
 * leaves the local log as it is. Electron-free: the clock, timers and client are injected.
 */
import { open, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { SESSION_LOG_LIMITS, isWirebenchError, nodeFs, writeFileAtomic } from '@wirebench/engine';
import type { ServerClient } from './server-client.js';
import { withToken } from './server-token.js';
import type { TokenSource } from './server-token.js';
import type { SessionLogMeta } from './session-logs.js';

export const UPLOAD_DEBOUNCE_MS = 2000;
export const UPLOAD_BACKOFF_START_MS = 5000;
export const UPLOAD_BACKOFF_MAX_MS = 300_000;
export const UPLOAD_SUFFIX = '.upload.json';

/** Where a recording workspace's logs go. */
export interface SessionLogUploadTarget {
  readonly url: string;
  readonly workspaceId: string;
}

interface UploadState {
  readonly version: 1;
  readonly url: string;
  readonly workspaceId: string;
  serverLogId?: string | undefined;
  /** Bytes of the `.log` the server holds. */
  sent: number;
  /** The server stopped keeping more of this log (its size limit). */
  truncated?: boolean;
}

export interface SessionLogUploaderDeps {
  readonly client: Pick<ServerClient, 'openSessionLog' | 'appendSessionLog' | 'endSessionLog'>;
  readonly accounts: TokenSource;
  readonly now: () => Date;
  readonly setTimeout: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly log?: (message: string) => void;
}

/** What the session-log store tells the uploader about one log. */
export interface SessionLogUpload {
  /** More text is on disk. */
  grew(): void;
  /** The log is finished; `meta` carries the end. */
  ended(meta: SessionLogMeta): void;
}

type Step = 'idle' | 'more' | 'done' | 'stop' | 'retry';

class Job {
  timer: unknown;
  running: Promise<void> | undefined;
  again = false;
  /** The back-off a failure armed; 0 while sends go through. */
  backoffMs = 0;
  finished = false;

  constructor(
    readonly dir: string,
    readonly id: string,
    public meta: SessionLogMeta,
    public state: UploadState,
  ) {}

  get stem(): string {
    return join(this.dir, this.id);
  }
}

export class SessionLogUploader {
  private readonly jobs = new Map<string, Job>();
  private disposed = false;

  constructor(private readonly deps: SessionLogUploaderDeps) {}

  /** Starts uploading a log that just opened; its folder and sidecar already exist. */
  async begin(dir: string, meta: SessionLogMeta, target: SessionLogUploadTarget): Promise<SessionLogUpload> {
    const state: UploadState = { version: 1, url: target.url, workspaceId: target.workspaceId, sent: 0 };
    const job = new Job(dir, meta.id, meta, state);
    this.jobs.set(job.stem, job);
    await this.save(job);
    this.schedule(job, 0);
    return {
      grew: () => {
        this.schedule(job, UPLOAD_DEBOUNCE_MS);
      },
      ended: (end) => {
        job.meta = end;
        this.schedule(job, 0);
      },
    };
  }

  /**
   * At start: carries on with every log an earlier run left half sent, under `root`
   * (`<workspace>/<host>/<id>.upload.json`). A log whose sidecar has no end was cut off by a crash, and
   * ends as `lost`.
   */
  async resume(root: string): Promise<void> {
    for (const workspace of await names(root)) {
      for (const host of await names(join(root, workspace))) {
        const dir = join(root, workspace, host);
        for (const name of await names(dir)) {
          if (!name.endsWith(UPLOAD_SUFFIX)) continue;
          const id = name.slice(0, -UPLOAD_SUFFIX.length);
          if (this.jobs.has(join(dir, id))) continue;
          try {
            const state = JSON.parse(await readFile(join(dir, name), 'utf8')) as UploadState;
            const meta = JSON.parse(await readFile(join(dir, `${id}.json`), 'utf8')) as SessionLogMeta;
            const ended: SessionLogMeta =
              meta.endedAt === undefined ? { ...meta, endedAt: this.deps.now().toISOString(), reason: 'lost' } : meta;
            const job = new Job(dir, id, ended, state);
            this.jobs.set(job.stem, job);
            this.schedule(job, 0);
          } catch (error) {
            this.deps.log?.(`[session-log] ${id}: cannot resume its upload (${(error as Error).message})`);
            await rm(join(dir, name), { force: true });
          }
        }
      }
    }
  }

  /** Resolves once no upload is running (tests). */
  async idle(): Promise<void> {
    const running = [...this.jobs.values()].flatMap((job) => (job.running === undefined ? [] : [job.running]));
    await Promise.all(running);
  }

  dispose(): void {
    this.disposed = true;
    for (const job of this.jobs.values()) this.deps.clearTimeout(job.timer);
  }

  private schedule(job: Job, ms: number): void {
    if (this.disposed || job.finished) return;
    if (job.running !== undefined) {
      job.again = true;
      return;
    }
    // A back-off already armed is not cut short by new output.
    if (job.timer !== undefined && job.backoffMs > 0) return;
    this.deps.clearTimeout(job.timer);
    job.timer = this.deps.setTimeout(() => {
      job.timer = undefined;
      this.run(job);
    }, ms);
  }

  private run(job: Job): void {
    if (this.disposed) return;
    job.running = this.drain(job)
      .catch((error: unknown) => {
        this.deps.log?.(`[session-log] ${job.id}: upload failed (${(error as Error).message})`);
      })
      .finally(() => {
        job.running = undefined;
        if (job.again) {
          job.again = false;
          this.schedule(job, 0);
        }
      });
  }

  private async drain(job: Job): Promise<void> {
    for (;;) {
      const step = await this.step(job);
      if (step === 'more') continue;
      if (step === 'idle') {
        job.backoffMs = 0;
        return;
      }
      if (step === 'retry') {
        job.backoffMs = Math.min(UPLOAD_BACKOFF_MAX_MS, Math.max(UPLOAD_BACKOFF_START_MS, job.backoffMs * 2));
        job.again = false;
        this.deps.clearTimeout(job.timer);
        job.timer = this.deps.setTimeout(() => {
          job.timer = undefined;
          this.run(job);
        }, job.backoffMs);
        return;
      }
      await this.finish(job);
      return;
    }
  }

  /** One round trip: open the server's log, send one chunk, or end it. */
  private async step(job: Job): Promise<Step> {
    const { state, meta } = job;
    try {
      return await withToken(this.deps, state.url, async (origin, token) => {
        if (state.serverLogId === undefined) {
          const opened = await this.deps.client.openSessionLog(origin, token, state.workspaceId, {
            clientLogId: meta.id,
            hostId: meta.hostId,
            hostName: meta.hostName,
            address: meta.address,
            port: meta.port,
            user: meta.user,
            startedAt: meta.startedAt,
          });
          state.serverLogId = opened.id;
          state.sent = opened.size;
          await this.save(job);
          return opened.ended ? 'done' : 'more';
        }
        const chunk = state.truncated === true ? new Uint8Array() : await readFrom(`${job.stem}.log`, state.sent);
        if (chunk.length > 0) {
          const answer = await this.deps.client.appendSessionLog(origin, token, state.workspaceId, state.serverLogId, {
            offset: state.sent,
            data: Buffer.from(chunk).toString('base64'),
          });
          state.sent = answer.size;
          if (answer.truncated) state.truncated = true;
          await this.save(job);
          return 'more';
        }
        if (meta.endedAt === undefined) return 'idle';
        await this.deps.client.endSessionLog(origin, token, state.workspaceId, state.serverLogId, {
          endedAt: meta.endedAt,
          ...(meta.exitCode !== undefined ? { exitCode: meta.exitCode } : {}),
          ...(meta.signal !== undefined ? { signal: meta.signal } : {}),
          reason: meta.reason ?? 'closed',
        });
        return 'done';
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.deps.log?.(`[session-log] ${job.id}: the log was removed before it was all sent`);
        return 'stop';
      }
      const code = isWirebenchError(error) ? error.code : undefined;
      const status = isWirebenchError(error) ? (error.details as { status?: unknown } | undefined)?.status : undefined;
      if (code === 'session-logs-offset') {
        // Reopening answers the size the server holds.
        state.serverLogId = undefined;
        return 'more';
      }
      if (code === 'session-logs-ended') return 'done';
      if (code === 'session-logs-recording-off' || status === 403 || status === 404) {
        this.deps.log?.(`[session-log] ${job.id}: the server no longer takes this log (${code ?? String(status)})`);
        return 'stop';
      }
      return 'retry';
    }
  }

  private async finish(job: Job): Promise<void> {
    job.finished = true;
    this.jobs.delete(job.stem);
    await rm(`${job.stem}${UPLOAD_SUFFIX}`, { force: true });
  }

  private async save(job: Job): Promise<void> {
    await writeFileAtomic(nodeFs, `${job.stem}${UPLOAD_SUFFIX}`, `${JSON.stringify(job.state)}\n`);
  }
}

/** Up to one chunk of `file` from `offset`; nothing when there is nothing past it. */
async function readFrom(file: string, offset: number): Promise<Uint8Array> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(SESSION_LOG_LIMITS.maxChunkBytes);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function names(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}
