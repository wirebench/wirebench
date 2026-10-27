/**
 * The buffer `WorkspaceService` puts outside-edit notifications into while sync must not be
 * interleaved with reloads: during a sync operation (a merge rewrites files under the watchers)
 * and for as long as the workspace is in a merge `conflict`. Both watchers keep running — only
 * delivery is held — and the buffered paths are replayed once holding ends.
 *
 * Pure: no timers, no I/O. Paths are unioned per key (the workspace, or one project id), in
 * first-seen order.
 */

/** What was buffered while holding, handed back once holding ends. */
export interface HeldBatch {
  /** Tree-relative workspace-level paths (`workspace.yaml`, `environments/<name>.yaml`). */
  readonly workspacePaths: readonly string[];
  /** Project id → paths relative to that project's folder. */
  readonly projects: ReadonlyMap<string, readonly string[]>;
}

export class HeldChanges {
  private holding = false;
  private readonly workspace = new Set<string>();
  private readonly projects = new Map<string, Set<string>>();

  /** Buffers workspace-level `paths` when holding. Returns whether they were held (the caller must then not deliver them). */
  offerWorkspace(paths: readonly string[]): boolean {
    if (!this.holding) {
      return false;
    }
    for (const path of paths) {
      this.workspace.add(path);
    }
    return true;
  }

  /** Buffers one project's `paths` when holding. Returns whether they were held. */
  offerProject(projectId: string, paths: readonly string[]): boolean {
    if (!this.holding) {
      return false;
    }
    let set = this.projects.get(projectId);
    if (set === undefined) {
      set = new Set();
      this.projects.set(projectId, set);
    }
    for (const path of paths) {
      set.add(path);
    }
    return true;
  }

  /** Drops buffered paths that a pull has just applied itself, so they are not replayed a second time. */
  forget(workspacePaths: readonly string[], projects: ReadonlyMap<string, readonly string[]>): void {
    for (const path of workspacePaths) {
      this.workspace.delete(path);
    }
    for (const [projectId, paths] of projects) {
      const set = this.projects.get(projectId);
      if (set === undefined) {
        continue;
      }
      for (const path of paths) {
        set.delete(path);
      }
      if (set.size === 0) {
        this.projects.delete(projectId);
      }
    }
  }

  /**
   * Starts or stops holding. Stopping returns everything buffered (and empties the buffer), or
   * `undefined` when nothing was — as does any call that does not end a hold.
   */
  setHolding(holding: boolean): HeldBatch | undefined {
    const wasHolding = this.holding;
    this.holding = holding;
    if (holding || !wasHolding || (this.workspace.size === 0 && this.projects.size === 0)) {
      return undefined;
    }
    const batch: HeldBatch = {
      workspacePaths: [...this.workspace],
      projects: new Map([...this.projects].map(([projectId, set]) => [projectId, [...set]] as const)),
    };
    this.workspace.clear();
    this.projects.clear();
    return batch;
  }

  /** Stops holding and discards everything buffered (the workspace is closing). */
  clear(): void {
    this.holding = false;
    this.workspace.clear();
    this.projects.clear();
  }
}
