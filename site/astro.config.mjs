import { defineConfig, passthroughImageService } from 'astro/config';

export default defineConfig({
  site: 'https://wirebench.github.io',
  base: '/wirebench',
  trailingSlash: 'always',
  image: { service: passthroughImageService() },
});
