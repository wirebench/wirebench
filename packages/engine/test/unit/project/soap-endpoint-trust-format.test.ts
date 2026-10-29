import { describe, expect, it } from 'vitest';
import { createProject } from '#core/project/model';
import { loadProject } from '#core/project/load';
import { saveProject } from '#core/project/save';
import { tempProjectDir } from './fixture.js';
import { createInterface, soapInterfacesOf } from '#protocol-soap/soap/model';
// The composition: the entry points fall back to the registry it installs (package split spec §3.3).
import '../../../src/protocols.js';

describe("a SOAP endpoint's trustInvalid on file", () => {
  it('is read back as it was written, and an endpoint without it stays without it', async () => {
    const dir = await tempProjectDir();
    const iface = createInterface('Calc', {
      id: 'iface-1',
      definitionUrl: 'https://calc.example.test/?wsdl',
      cacheDefinition: false,
      endpoints: [
        {
          id: 'ep-1',
          name: 'Self-signed',
          url: 'https://dev.example.test/soap',
          authMode: 'complement',
          trustInvalid: true,
        },
        { id: 'ep-2', name: 'Prod', url: 'https://prod.example.test/soap', authMode: 'complement' },
      ],
    });
    await saveProject({ ...createProject('Demo', { id: 'p1' }), containers: { soap: [iface] } }, dir);

    const { project, problems } = await loadProject(dir);
    expect(problems).toEqual([]);
    const endpoints = soapInterfacesOf(project)[0]?.endpoints;
    expect(endpoints?.[0]).toMatchObject({ id: 'ep-1', trustInvalid: true });
    expect(endpoints?.[1]).not.toHaveProperty('trustInvalid');
  });
});
