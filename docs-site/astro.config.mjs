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
          label: 'Getting Started',
          items: [
            { label: 'Introduction', slug: 'getting-started' },
            { label: 'Installation', slug: 'getting-started/installation' },
            { label: 'Quickstart (5 min)', slug: 'getting-started/quickstart' },
          ],
        },
        {
          label: 'Core Guides',
          items: [
            { label: 'REST Client', slug: 'guides/rest-client' },
            { label: 'SOAP & WSDL', slug: 'guides/soap-wsdl' },
            { label: 'Environments & Properties', slug: 'guides/environments' },
            { label: 'Shared Workspaces', slug: 'guides/workspaces' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Keyboard Shortcuts', slug: 'reference/shortcuts' },
            { label: 'Project Format (v3)', slug: 'reference/project-format' },
          ],
        },
      ],
    }),
  ],
});
