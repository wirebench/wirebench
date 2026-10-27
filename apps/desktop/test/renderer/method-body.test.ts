import { describe, expect, it } from 'vitest';
import { bodyForMethodChange } from '../../src/renderer/features/rest-editor/method-body.js';
import type { RestBodyWire } from '@wirebench/wire/kinds/rest/wire';

describe('bodyForMethodChange (G11)', () => {
  const none = { kind: 'none' } as const;
  const json = { kind: 'raw', language: 'json', text: '' } as const;

  it('starts a bodiless request switched to POST, PUT or PATCH on Raw JSON', () => {
    expect(bodyForMethodChange('GET', 'POST', none)).toEqual(json);
    expect(bodyForMethodChange('DELETE', 'put', none)).toEqual(json);
    expect(bodyForMethodChange('HEAD', 'PATCH', none)).toEqual(json);
  });

  it('leaves a body the request already has', () => {
    const form: RestBodyWire = { kind: 'form', fields: [] };
    expect(bodyForMethodChange('GET', 'POST', form)).toBeUndefined();
  });

  it('leaves None chosen on a POST, and a change to a method without a body', () => {
    expect(bodyForMethodChange('POST', 'PUT', none)).toBeUndefined();
    expect(bodyForMethodChange('GET', 'DELETE', none)).toBeUndefined();
  });
});
