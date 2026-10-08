import { defineConfig, passthroughImageService } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLinksValidator from 'starlight-links-validator';

export default defineConfig({
  site: 'https://wirebench.github.io',
  base: '/wirebench/docs',
  image: {
    service: passthroughImageService(),
  },
  integrations: [
    starlight({
      plugins: [starlightLinksValidator()],
      title: 'Wirebench',
      description: 'The native, clean-room desktop API client for SOAP and REST services.',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/wirebench/wirebench',
        },
      ],
      customCss: ['./src/styles/custom.css'],
      sidebar: [
        {
          label: 'Getting started',
          items: [
            { label: 'Introduction', slug: 'getting-started' },
            { label: 'Install and first run', slug: 'getting-started/installation' },
            { label: 'Ten-minute walkthrough', slug: 'getting-started/walkthrough' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Workspaces and projects', slug: 'guides/workspaces' },
            { label: 'SOAP and WSDL', slug: 'guides/soap-wsdl' },
            { label: 'WS-Trust tokens', slug: 'guides/ws-trust' },
            { label: 'REST', slug: 'guides/rest-client' },
            { label: 'gRPC', slug: 'guides/grpc' },
            { label: 'WebSocket', slug: 'guides/websocket' },
            { label: 'AsyncAPI contracts', slug: 'guides/asyncapi' },
            { label: 'Importing APIs', slug: 'guides/importers' },
            { label: 'Exporting collections', slug: 'guides/exporters' },
            { label: 'Environments and properties', slug: 'guides/environments' },
            { label: 'Authentication', slug: 'guides/auth' },
            { label: 'Secrets', slug: 'guides/secrets' },
            { label: 'HTTP Log', slug: 'guides/http-log' },
            { label: 'History', slug: 'guides/history' },
            { label: 'Copy as a command', slug: 'guides/copy-as-command' },
            { label: 'Assertions', slug: 'guides/assertions' },
            { label: 'Sequences', slug: 'guides/sequences' },
            { label: 'Scripts', slug: 'guides/scripts' },
            { label: 'Snapshot regression', slug: 'guides/snapshot-regression' },
            { label: 'Shared workspaces', slug: 'guides/shared-workspaces' },
            { label: 'Wirebench Server', slug: 'guides/wirebench-server' },
            { label: 'Editions and licenses', slug: 'guides/server-licensing' },
            { label: 'Audit log', slug: 'guides/server-audit-log' },
            { label: 'Webhook inbox', slug: 'guides/webhooks' },
            { label: 'Sending webhooks', slug: 'guides/sending-webhooks' },
            { label: 'Webhook signatures', slug: 'guides/webhook-signatures' },
            { label: 'Callback assertions', slug: 'guides/callback-assertions' },
            { label: 'Preferences and layout', slug: 'guides/preferences' },
            { label: 'Managed preferences', slug: 'guides/managed-preferences' },
            { label: 'Run in CI', slug: 'guides/run-in-ci' },
            { label: 'Agents (MCP)', slug: 'guides/agents-mcp' },
          ],
        },
        {
          label: 'Switching',
          items: [
            { label: 'From Postman collections', slug: 'switching/postman' },
            { label: 'From a legacy SOAP project', slug: 'switching/legacy-soap-project' },
            { label: 'From OpenAPI and Swagger', slug: 'switching/openapi' },
            { label: 'From cURL commands', slug: 'switching/curl' },
            { label: 'From .http files', slug: 'switching/http-files' },
            { label: 'From OpenCollection', slug: 'switching/opencollection' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Commands and shortcuts', slug: 'reference/commands' },
            { label: 'Property expansion syntax', slug: 'reference/property-syntax' },
            { label: 'Project folder format', slug: 'reference/project-format' },
            { label: 'Script API', slug: 'reference/script-api' },
            { label: 'WS-I assertions', slug: 'reference/ws-i' },
          ],
        },
        {
          label: 'Help',
          items: [
            { label: 'Troubleshooting', slug: 'help/troubleshooting' },
            { label: 'FAQ', slug: 'help/faq' },
            { label: 'Code-signing policy', slug: 'help/code-signing-policy' },
          ],
        },
      ],
    }),
  ],
});
