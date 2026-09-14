import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PostmanError } from '../../../../src/errors.js';
import { importPostmanCollection } from '../../../../src/rest/postman/import.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_PATH = resolve(__dirname, '../../../../../../fixtures/postman/crafted/v21/sample-collection.json');

describe('importPostmanCollection', () => {
  it('imports a crafted Postman v2.1 fixture from a file path', async () => {
    const result = await importPostmanCollection({
      kind: 'file',
      path: FIXTURE_PATH,
    });

    expect(result.api.name).toBe('Sample Postman Collection');
    expect(result.api.baseUrl).toBe('https://api.example.com');
    expect(result.summary.folders).toBe(1);
    expect(result.summary.requests).toBe(6);
    expect(result.summary.auth).toBe('bearer');

    // Folder "Users"
    expect(result.api.folders).toHaveLength(1);
    const usersFolder = result.api.folders[0]!;
    expect(usersFolder.name).toBe('Users');
    expect(usersFolder.requests).toHaveLength(5);
    expect(usersFolder.auth?.type).toBe('api-key');

    // Check request 1: List Users
    const listUsers = usersFolder.requests[0]!;
    expect(listUsers.name).toBe('List Users');
    expect(listUsers.method).toBe('GET');
    expect(listUsers.url).toBe('/${apiVersion}/users');
    expect(listUsers.query).toHaveLength(3);
    expect(listUsers.query[0]?.name).toBe('role');
    expect(listUsers.query[0]?.value).toBe('admin');
    expect(listUsers.query[2]?.name).toBe('archived');
    expect(listUsers.query[2]?.enabled).toBe(false);

    // Check request 2: Get User Details with path param
    const getUser = usersFolder.requests[1]!;
    expect(getUser.name).toBe('Get User Details');
    expect(getUser.method).toBe('GET');
    expect(getUser.url).toBe('/${apiVersion}/users/{userId}');
    expect(getUser.pathParams).toHaveLength(1);
    expect(getUser.pathParams[0]?.name).toBe('userId');
    expect(getUser.pathParams[0]?.value).toBe('usr_12345');

    // Check request 3: Create User with raw JSON body
    const createUser = usersFolder.requests[2]!;
    expect(createUser.name).toBe('Create User');
    expect(createUser.method).toBe('POST');
    expect(createUser.body.kind).toBe('raw');
    if (createUser.body.kind === 'raw') {
      expect(createUser.body.language).toBe('json');
      expect(createUser.body.text).toContain('"Jane Doe"');
    }

    // Check request 4: Update User Form with urlencoded body
    const updateUser = usersFolder.requests[3]!;
    expect(updateUser.name).toBe('Update User Form');
    expect(updateUser.method).toBe('PATCH');
    expect(updateUser.body.kind).toBe('form');
    if (updateUser.body.kind === 'form') {
      expect(updateUser.body.fields).toHaveLength(2);
      expect(updateUser.body.fields[0]?.name).toBe('bio');
      expect(updateUser.body.fields[1]?.name).toBe('location');
      expect(updateUser.body.fields[1]?.enabled).toBe(false);
    }

    // Check request 5: Upload User Avatar with multipart formdata
    const uploadAvatar = usersFolder.requests[4]!;
    expect(uploadAvatar.name).toBe('Upload User Avatar');
    expect(uploadAvatar.method).toBe('POST');
    expect(uploadAvatar.body.kind).toBe('multipart');
    if (uploadAvatar.body.kind === 'multipart') {
      expect(uploadAvatar.body.parts).toHaveLength(2);
      expect(uploadAvatar.body.parts[0]?.kind).toBe('text');
      expect(uploadAvatar.body.parts[1]?.kind).toBe('file');
      if (uploadAvatar.body.parts[1]?.kind === 'file') {
        expect(uploadAvatar.body.parts[1].contentType).toBe('image/png');
      }
    }

    // Check root request: Health Check
    expect(result.api.requests).toHaveLength(1);
    const healthReq = result.api.requests[0]!;
    expect(healthReq.name).toBe('Health Check');
    expect(healthReq.url).toBe('/health');
    expect(healthReq.auth.type).toBe('none');
  });

  it('imports from text source', async () => {
    const text = JSON.stringify({
      info: {
        name: 'Inline Collection',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: [
        {
          name: 'Ping',
          request: {
            method: 'GET',
            url: 'https://api.example.com/ping',
          },
        },
      ],
    });

    const result = await importPostmanCollection({
      kind: 'text',
      text,
    });

    expect(result.api.name).toBe('Inline Collection');
    expect(result.summary.requests).toBe(1);
    expect(result.api.requests[0]?.name).toBe('Ping');
  });

  it('throws PostmanError when reading nonexistent file', async () => {
    await expect(
      importPostmanCollection({
        kind: 'file',
        path: '/does/not/exist/collection.json',
      }),
    ).rejects.toThrow(PostmanError);
  });
});
