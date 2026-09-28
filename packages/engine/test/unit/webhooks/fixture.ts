import {
  createProject,
  createRestRequest,
  createWebhookCollection,
  createWebhookFolder,
  entry,
} from '../../../src/index.js';
import type { Project } from '../../../src/index.js';

export function hooksProject(): Project {
  return {
    ...createProject('Hooks', { id: 'p1' }),
    webhooks: createWebhookCollection({
      target: 'https://receiver.test/hooks',
      requests: [
        createRestRequest('Ping', {
          id: 'w1',
          slug: 'ping',
          method: 'POST',
          url: '/ping',
          headers: [entry('Authorization', 'Bearer abc123def456ghi789')],
        }),
      ],
      folders: [
        createWebhookFolder('Group', {
          id: 'g1',
          slug: 'group',
          target: 'https://other.test',
          requests: [createRestRequest('Inner', { id: 'w2', slug: 'inner', method: 'POST', url: '/inner' })],
        }),
      ],
    }),
  };
}
