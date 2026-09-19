import { defineConfig, passthroughImageService } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLinksValidator from 'starlight-links-validator';

export default defineConfig({
  site: 'https://wirebench.github.io',
  base: '/wirebench',
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
            { label: 'REST', slug: 'guides/rest-client' },
            { label: 'gRPC', slug: 'guides/grpc' },
            { label: 'Importing APIs', slug: 'guides/importers' },
            { label: 'Environments and properties', slug: 'guides/environments' },
            { label: 'Authentication', slug: 'guides/auth' },
            { label: 'Secrets', slug: 'guides/secrets' },
            { label: 'HTTP Log', slug: 'guides/http-log' },
            { label: 'History', slug: 'guides/history' },
            { label: 'Shared workspaces', slug: 'guides/shared-workspaces' },
            { label: 'Preferences and layout', slug: 'guides/preferences' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Commands and shortcuts', slug: 'reference/commands' },
            { label: 'Property expansion syntax', slug: 'reference/property-syntax' },
            { label: 'Project folder format', slug: 'reference/project-format' },
            { label: 'WS-I assertions', slug: 'reference/ws-i' },
          ],
        },
        {
          label: 'Help',
          items: [
            { label: 'Troubleshooting', slug: 'help/troubleshooting' },
            { label: 'FAQ', slug: 'help/faq' },
          ],
        },
      ],
    }),
  ],
});
