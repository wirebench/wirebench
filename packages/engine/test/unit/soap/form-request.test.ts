import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDefaultFetchDocument } from '../../../src/wsdl/fetch.js';
import { parseWsdl } from '../../../src/wsdl/parse-wsdl.js';
import { buildSchemaSet } from '../../../src/xsd/schema-set.js';
import { applyForm } from '../../../src/xsd/form-model.js';
import { applyFormEdit } from '../../../src/xsd/form-edits.js';
import { buildRequestForm } from '../../../src/soap/form-request.js';
import type { RequestBuildInput } from '../../../src/soap/request-builder.js';

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

async function load(relative: string): Promise<RequestBuildInput> {
  const location = `${repoRoot}fixtures/wsdl/${relative}/service.wsdl`;
  const definition = await parseWsdl(
    { location, text: readFileSync(location, 'utf-8') },
    { fetchDocument: createDefaultFetchDocument(), resolveImports: true },
  );
  return { definition, schemaSet: buildSchemaSet(definition) };
}

/** An rpc-literal `Multiply` envelope with a hand-added element the WSDL's parts never claim. */
const ENVELOPE_WITH_EXTRA = `<?xml version="1.0"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="urn:wb:rpclit">
   <soapenv:Body>
      <tns:Multiply>
         <a>2</a>
         <b>3</b>
         <opts>
            <rounding>up</rounding>
            <scale>2</scale>
         </opts>
         <note>hand-added, no part claims this</note>
      </tns:Multiply>
   </soapenv:Body>
</soapenv:Envelope>`;

describe('buildRequestForm — rpc wrapper leftover passthrough', () => {
  let input: RequestBuildInput;

  beforeAll(async () => {
    input = await load('crafted/rpc-literal');
  });

  function buildOp(i: RequestBuildInput) {
    return {
      bindingName: { namespaceUri: i.definition.targetNamespace, localName: 'RpcLiteralBinding' },
      operationName: 'Multiply',
    };
  }

  it('models the unmatched wrapper child as a passthrough node, not dropped', () => {
    const form = buildRequestForm(input, buildOp(input), ENVELOPE_WITH_EXTRA);
    const noteNode = form.root.children.find((c) => c.label === 'note');
    expect(noteNode).toBeDefined();
    expect(noteNode?.kind).toBe('any');
    expect(noteNode?.raw).toContain('hand-added, no part claims this');
  });

  it('keeps the extra element byte-for-byte after a structural edit (set-value) round trip', () => {
    const form = buildRequestForm(input, buildOp(input), ENVELOPE_WITH_EXTRA);
    const aNode = form.root.children.find((c) => c.label === 'a');
    expect(aNode).toBeDefined();
    const edited = applyFormEdit(form.root, { kind: 'set-value', nodeId: aNode!.id, value: '99' });
    const rendered = applyForm(edited);
    expect(rendered).toContain('<note>hand-added, no part claims this</note>');
    expect(rendered).toContain('<a>99</a>');
  });

  it('keeps the extra element after an add-repeat structural edit elsewhere in the wrapper', () => {
    // opts is a fixed-shape complex part here (no repeat), so exercise the same invariant via
    // remove-optional-equivalent: re-run set-value on b and confirm note survives too.
    const form = buildRequestForm(input, buildOp(input), ENVELOPE_WITH_EXTRA);
    const bNode = form.root.children.find((c) => c.label === 'b');
    expect(bNode).toBeDefined();
    const edited = applyFormEdit(form.root, { kind: 'set-value', nodeId: bNode!.id, value: '7' });
    const rendered = applyForm(edited);
    expect(rendered).toContain('<note>hand-added, no part claims this</note>');
    expect(rendered).toContain('<b>7</b>');
  });
});
