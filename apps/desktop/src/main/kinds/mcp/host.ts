/**
 * MCP's share of an open project's host (spec §5.3; #79): the one write that does not go through a
 * change, a catalogue refresh's, reached as `ProjectHost.kind('mcp')`.
 */

import type { McpCatalogue, McpCatalogueInfo } from '@wirebench/engine';
import type { ProjectWire } from '@wirebench/wire/wire-types';
import type { ProjectHostCore } from '../../project-host-core.js';
import { replaceMcpServer, requireMcpServer } from './mutations.js';

export class McpHost {
  constructor(private readonly core: ProjectHostCore) {}

  /**
   * Keeps what a refresh fetched: the lists in `catalogue.json` beside the server's `api.yaml`, and
   * where they came from in `api.yaml` itself. Saves at once, as an import does, so a refresh that
   * found nothing new writes the same bytes and the diff shows only real drift.
   *
   * @throws ProjectError `project-entity-not-found` when the server is gone
   */
  async setMcpCatalogue(
    apiId: string,
    refreshed: { readonly catalogue: McpCatalogue; readonly info: McpCatalogueInfo },
  ): Promise<ProjectWire> {
    const open = this.core.require();
    const server = requireMcpServer(open.project, apiId);
    open.project = replaceMcpServer(open.project, {
      ...server,
      catalogue: refreshed.catalogue,
      catalogueInfo: refreshed.info,
    });
    open.dirty = true;
    await this.core.save({ reason: 'refresh-catalogue' });
    return this.core.snapshot() as ProjectWire;
  }
}
