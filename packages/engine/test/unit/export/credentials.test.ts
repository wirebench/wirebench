/**
 * Credentials typed as plain text (owner decision 2026-10-08): blanked by the importers' own rules,
 * each one reported where it was, in both formats.
 */
import { describe, expect, it } from 'vitest';
import { exportCollection } from '../../../src/export/index.js';
import type { CollectionExportFormat } from '../../../src/export/index.js';
import { createGrpcApi, createGrpcRequest } from '../../../src/grpc/model.js';
import type { Project } from '../../../src/project/model.js';
import { createProject } from '../../../src/project/model.js';
import { createApi, createRestRequest } from '../../../src/rest/model.js';
import { createWsApi, createWsRequest } from '../../../src/ws/model.js';
import { newId } from './fixture.js';

const SECRETS = [
  's3cr3t-header',
  'hunter2',
  'q-token-value',
  'url-key-value',
  'form-pass',
  'part-secret',
  'prop-secret',
  'env-pass',
  'meta-secret',
  'ws-secret',
  'oauth-cs',
];

function project(): Project {
  const request = createRestRequest('Get', {
    newId,
    method: 'POST',
    url: 'https://user:hunter2@api.example.com/x?api_key=url-key-value&page=2',
    headers: [
      { name: 'Authorization', value: 'Bearer s3cr3t-header', enabled: true },
      { name: 'X-Api-Key', value: '${apiKey}', enabled: true },
      { name: 'Accept', value: 'application/json', enabled: true },
    ],
    query: [{ name: 'access_token', value: 'q-token-value', enabled: true }],
    body: { kind: 'form', fields: [{ name: 'password', value: 'form-pass', enabled: true }] },
    auth: {
      type: 'oauth2',
      grant: 'client-credentials',
      tokenUrl: 'https://id.example.com/token?client_secret=oauth-cs',
      clientId: 'c',
      scopes: [],
      clientAuth: 'basic',
      pkce: false,
    },
  });
  const upload = createRestRequest('Upload', {
    newId,
    method: 'POST',
    url: 'https://api.example.com/u',
    body: { kind: 'multipart', parts: [{ kind: 'text', name: 'client_secret', value: 'part-secret', enabled: true }] },
  });
  const grpc = createGrpcApi('G', {
    newId,
    target: 'localhost:50051',
    requests: [
      createGrpcRequest('Call', {
        newId,
        service: 's.S',
        method: 'M',
        metadata: [{ name: 'x-auth-token', value: 'meta-secret', enabled: true }],
      }),
    ],
  });
  const ws = createWsApi('W', {
    newId,
    url: 'wss://ws.example.com',
    requests: [
      createWsRequest('Chat', { newId, headers: [{ name: 'Cookie', value: 'sid=ws-secret', enabled: true }] }),
    ],
  });
  return {
    ...createProject('P', { newId }),
    properties: { api_token: 'prop-secret', host: 'api.example.com', authRef: '${token}' },
    containers: { rest: [createApi('A', { newId, requests: [request, upload] })], grpc: [grpc], websocket: [ws] },

    environments: [
      {
        id: 'e',
        name: 'Dev',
        slug: 'dev',
        order: 0,
        endpoints: {},
        properties: { password: 'env-pass' },
        disabledProperties: [],
      },
    ],
  };
}

describe.each<CollectionExportFormat>(['postman', 'opencollection'])(
  'plain-text credentials in a %s export',
  (format) => {
    const result = exportCollection(format, { project: project(), target: { kind: 'project' } });
    const text = result.files.map((f) => f.text).join('\n');

    it('writes none of them', () => {
      for (const secret of SECRETS) {
        if (format === 'postman' && (secret === 'meta-secret' || secret === 'ws-secret')) continue; // left out with their APIs
        expect(text).not.toContain(secret);
      }
    });

    it('keeps references, ordinary values and the request itself', () => {
      expect(text).toContain('{{apiKey}}');
      expect(text).toContain('application/json');
      expect(text).toMatch(format === 'postman' ? /page=2/ : /name: page\n\s+value: "2"/);
      expect(text).toContain('https://api.example.com/x');
      expect(text).toContain('{{token}}');
    });

    it('reports each blanked value where it was', () => {
      const warnings = result.report.warnings;
      expect(warnings).toContain(
        'A / Get: the user name and password in the URL were not exported; set them in the target tool.',
      );
      expect(warnings).toContain(
        'A / Get: the plain-text value of api_key was not exported; set it in the target tool.',
      );
      expect(warnings).toContain(
        'A / Get: the plain-text value of client_secret was not exported; set it in the target tool.',
      );
      expect(warnings).toContain(
        'A / Get: the plain-text value of access_token was not exported; set it in the target tool.',
      );
      expect(warnings).toContain(
        'A / Get: the plain-text value of Authorization was not exported; set it in the target tool.',
      );
      expect(warnings).toContain(
        'A / Get: the plain-text value of password was not exported; set it in the target tool.',
      );
      expect(warnings).toContain(
        'A / Upload: the plain-text value of client_secret was not exported; set it in the target tool.',
      );
      expect(warnings).toContain(
        'Project properties: the plain-text value of api_token was not exported; it is written as a secret variable with no value.',
      );
      expect(warnings).toContain(
        'Dev: the plain-text value of password was not exported; it is written as a secret variable with no value.',
      );
      expect(warnings).toContain(
        'G / Call: the plain-text value of x-auth-token was not exported; set it in the target tool.',
      );
      expect(warnings).toContain(
        'W / Chat: the plain-text value of Cookie was not exported; set it in the target tool.',
      );
    });
  },
);
