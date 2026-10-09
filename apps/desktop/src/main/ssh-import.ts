import { randomUUID } from 'node:crypto';
import { glob, readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { WirebenchError } from '@wirebench/engine';
import {
  EMPTY_HOSTS_FILE,
  applySshConfigImport,
  displayPath,
  loadSshConfig,
  planSshConfigImport,
  type SshConfigImportPlan,
  type SshConfigIo,
  type SshKeyChoice,
} from '@wirebench/ssh';
import type {
  SshImportApplyRequest,
  SshImportApplyResponse,
  SshImportPreviewRequest,
  SshImportPreviewResponse,
} from '../shared/ssh-wire.js';
import { asWirebenchError, type HostsService } from './hosts-service.js';
import type { SshSecretsService } from './ssh-secrets.js';

/** The calls that read the user's disk; real by default, faked in tests. */
export interface SshImportFs {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ isFile(): boolean; size: number }>;
  readFile(path: string): Promise<string>;
  glob(pattern: string): Promise<readonly string[]>;
}

const nodeImportFs: SshImportFs = {
  realpath: (path) => realpath(path),
  stat: (path) => stat(path),
  readFile: (path) => readFile(path, 'utf8'),
  glob: async (pattern) => {
    const out: string[] = [];
    for await (const entry of glob(pattern)) out.push(entry);
    return out;
  },
};

/** `S` is the caller's handle: a `WebContents` in the app, any object with an `id` in tests. */
export interface SshImportDeps<S extends { readonly id: number }> {
  readonly home: () => string;
  /** The native open-file picker; records the pick. `undefined` when cancelled. */
  readonly pick: (sender: S) => Promise<string | undefined>;
  /** The calling window's hosts file. */
  readonly hosts: Pick<HostsService, 'invalidate' | 'list' | 'current' | 'replace'>;
  /** The calling window's workspace-scoped secrets. */
  readonly secrets: Pick<SshSecretsService, 'names' | 'set'>;
  readonly fs?: SshImportFs;
  readonly now?: () => number;
}

export const CONFIG_MAX_BYTES = 1024 * 1024;
export const KEY_MAX_BYTES = 64 * 1024;
const PREVIEW_TTL_MS = 10 * 60 * 1000;

const errnoOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown error';
};

/** A refusal shaped like a Node error, so the loader reports it with its `code`. */
const refusal = (code: string): Error => Object.assign(new Error(code), { code });

/** The text of a regular file no bigger than `max`, read through `realpath` (a symlink is followed once). */
async function readRegular(fs: SshImportFs, path: string, max: number): Promise<string> {
  const target = await fs.realpath(path);
  const info = await fs.stat(target);
  if (!info.isFile()) throw refusal('ENOTFILE');
  if (info.size > max) throw refusal('EFBIG');
  return fs.readFile(target);
}

const PRIVATE_KEY = /^-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY-----/;

/** Whether a private key is encrypted: a PEM header, a PKCS#8 wrapper, or an OpenSSH key whose cipher is not `none`. */
export function isEncryptedKey(text: string): boolean {
  if (/^-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(text) || /^Proc-Type: 4,ENCRYPTED/m.test(text)) return true;
  if (!text.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----')) return false;
  const body = text.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bytes = Buffer.from(body, 'base64');
  // The format starts with `openssh-key-v1` and a zero byte, then the cipher name as a length-prefixed string.
  const magic = Buffer.concat([Buffer.from('openssh-key-v1', 'latin1'), Buffer.from([0])]);
  if (bytes.length < magic.length + 4 || !bytes.subarray(0, magic.length).equals(magic)) return false;
  const length = bytes.readUInt32BE(magic.length);
  const cipher = bytes.subarray(magic.length + 4, magic.length + 4 + length).toString('latin1');
  return cipher !== 'none';
}

interface Preview {
  readonly id: string;
  readonly plan: SshConfigImportPlan;
  readonly at: number;
}

/**
 * Imports hosts from an OpenSSH client config (spec 2026-10-09). A preview reads the config and plans, per
 * window; an apply reads only the key files the user chose to store, stores them as workspace secrets and
 * writes `hosts.yaml`. Paths and key text stay in main; nothing here quotes a config line or a key.
 */
export class SshImportService<S extends { readonly id: number } = { readonly id: number }> {
  private readonly previews = new Map<number, Preview>();
  private readonly fs: SshImportFs;
  private readonly now: () => number;

  constructor(private readonly deps: SshImportDeps<S>) {
    this.fs = deps.fs ?? nodeImportFs;
    this.now = deps.now ?? Date.now;
  }

  async preview(sender: S, request: SshImportPreviewRequest): Promise<SshImportPreviewResponse> {
    const home = this.deps.home();
    const path = request.source === 'user-config' ? join(home, '.ssh', 'config') : await this.deps.pick(sender);
    if (path === undefined) return { cancelled: true };
    const shown = displayPath(path, home);

    const io: SshConfigIo = {
      home,
      readFile: (file) => readRegular(this.fs, file, CONFIG_MAX_BYTES),
      glob: (pattern) => this.fs.glob(pattern),
    };
    let document;
    try {
      document = await loadSshConfig(path, io);
    } catch (error) {
      const errno = errnoOf(error);
      throw new WirebenchError('ssh-config-unreadable', `${shown} could not be read (${errno})`, {
        details: { file: shown, errno },
      });
    }

    const existing = await this.currentHosts();
    const names = (await this.deps.secrets.names()).map((n) => n.name);
    let plan: SshConfigImportPlan;
    try {
      plan = planSshConfigImport({ document, existing, existingSecretNames: names });
    } catch (error) {
      throw asWirebenchError(error);
    }
    this.prune();
    const id = randomUUID();
    this.previews.set(sender.id, { id, plan, at: this.now() });
    return {
      previewId: id,
      source: shown,
      group: plan.group,
      hosts: [...plan.hosts],
      keys: plan.keys.map(({ ref, display, hosts, proposedSecret }) => ({
        ref,
        display,
        hosts: [...hosts],
        proposedSecret,
      })),
      report: {
        problems: [...plan.report.problems],
        skipped: [...plan.report.skipped],
        ignored: [...plan.report.ignored],
        notes: [...plan.report.notes],
      },
    };
  }

  async apply(sender: S, request: SshImportApplyRequest): Promise<SshImportApplyResponse> {
    this.prune();
    const preview = this.previews.get(sender.id);
    if (preview?.id !== request.previewId) {
      throw new WirebenchError('ssh-import-expired', 'This import preview has expired; preview the file again');
    }
    const { plan } = preview;
    const existing = await this.currentHosts();

    // Read every key the user chose to store before anything is written; an agent or existing row is never read.
    const keys: Record<string, SshKeyChoice> = {};
    const texts = new Map<string, string>(); // secret name → key text
    const encrypted: string[] = [];
    for (const { ref, choice } of request.keys) {
      keys[ref] = choice;
      if (choice.kind !== 'store') continue;
      const row = plan.keys.find((k) => k.ref === ref);
      if (!row) continue; // applySshConfigImport refuses an unknown ref below
      let text: string;
      try {
        text = await readRegular(this.fs, row.path, KEY_MAX_BYTES);
      } catch (error) {
        throw new WirebenchError('ssh-key-unreadable', `${row.display} could not be read (${errnoOf(error)})`, {
          details: { file: row.display },
        });
      }
      if (!PRIVATE_KEY.test(text)) {
        throw new WirebenchError('ssh-key-unreadable', `${row.display} is not a private key`, {
          details: { file: row.display },
        });
      }
      if (isEncryptedKey(text)) encrypted.push(ref);
      texts.set(choice.secret, text);
    }

    let merged;
    try {
      merged = applySshConfigImport(
        plan,
        { groupName: request.groupName, importDuplicates: request.importDuplicates, keys, encrypted },
        existing,
      );
    } catch (error) {
      throw asWirebenchError(error);
    }

    // Keys first: a written host never names a secret that failed to store.
    const stored: string[] = [];
    for (const [name, text] of texts) {
      try {
        await this.deps.secrets.set(name, text);
      } catch (error) {
        throw new WirebenchError(
          'ssh-key-unreadable',
          `The key for ${name} could not be stored; nothing was imported`,
          {
            details: { stored, ...(error instanceof WirebenchError ? { cause: error.code } : {}) },
          },
        );
      }
      stored.push(name);
    }
    texts.clear();
    const listed = await this.deps.hosts.replace(merged);
    this.previews.delete(sender.id);
    return { ...listed, groupId: plan.group.id, stored };
  }

  /** `hosts.yaml` as it is on disk now; an import never writes over a file that does not parse. */
  private async currentHosts() {
    this.deps.hosts.invalidate();
    const listed = await this.deps.hosts.list();
    if (listed.problems.length > 0) {
      throw new WirebenchError('ssh-hosts-invalid', 'hosts.yaml has problems; fix them before importing', {
        details: { problems: listed.problems.length },
      });
    }
    return this.deps.hosts.current() ?? EMPTY_HOSTS_FILE;
  }

  private prune(): void {
    const now = this.now();
    for (const [sender, preview] of this.previews) {
      if (now - preview.at > PREVIEW_TTL_MS) this.previews.delete(sender);
    }
  }
}
