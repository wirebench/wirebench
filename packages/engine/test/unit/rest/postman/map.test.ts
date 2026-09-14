import { describe, expect, it } from 'vitest';
import { apiFromPostmanCollection } from '../../../../src/rest/postman/map.js';
import type { PostmanCollection } from '../../../../src/rest/postman/model.js';

describe('Postman entity mapping (map.ts)', () => {
  it('maps recursive folders, requests, and calculates summary', () => {
    const collection: PostmanCollection = {
      info: {
        name: 'My API',
        description: 'Test API description',
      },
      variable: [
        {
          key: 'baseUrl',
          value: 'https://api.example.com',
        },
      ],
      auth: {
        type: 'bearer',
      },
      item: [
        {
          name: 'Folder A',
          auth: {
            type: 'apikey',
            apikey: [
              { key: 'key', value: 'X-Key' },
              { key: 'in', value: 'header' },
            ],
          },
          item: [
            {
              name: 'Request In Folder A',
              request: {
                method: 'POST',
                url: {
                  raw: 'https://api.example.com/users/{id}',
                  variable: [{ key: 'id', value: '123', description: 'User ID' }],
                  query: [{ key: 'active', value: 'true', disabled: false }],
                },
                header: [{ key: 'Content-Type', value: 'application/json' }],
                body: {
                  mode: 'raw',
                  raw: '{"hello": "world"}',
                  options: { raw: { language: 'json' } },
                },
              },
            },
          ],
        },
        {
          name: 'Root Request',
          request: {
            method: 'GET',
            url: {
              raw: 'https://api.example.com/health',
            },
            auth: {
              type: 'noauth',
            },
          },
        },
      ],
    };

    const deterministicId = () => 'fixed_id';
    const { api, summary } = apiFromPostmanCollection(collection, {
      newId: deterministicId,
    });

    expect(api.name).toBe('My API');
    expect(api.baseUrl).toBe('https://api.example.com');
    expect(api.servers).toHaveLength(1);
    expect(api.servers[0]?.url).toBe('https://api.example.com');
    expect(api.auth).toEqual({ type: 'bearer' });

    // Summary
    expect(summary.name).toBe('My API');
    expect(summary.folders).toBe(1);
    expect(summary.requests).toBe(2);
    expect(summary.auth).toBe('bearer');

    // Folders
    expect(api.folders).toHaveLength(1);
    const folderA = api.folders[0]!;
    expect(folderA.name).toBe('Folder A');
    expect(folderA.auth).toEqual({ type: 'api-key', name: 'X-Key', in: 'header' });
    expect(folderA.requests).toHaveLength(1);

    // Request in folder A
    const reqA = folderA.requests[0]!;
    expect(reqA.name).toBe('Request In Folder A');
    expect(reqA.method).toBe('POST');
    expect(reqA.url).toBe('/users/{id}');
    expect(reqA.pathParams).toHaveLength(1);
    expect(reqA.pathParams[0]).toEqual({
      name: 'id',
      value: '123',
      enabled: true,
      description: 'User ID',
    });
    expect(reqA.query).toHaveLength(1);
    expect(reqA.query[0]).toEqual({
      name: 'active',
      value: 'true',
      enabled: true,
    });
    expect(reqA.body).toEqual({
      kind: 'raw',
      language: 'json',
      text: '{"hello": "world"}',
    });
    expect(reqA.auth).toEqual({ type: 'inherit' });

    // Root request
    expect(api.requests).toHaveLength(1);
    const rootReq = api.requests[0]!;
    expect(rootReq.name).toBe('Root Request');
    expect(rootReq.method).toBe('GET');
    expect(rootReq.url).toBe('/health');
    expect(rootReq.auth).toEqual({ type: 'none' });
  });

  it('maps form and multipart bodies correctly', () => {
    const collection: PostmanCollection = {
      info: { name: 'Form API' },
      item: [
        {
          name: 'UrlEncoded Form',
          request: {
            method: 'POST',
            url: { raw: 'https://example.com/form' },
            body: {
              mode: 'urlencoded',
              urlencoded: [
                { key: 'user', value: 'alice', description: 'Username' },
                { key: 'role', value: 'admin', disabled: true },
              ],
            },
          },
        },
        {
          name: 'Multipart Form',
          request: {
            method: 'POST',
            url: { raw: 'https://example.com/upload' },
            body: {
              mode: 'formdata',
              formdata: [
                { key: 'title', value: 'My Doc', type: 'text' },
                { key: 'file', type: 'file', src: 'doc.pdf', contentType: 'application/pdf' },
              ],
            },
          },
        },
      ],
    };

    const { api } = apiFromPostmanCollection(collection);
    const req1 = api.requests[0]!;
    expect(req1.body).toEqual({
      kind: 'form',
      fields: [
        { name: 'user', value: 'alice', enabled: true, description: 'Username' },
        { name: 'role', value: 'admin', enabled: false },
      ],
    });

    const req2 = api.requests[1]!;
    expect(req2.body).toEqual({
      kind: 'multipart',
      parts: [
        { kind: 'text', name: 'title', value: 'My Doc', enabled: true },
        {
          kind: 'file',
          name: 'file',
          source: { kind: 'path', path: 'doc.pdf' },
          enabled: true,
          contentType: 'application/pdf',
        },
      ],
    });
  });
});
