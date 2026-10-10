/**
 * A WSDL's `soap:address` is the contract's text: an endpoint made from it holds a `${…}` escaped as
 * `$${…}`, so the address is sent as written and never reads the sending process's environment (#223).
 * Every place an address becomes an endpoint — import, Update Definition, the endpoint menu — goes
 * through the one helper, and Update Definition compares like with like so it adds no duplicate.
 */
import { describe, expect, it } from 'vitest';
import { expand } from '../../../src/project/properties.js';
import { createInterface, createProject } from '../../../src/project/model.js';
import type { Endpoint, Project } from '../../../src/project/model.js';
import { importWsdl } from '../../../src/soap/import.js';
import type { WsdlImportResult } from '../../../src/soap/types.js';
import { contractPorts, endpointsFromContract, endpointUrlFromContract } from '../../../src/wsdl/contract-endpoints.js';
import { applyUpdate, planUpdate } from '../../../src/wsdl/update-definition.js';
import { soapInterfacesOf } from '../../../src/soap/model.js';

const PROBE = '${#System#WB_PROBE}';
const sent = (text: string): string =>
  expand(text, { project: {}, global: {}, system: { WB_PROBE: 'leaked-from-env' } }).text;

function wsdl(addresses: readonly string[]): string {
  const ports = addresses
    .map(
      (address, index) =>
        `<wsdl:port name="Port${String(index)}" binding="tns:B"><soap:address location="${address}"/></wsdl:port>`,
    )
    .join('');
  return `<?xml version="1.0"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
    xmlns:tns="urn:probe" targetNamespace="urn:probe">
  <wsdl:portType name="P"><wsdl:operation name="Ping"/></wsdl:portType>
  <wsdl:binding name="B" type="tns:P">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <wsdl:operation name="Ping"><soap:operation soapAction="urn:ping"/></wsdl:operation>
  </wsdl:binding>
  <wsdl:service name="S">${ports}</wsdl:service>
</wsdl:definitions>`;
}

const imported = (addresses: readonly string[]): Promise<WsdlImportResult> =>
  importWsdl({ kind: 'text', text: wsdl(addresses) });

function counterIds(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `ep-${String(n)}`;
  };
}

describe('endpointUrlFromContract', () => {
  it('escapes a ${ so the address is sent as written', () => {
    expect(endpointUrlFromContract(`http://host/${PROBE}`)).toBe(`http://host/$${PROBE}`);
    expect(sent(endpointUrlFromContract(`http://host/${PROBE}`))).toBe(`http://host/${PROBE}`);
    expect(endpointUrlFromContract('http://host/plain')).toBe('http://host/plain');
  });
});

describe('endpointsFromContract', () => {
  it('makes one escaped endpoint per distinct address, in document order', async () => {
    const result = await imported([`http://host/${PROBE}`, 'http://host/plain', `http://host/${PROBE}`]);
    const endpoints = endpointsFromContract(contractPorts(result.definition), counterIds());

    expect(endpoints).toEqual([
      { id: 'ep-1', name: 'S Port0', url: `http://host/$${PROBE}`, authMode: 'complement' },
      { id: 'ep-2', name: 'S Port1', url: 'http://host/plain', authMode: 'complement' },
    ]);
    expect(endpoints.map((endpoint) => sent(endpoint.url))).toEqual([`http://host/${PROBE}`, 'http://host/plain']);
  });
});

describe('Update Definition and a contract endpoint', () => {
  function projectWith(endpoints: readonly Endpoint[]): Project {
    const iface = createInterface('S', {
      id: 'if-1',
      slug: 's',
      definitionUrl: 'inline:wsdl',
      endpoints: [...endpoints],
    });
    return { ...createProject('P', { id: 'p-1' }), containers: { soap: [iface] } };
  }

  const urlsAfterUpdate = async (stored: readonly string[], before: string[], after: string[]): Promise<string[]> => {
    const [oldImport, newImport] = await Promise.all([imported(before), imported(after)]);
    const endpoints = stored.map((url, index) => ({
      id: `old-${String(index)}`,
      name: url,
      url,
      authMode: 'complement' as const,
    }));
    const options = {
      createNewRequests: false,
      recreateRequests: false,
      recreateOptional: false,
      keepExisting: true,
      keepSoapHeaders: true,
      createBackups: false,
      updateTestRequests: false as const,
      newId: counterIds(),
    };
    const result = applyUpdate(projectWith(endpoints), 'if-1', planUpdate(oldImport, newImport), newImport, options);
    return soapInterfacesOf(result.project)[0]?.endpoints.map((endpoint) => endpoint.url) ?? [];
  };

  it('names an added address escaped, and adds it escaped', async () => {
    const [oldImport, newImport] = await Promise.all([
      imported(['http://host/a']),
      imported(['http://host/a', `http://host/${PROBE}`]),
    ]);
    expect(planUpdate(oldImport, newImport).endpointsAdded).toEqual([`http://host/$${PROBE}`]);

    expect(
      await urlsAfterUpdate(['http://host/a'], ['http://host/a'], ['http://host/a', `http://host/${PROBE}`]),
    ).toEqual(['http://host/a', `http://host/$${PROBE}`]);
  });

  it('adds no duplicate of an address the interface already holds, escaped or saved before escaping', async () => {
    // The new definition offers the address again (it was removed in between): it is already there.
    expect(await urlsAfterUpdate([`http://host/$${PROBE}`], ['http://host/a'], [`http://host/${PROBE}`])).toEqual([
      `http://host/$${PROBE}`,
    ]);
    // An interface imported before the escape holds the address as the definition wrote it.
    expect(await urlsAfterUpdate([`http://host/${PROBE}`], ['http://host/a'], [`http://host/${PROBE}`])).toEqual([
      `http://host/${PROBE}`,
    ]);
  });

  it('never escapes an already escaped URL again when telling what the interface holds', async () => {
    // The stored URL is the escaped `${…}` address. The new definition's address is literally `$${…}`,
    // a different address, whose endpoint URL is `$$${…}`: it is added, not taken for the stored one.
    expect(await urlsAfterUpdate([`http://host/$${PROBE}`], ['http://host/a'], [`http://host/$${PROBE}`])).toEqual([
      `http://host/$${PROBE}`,
      `http://host/$$${PROBE}`,
    ]);
  });
});
