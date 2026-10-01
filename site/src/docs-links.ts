/** Every docs page the landing site links to, as the slug of its page under docs-site/src/content/docs. */
export const DOCS_LINKS = {
  home: '',
  installation: 'getting-started/installation',
  secrets: 'guides/secrets',
  runInCi: 'guides/run-in-ci',
  snapshotRegression: 'guides/snapshot-regression',
  sharedWorkspaces: 'guides/shared-workspaces',
  agentsMcp: 'guides/agents-mcp',
  codeSigningPolicy: 'help/code-signing-policy',
  projectFormat: 'reference/project-format',
} as const;

/** The absolute path of a docs page under the Pages base. */
export function docsUrl(slug: string): string {
  return slug === '' ? '/wirebench/docs/' : `/wirebench/docs/${slug}/`;
}
