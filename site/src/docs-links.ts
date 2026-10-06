/** Every docs page the landing site links to, as the slug of its page under docs-site/src/content/docs. */
export const DOCS_LINKS = {
  home: '',
  installation: 'getting-started/installation',
  soapWsdl: 'guides/soap-wsdl',
  wsTrust: 'guides/ws-trust',
  restClient: 'guides/rest-client',
  grpc: 'guides/grpc',
  websocket: 'guides/websocket',
  asyncapi: 'guides/asyncapi',
  importers: 'guides/importers',
  switchingPostman: 'switching/postman',
  environments: 'guides/environments',
  auth: 'guides/auth',
  httpLog: 'guides/http-log',
  history: 'guides/history',
  copyAsCommand: 'guides/copy-as-command',
  assertions: 'guides/assertions',
  sequences: 'guides/sequences',
  scripts: 'guides/scripts',
  scriptApi: 'reference/script-api',
  webhooks: 'guides/webhooks',
  sendingWebhooks: 'guides/sending-webhooks',
  webhookSignatures: 'guides/webhook-signatures',
  callbackAssertions: 'guides/callback-assertions',
  secrets: 'guides/secrets',
  runInCi: 'guides/run-in-ci',
  snapshotRegression: 'guides/snapshot-regression',
  sharedWorkspaces: 'guides/shared-workspaces',
  wirebenchServer: 'guides/wirebench-server',
  serverLicensing: 'guides/server-licensing',
  serverAuditLog: 'guides/server-audit-log',
  agentsMcp: 'guides/agents-mcp',
  codeSigningPolicy: 'help/code-signing-policy',
  projectFormat: 'reference/project-format',
} as const;

/** The absolute path of a docs page under the Pages base. */
export function docsUrl(slug: string): string {
  return slug === '' ? '/wirebench/docs/' : `/wirebench/docs/${slug}/`;
}
