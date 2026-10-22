/**
 * The webhook collection on disk (spec §3): `webhooks/webhooks.yaml` and the request tree under
 * `webhooks/requests/`, laid out as an API's is. REST's project-level files: they are read and
 * written only while REST is on, and with it off they are left on disk as they are.
 */
import type { ProtocolProjectFiles } from '#core/protocol/module';
import { readFileIfExists } from '#core/project/fs';
import { unsupportedOf } from '#core/project/model';
import { authConfig, loadFolderContents, optional, readYaml } from '#core/project/load-helpers';
import { listApiTreeFiles, toAbsolute } from '#core/project/managed-files';
import { REQUESTS_DIR, WEBHOOKS_DIR, WEBHOOKS_FILE } from '#core/project/paths';
import { locateInTree } from '#core/project/request-tree';
import { parseFile } from '#core/project/schema-parts';
import { addFolderFiles, authDocument } from '#core/project/serialize-helpers';
import { compact, stringifyYaml } from '#core/project/yaml';
import type { RestRequestDef } from '../rest/model.js';
import { restRequestReader, signingDocument, signingOf, writeRestRequest } from '../rest/storage.js';
import type { WebhookFolder } from './model.js';
import { webhooksOf, withWebhooks } from './model.js';
import { webhookFolderFileSchema, webhooksFileSchema } from './schema.js';

const COLLECTION_FILE = `${WEBHOOKS_DIR}/${WEBHOOKS_FILE}`;
const TREE_DIR = `${WEBHOOKS_DIR}/${REQUESTS_DIR}`;

/** REST's project-level files: the webhook collection. */
export const webhookProjectFiles: ProtocolProjectFiles = {
  /**
   * Reads `webhooks/`; the project is returned as it is when there is no `webhooks.yaml`. With the
   * `webhooks` feature off (feature switches spec §2.1) the folder is left unread, and when it holds a
   * collection the project gets a placeholder for it instead, so a host can say the feature is off.
   * `managed` names nothing then, so a save never writes over or deletes the folder.
   */
  async load({ fs, root, problems, features }, project) {
    if (features?.isEnabled('webhooks') === false) {
      if ((await readFileIfExists(fs, toAbsolute(root, COLLECTION_FILE))) === undefined) return project;
      return {
        ...project,
        unsupported: [
          ...unsupportedOf(project),
          { dir: WEBHOOKS_DIR, slug: WEBHOOKS_DIR, kind: 'rest', reason: 'feature-disabled', name: 'Webhooks' },
        ],
      };
    }
    const document = await readYaml(fs, root, COLLECTION_FILE);
    if (document === undefined) return project;
    const parsed = parseFile(webhooksFileSchema, document, COLLECTION_FILE);
    const contents = await loadFolderContents(
      fs,
      root,
      TREE_DIR,
      0,
      problems,
      restRequestReader(fs, root, problems),
      (folderDocument, folderFile) => {
        if (folderDocument === undefined) return {};
        const folder = parseFile(webhookFolderFileSchema, folderDocument, folderFile);
        return {
          ...optional('target', folder.target),
          ...(folder.source !== undefined ? { source: { apiId: folder.source.apiId } } : {}),
          ...(folder.signing !== undefined ? { signing: signingOf(folder.signing) } : {}),
        };
      },
    );
    return withWebhooks(project, {
      target: parsed.target,
      ...(parsed.auth !== undefined ? { auth: authConfig(parsed.auth) } : {}),
      ...(parsed.signing !== undefined ? { signing: signingOf(parsed.signing) } : {}),
      folders: contents.folders as unknown as WebhookFolder[],
      requests: contents.requests,
    });
  },

  /** `webhooks/webhooks.yaml` and the request tree under it; nothing when the project has no collection. */
  files(project) {
    const files = new Map<string, string>();
    const webhooks = webhooksOf(project);
    if (webhooks === undefined) return files;
    files.set(
      COLLECTION_FILE,
      stringifyYaml(
        compact({
          target: webhooks.target,
          auth: webhooks.auth === undefined ? undefined : authDocument(webhooks.auth),
          signing: signingDocument(webhooks.signing),
        }),
      ),
    );
    addFolderFiles<RestRequestDef>(files, TREE_DIR, webhooks, 0, writeRestRequest, (folder) => {
      const hook = folder as Partial<WebhookFolder>;
      return {
        target: hook.target,
        source: hook.source === undefined ? undefined : { apiId: hook.source.apiId },
        signing: signingDocument(hook.signing),
      };
    });
    return files;
  },

  /**
   * The request tree is managed only beside its `webhooks.yaml`, as an API's is beside its `api.yaml`;
   * nothing with the `webhooks` feature off, when `load` read none of it.
   */
  async managed(fs, root, features) {
    if (features?.isEnabled('webhooks') === false) return [];
    if ((await readFileIfExists(fs, toAbsolute(root, COLLECTION_FILE))) === undefined) return [];
    return [COLLECTION_FILE, ...(await listApiTreeFiles(fs, root, TREE_DIR))];
  },

  requestLocation(project, requestId) {
    const webhooks = webhooksOf(project);
    return webhooks === undefined ? undefined : locateInTree(webhooks, TREE_DIR, requestId);
  },
};
