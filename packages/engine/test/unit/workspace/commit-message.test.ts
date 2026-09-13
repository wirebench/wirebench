import { describe, expect, it } from 'vitest';
import { commitMessage, describeTreePath } from '../../../src/workspace/commit-message.js';
import type { TreeChange, TreeEntity } from '../../../src/workspace/commit-message.js';

describe('describeTreePath', () => {
  const cases: ReadonlyArray<[string, TreeEntity]> = [
    ['workspace.yaml', { kind: 'workspace', name: 'workspace', key: 'workspace.yaml' }],
    ['environments/qa.yaml', { kind: 'environment', name: 'qa', key: 'environments/qa.yaml' }],
    [
      'projects/billing/wirebench.yaml',
      { kind: 'project', name: 'billing', projectSlug: 'billing', key: 'projects/billing/wirebench.yaml' },
    ],
    [
      'projects/billing/interfaces/weather/interface.yaml',
      {
        kind: 'interface',
        name: 'weather',
        projectSlug: 'billing',
        key: 'projects/billing/interfaces/weather/interface.yaml',
      },
    ],
    [
      'projects/w/interfaces/i/operations/o/GetWeather.request.yaml',
      {
        kind: 'request',
        name: 'GetWeather',
        projectSlug: 'w',
        key: 'projects/w/interfaces/i/operations/o/GetWeather',
      },
    ],
    [
      'projects/w/interfaces/i/operations/o/GetWeather.xml',
      {
        kind: 'request',
        name: 'GetWeather',
        projectSlug: 'w',
        key: 'projects/w/interfaces/i/operations/o/GetWeather',
      },
    ],
    [
      'projects/billing/environments/qa.yaml',
      {
        kind: 'project-environment',
        name: 'qa',
        projectSlug: 'billing',
        key: 'projects/billing/environments/qa.yaml',
      },
    ],
    [
      'projects/billing/wss/keystores.yaml',
      { kind: 'keystores', name: 'keystores', projectSlug: 'billing', key: 'projects/billing/wss/keystores.yaml' },
    ],
    [
      'projects/billing/wss/outgoing/signing.yaml',
      {
        kind: 'wss',
        name: 'signing',
        projectSlug: 'billing',
        key: 'projects/billing/wss/outgoing/signing.yaml',
      },
    ],
    [
      'projects/billing/attachments/abc123',
      {
        kind: 'attachment',
        name: 'abc123',
        projectSlug: 'billing',
        key: 'projects/billing/attachments/abc123',
      },
    ],
    [
      'projects/billing/attachments/index.yaml',
      {
        kind: 'attachment',
        name: 'index.yaml',
        projectSlug: 'billing',
        key: 'projects/billing/attachments/index.yaml',
      },
    ],
    [
      'projects/billing/interfaces/weather/definition/schema.xsd',
      {
        kind: 'definition',
        name: 'weather',
        projectSlug: 'billing',
        key: 'projects/billing/interfaces/weather/definition',
      },
    ],
    [
      'projects/billing/interfaces/weather/definition/nested/other.xsd',
      {
        kind: 'definition',
        name: 'weather',
        projectSlug: 'billing',
        key: 'projects/billing/interfaces/weather/definition',
      },
    ],
    ['.gitattributes', { kind: 'other', name: '.gitattributes', key: '.gitattributes' }],
    ['something/unexpected.txt', { kind: 'other', name: 'unexpected.txt', key: 'something/unexpected.txt' }],
  ];

  it.each(cases)('classifies %s', (path, expected) => {
    expect(describeTreePath(path)).toEqual(expected);
  });
});

describe('commitMessage', () => {
  it('returns an empty string for no changes', () => {
    expect(commitMessage([])).toBe('');
  });

  it('describes a single modified request spanning two files', () => {
    const changes: TreeChange[] = [
      { path: 'projects/w/interfaces/i/operations/o/GetWeather.request.yaml', status: 'modified' },
      { path: 'projects/w/interfaces/i/operations/o/GetWeather.xml', status: 'modified' },
    ];
    const message = commitMessage(changes);
    expect(message.split('\n\n')[0]).toBe('Update request GetWeather in w');
    expect(message).toBe(
      'Update request GetWeather in w\n\n' +
        'projects/w/interfaces/i/operations/o/GetWeather.request.yaml\n' +
        'projects/w/interfaces/i/operations/o/GetWeather.xml',
    );
  });

  it('describes a single added request as Add', () => {
    const changes: TreeChange[] = [
      { path: 'projects/w/interfaces/i/operations/o/GetWeather.request.yaml', status: 'added' },
      { path: 'projects/w/interfaces/i/operations/o/GetWeather.xml', status: 'added' },
    ];
    expect(commitMessage(changes).split('\n\n')[0]).toBe('Add request GetWeather in w');
  });

  it('describes a single deleted environment', () => {
    const changes: TreeChange[] = [{ path: 'environments/qa.yaml', status: 'deleted' }];
    expect(commitMessage(changes).split('\n\n')[0]).toBe('Delete environment qa');
  });

  it('describes workspace manifest changes without a name', () => {
    const changes: TreeChange[] = [{ path: 'workspace.yaml', status: 'modified' }];
    expect(commitMessage(changes).split('\n\n')[0]).toBe('Update workspace properties');
  });

  it('groups multiple entities with counts sorted by count desc then label asc', () => {
    const changes: TreeChange[] = [
      { path: 'projects/w/interfaces/i/operations/o/A.request.yaml', status: 'modified' },
      { path: 'projects/w/interfaces/i/operations/o/A.xml', status: 'modified' },
      { path: 'projects/w/interfaces/i/operations/o/B.request.yaml', status: 'modified' },
      { path: 'projects/w/interfaces/i/operations/o/B.xml', status: 'modified' },
      { path: 'projects/w/interfaces/i/operations/o/C.request.yaml', status: 'modified' },
      { path: 'projects/w/interfaces/i/operations/o/C.xml', status: 'modified' },
      { path: 'environments/qa.yaml', status: 'added' },
    ];
    expect(commitMessage(changes).split('\n\n')[0]).toBe('Update 3 requests, 1 environment');
  });

  it('sorts equal counts by label ascending', () => {
    const changes: TreeChange[] = [
      { path: 'environments/qa.yaml', status: 'added' },
      { path: 'projects/w/interfaces/i/operations/o/A.request.yaml', status: 'deleted' },
      { path: 'projects/w/interfaces/i/operations/o/A.xml', status: 'deleted' },
    ];
    expect(commitMessage(changes).split('\n\n')[0]).toBe('Update 1 environment, 1 request');
  });

  it('appends the autosave suffix', () => {
    const changes: TreeChange[] = [{ path: 'environments/qa.yaml', status: 'added' }];
    expect(commitMessage(changes, { autosave: true }).split('\n\n')[0]).toBe('Add environment qa (autosave)');
  });

  it('truncates a long single-entity subject with an ellipsis, keeping the autosave suffix', () => {
    const changes: TreeChange[] = [
      {
        path: `projects/billing/interfaces/i/operations/o/${'X'.repeat(80)}.request.yaml`,
        status: 'modified',
      },
    ];
    const subject = commitMessage(changes, { autosave: true }).split('\n\n')[0] ?? '';
    expect(subject.length).toBe(72);
    expect(subject.endsWith('… (autosave)')).toBe(true);
  });

  it('sorts the body paths', () => {
    const changes: TreeChange[] = [
      { path: 'environments/z.yaml', status: 'added' },
      { path: 'environments/a.yaml', status: 'added' },
    ];
    const body = commitMessage(changes).split('\n\n')[1];
    expect(body).toBe('environments/a.yaml\nenvironments/z.yaml');
  });

  it('pluralises WS-Security config and keystores correctly', () => {
    const changes: TreeChange[] = [
      { path: 'projects/b/wss/outgoing/one.yaml', status: 'added' },
      { path: 'projects/b/wss/outgoing/two.yaml', status: 'added' },
      { path: 'projects/b/wss/keystores.yaml', status: 'modified' },
    ];
    expect(commitMessage(changes).split('\n\n')[0]).toBe('Update 2 WS-Security configs, 1 keystores');
  });
});
