import { randomUUID } from 'node:crypto';
import { WirebenchError } from '@wirebench/engine';
import {
  EMPTY_HOSTS_FILE,
  applyKnownHostsFileImport,
  displayPath,
  listResolvedHosts,
  pathsFor,
  planKnownHostsFileImport,
  type KnownHostsFilePlan,
} from '@wirebench/ssh';
import type {
  SshKnownHostsImportApplyRequest,
  SshKnownHostsImportApplyResponse,
  SshKnownHostsImportPreviewRequest,
  SshKnownHostsImportPreviewResponse,
} from '../shared/ssh-wire.js';
import { asWirebenchError, type HostsService } from './hosts-service.js';
import { errnoOf, nodeImportFs, readRegular, type SshImportFs } from './ssh-import.js';
import type { SshService } from './ssh-service.js';

/** `S` is the caller's handle: a `WebContents` in the app, any object with an `id` in tests. */
export interface KnownHostsImportDeps<S extends { readonly id: number }> {
  readonly home: () => string;
  /** The native open-file picker; records the pick. `undefined` when cancelled. */
  readonly pick: (sender: S) => Promise<string | undefined>;
  /** The calling window's hosts file: the hosts that may gain a key. */
  readonly hosts: Pick<HostsService, 'invalidate' | 'list' | 'current'>;
  /** The machine's trusted host keys. */
  readonly store: Pick<SshService, 'knownHosts' | 'changeKnownHosts'>;
  readonly fs?: SshImportFs;
  readonly now?: () => number;
}

/** A known_hosts file this big is not one a person keeps; reading it whole is the cap. */
export const KNOWN_HOSTS_MAX_BYTES = 8 * 1024 * 1024;
const PREVIEW_TTL_MS = 10 * 60 * 1000;

interface Preview {
  readonly id: string;
  readonly plan: KnownHostsFilePlan;
  readonly at: number;
}

/**
 * Imports trusted host keys from an OpenSSH known_hosts file (#418). A preview reads the file and matches its
 * lines against the window's hosts.yaml; an apply writes the trusted-keys store again from what it holds then,
 * adding new keys and replacing only the conflicts the user chose. The file's path stays in main.
 */
export class KnownHostsImportService<S extends { readonly id: number } = { readonly id: number }> {
  private readonly previews = new Map<number, Preview>();
  private readonly fs: SshImportFs;
  private readonly now: () => number;

  constructor(private readonly deps: KnownHostsImportDeps<S>) {
    this.fs = deps.fs ?? nodeImportFs;
    this.now = deps.now ?? Date.now;
  }

  async preview(sender: S, request: SshKnownHostsImportPreviewRequest): Promise<SshKnownHostsImportPreviewResponse> {
    const home = this.deps.home();
    const path =
      request.source === 'user-known-hosts'
        ? pathsFor(home).join(home, '.ssh', 'known_hosts')
        : await this.deps.pick(sender);
    if (path === undefined) return { cancelled: true };
    const shown = displayPath(path, home);

    let text: string;
    try {
      text = await readRegular(this.fs, path, KNOWN_HOSTS_MAX_BYTES);
    } catch (error) {
      const errno = errnoOf(error);
      throw new WirebenchError('ssh-known-hosts-unreadable', `${shown} could not be read (${errno})`, {
        details: { file: shown, errno },
      });
    }

    let plan: KnownHostsFilePlan;
    try {
      const targets = listResolvedHosts(await this.currentHosts()).map((host) => ({
        address: host.address,
        port: host.ssh.port.value,
        names: [host.name],
      }));
      plan = planKnownHostsFileImport({ text, targets, trusted: await this.deps.store.knownHosts() });
    } catch (error) {
      throw asWirebenchError(error);
    }
    this.prune();
    const id = randomUUID();
    this.previews.set(sender.id, { id, plan, at: this.now() });
    const row = ({ host, keyType, fingerprint, names, line }: KnownHostsFilePlan['add'][number]) => ({
      host,
      keyType,
      fingerprint,
      names: [...names],
      line,
    });
    return {
      previewId: id,
      source: shown,
      add: plan.add.map(row),
      conflicts: plan.conflicts.map((c) => ({ ...row(c), previous: c.previous })),
      trusted: plan.trusted.map(row),
      skipped: plan.skipped.map(({ line, reason }) => ({ line, reason })),
    };
  }

  async apply(sender: S, request: SshKnownHostsImportApplyRequest): Promise<SshKnownHostsImportApplyResponse> {
    this.prune();
    const preview = this.previews.get(sender.id);
    if (preview?.id !== request.previewId) {
      throw new WirebenchError('ssh-import-expired', 'This import preview has expired; preview the file again');
    }
    this.previews.delete(sender.id);
    const { plan } = preview;
    // Only a conflict the preview showed can be replaced: a key trusted since then was never confirmed over.
    const replace = request.replace.filter((r) =>
      plan.conflicts.some((c) => c.host === r.host && c.keyType === r.keyType),
    );
    const { added, replaced, kept } = await this.deps.store.changeKnownHosts((current) =>
      applyKnownHostsFileImport(plan, replace, current),
    );
    return { added, replaced, kept };
  }

  /** `hosts.yaml` as it is on disk now; a file with problems names no hosts to match. */
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
