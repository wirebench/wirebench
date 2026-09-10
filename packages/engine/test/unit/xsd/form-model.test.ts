import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseWsdl } from '../../../src/wsdl/parse-wsdl.js';
import { createDefaultFetchDocument } from '../../../src/wsdl/fetch.js';
import { buildSchemaSet } from '../../../src/xsd/schema-set.js';
import type { SchemaSet } from '../../../src/xsd/schema-set.js';
import { applyForm, buildForm } from '../../../src/xsd/form-model.js';
import type { FormNode } from '../../../src/xsd/form-model.js';
import { applyFormEdit } from '../../../src/xsd/form-edits.js';
import { generateElement } from '../../../src/xsd/sample-generator.js';
import { formatXml } from '../../../src/xml/pretty.js';
import { buildRequestForm } from '../../../src/soap/form-request.js';
import { buildSampleRequest } from '../../../src/soap/request-builder.js';
import type { RequestBuildInput } from '../../../src/soap/request-builder.js';

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const SC = 'urn:wb:sc';

/** Loads a fixture WSDL (`public/<name>` or `crafted/<name>`) and compiles its schemas. */
async function load(relative: string): Promise<RequestBuildInput> {
  const path = `${repoRoot}fixtures/wsdl/${relative}/service.wsdl`;
  const location = pathToFileURL(path).toString();
  const definition = await parseWsdl(
    { location, text: readFileSync(path, 'utf-8') },
    { fetchDocument: createDefaultFetchDocument(), resolveImports: true },
  );
  return { definition, schemaSet: buildSchemaSet(definition) };
}

/** Strips ranges (which depend on the exact source text) so a golden stays about structure. */
function toGolden(node: FormNode): unknown {
  const { repeat, children, ...rest } = node;
  delete (rest as { valueRange?: unknown }).valueRange;
  return {
    ...rest,
    children: children.map(toGolden),
    ...(repeat !== undefined
      ? { repeat: { canAdd: repeat.canAdd, canRemove: repeat.canRemove, instances: repeat.instances.map(toGolden) } }
      : {}),
  };
}

/** `formatXml` on both sides so indentation differences never fail a structural comparison. */
function normalised(xml: string): string {
  return formatXml(xml).text.trim();
}

function findById(node: FormNode, id: string): FormNode | undefined {
  if (node.id === id) {
    return node;
  }
  for (const child of [...node.children, ...(node.repeat?.instances ?? [])]) {
    const found = findById(child, id);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function findByLabel(node: FormNode, label: string): FormNode | undefined {
  if (node.label === label) {
    return node;
  }
  for (const child of [...node.children, ...(node.repeat?.instances ?? [])]) {
    const found = findByLabel(child, label);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

describe('buildForm', () => {
  it('models a sequence of required simple fields (Calculator Add)', async () => {
    const { schemaSet } = await load('public/calculator');
    const root = buildForm(schemaSet, { namespaceUri: 'http://tempuri.org/', localName: 'Add' });
    expect(root.kind).toBe('group');
    expect(root.children.map((c) => c.name.localName)).toEqual(['intA', 'intB']);
    expect(root.children.every((c) => c.kind === 'field' && c.required)).toBe(true);
    expect(root.children[0]?.type?.base).toBe('integer');
  });

  it('reads values and ranges out of an existing fragment', async () => {
    const { schemaSet } = await load('public/calculator');
    const xml = '<tem:Add xmlns:tem="http://tempuri.org/"><tem:intA>7</tem:intA><tem:intB>?</tem:intB></tem:Add>';
    const root = buildForm(schemaSet, { namespaceUri: 'http://tempuri.org/', localName: 'Add' }, xml);
    const intA = root.children[0] as FormNode;
    expect(intA.present).toBe(true);
    expect(intA.value).toBe('7');
    expect(xml.slice(intA.valueRange?.start, intA.valueRange?.end)).toBe('7');
  });

  it('golden: schema-constructs elements cover every construct', async () => {
    const { schemaSet } = await load('crafted/schema-constructs');
    const names = [
      'Level3El',
      'Level3RestrictedEl',
      'ShapeEl',
      'AmountEl',
      'ChoiceEl',
      'AllEl',
      'GroupUserEl',
      'NodeEl',
      'AnyHolderEl',
      'EmptyEl',
      'NillableThing',
      'AnonRoot',
      'Vehicle',
    ];
    const golden = Object.fromEntries(
      names.map((name) => [name, toGolden(buildForm(schemaSet, { namespaceUri: SC, localName: name }))]),
    );
    await expect(JSON.stringify(golden, null, 2)).toMatchFileSnapshot(
      `${repoRoot}packages/engine/test/fixtures/form/schema-constructs.json`,
    );
  });

  it('round-trips every generated Calculator/CountryInfo/schema-constructs body element', async () => {
    const cases: { schemaSet: SchemaSet; elements: readonly string[]; ns: string }[] = [];
    const calc = await load('public/calculator');
    cases.push({
      schemaSet: calc.schemaSet,
      ns: 'http://tempuri.org/',
      elements: [...calc.schemaSet.elements.values()].map((e) => e.name.localName),
    });
    const country = await load('public/countryinfo');
    cases.push({
      schemaSet: country.schemaSet,
      ns: country.definition.targetNamespace,
      elements: [...country.schemaSet.elements.values()]
        .filter((e) => e.name.namespaceUri === country.definition.targetNamespace)
        .map((e) => e.name.localName),
    });
    const sc = await load('crafted/schema-constructs');
    cases.push({
      schemaSet: sc.schemaSet,
      ns: SC,
      elements: [...sc.schemaSet.elements.values()]
        .filter((e) => e.name.namespaceUri === SC)
        .map((e) => e.name.localName),
    });
    for (const group of cases) {
      for (const local of group.elements) {
        const xml = generateElement(group.schemaSet, { namespaceUri: group.ns, localName: local }).xml;
        const round = applyForm(buildForm(group.schemaSet, { namespaceUri: group.ns, localName: local }, xml));
        expect(normalised(round), `${local} round trip`).toBe(normalised(xml));
      }
    }
  });
});

describe('applyFormEdit', () => {
  it('insert-optional materialises an omitted element with a placeholder', async () => {
    const { schemaSet } = await load('crafted/schema-constructs');
    const xml = '<sc:GroupUserEl xmlns:sc="urn:wb:sc" id="?"><first>?</first></sc:GroupUserEl>';
    const root = buildForm(schemaSet, { namespaceUri: SC, localName: 'GroupUserEl' }, xml);
    const note = findByLabel(root, 'sc:note') as FormNode;
    expect(note.present).toBe(false);
    const next = applyFormEdit(root, { kind: 'insert-optional', nodeId: note.id });
    expect(applyForm(next)).toContain('<sc:note>?</sc:note>');
  });

  it('add-repeat/remove-repeat add and drop one instance', async () => {
    const { schemaSet } = await load('crafted/schema-constructs');
    const xml = '<NodeEl xmlns="urn:wb:sc" label="node"/>';
    const root = buildForm(schemaSet, { namespaceUri: SC, localName: 'NodeEl' }, xml);
    const child = findByLabel(root, 'child') as FormNode;
    expect(child.kind).toBe('repeat');
    const added = applyFormEdit(root, { kind: 'add-repeat', nodeId: child.id });
    expect(applyForm(added)).toContain('<child');
    const removed = applyFormEdit(added, { kind: 'remove-repeat', nodeId: child.id, index: 0 });
    expect(applyForm(removed)).not.toContain('<child');
  });

  it('select-choice replaces the other branches', async () => {
    const { schemaSet } = await load('crafted/schema-constructs');
    const xml = '<ChoiceEl xmlns="urn:wb:sc"><single>?</single></ChoiceEl>';
    const root = buildForm(schemaSet, { namespaceUri: SC, localName: 'ChoiceEl' }, xml);
    const choice = root.children.find((c) => c.kind === 'choice') as FormNode;
    expect(choice.choice?.selected).toBe(0);
    const next = applyFormEdit(root, { kind: 'select-choice', nodeId: choice.id, index: 1 });
    const out = applyForm(next);
    expect(out).not.toContain('<single>');
    expect(out).toContain('<many>');
  });

  it('set-value writes a field value', async () => {
    const { schemaSet } = await load('public/calculator');
    const xml = '<tem:Add xmlns:tem="http://tempuri.org/"><tem:intA>1</tem:intA><tem:intB>2</tem:intB></tem:Add>';
    const root = buildForm(schemaSet, { namespaceUri: 'http://tempuri.org/', localName: 'Add' }, xml);
    const intB = findById(root, (root.children[1] as FormNode).id) as FormNode;
    const next = applyFormEdit(root, { kind: 'set-value', nodeId: intB.id, value: '42' });
    expect(applyForm(next)).toContain('<tem:intB>42</tem:intB>');
  });

  it('remove-optional drops a present optional element again', async () => {
    const { schemaSet } = await load('crafted/schema-constructs');
    const xml = '<sc:GroupUserEl xmlns:sc="urn:wb:sc" id="?"><first>?</first><sc:note>hi</sc:note></sc:GroupUserEl>';
    const root = buildForm(schemaSet, { namespaceUri: SC, localName: 'GroupUserEl' }, xml);
    const note = findByLabel(root, 'sc:note') as FormNode;
    expect(note.present).toBe(true);
    expect(applyForm(applyFormEdit(root, { kind: 'remove-optional', nodeId: note.id }))).not.toContain('<sc:note>');
  });

  it('is a no-op for an unknown node id or an out-of-bounds index', async () => {
    const { schemaSet } = await load('crafted/schema-constructs');
    const xml = '<NodeEl xmlns="urn:wb:sc" label="node"><child label="a"/></NodeEl>';
    const root = buildForm(schemaSet, { namespaceUri: SC, localName: 'NodeEl' }, xml);
    const child = findByLabel(root, 'child') as FormNode;
    expect(applyFormEdit(root, { kind: 'insert-optional', nodeId: 'nope' })).toBe(root);
    expect(applyFormEdit(root, { kind: 'remove-repeat', nodeId: child.id, index: 9 })).toBe(root);
    const choiceless = applyFormEdit(root, { kind: 'select-choice', nodeId: root.id, index: 9 });
    expect(applyForm(choiceless)).toBe(applyForm(root));
  });

  it('add-repeat stops at maxOccurs', async () => {
    const { schemaSet } = await load('crafted/schema-constructs');
    // `GroupUser` allows the NamePart group one or two times.
    const xml = '<sc:GroupUserEl xmlns:sc="urn:wb:sc" id="?"><first>a</first><first>b</first></sc:GroupUserEl>';
    const root = buildForm(schemaSet, { namespaceUri: SC, localName: 'GroupUserEl' }, xml);
    const repeat = root.children.find((c) => c.kind === 'repeat') as FormNode;
    expect(repeat.repeat?.canAdd).toBe(false);
    expect(applyFormEdit(root, { kind: 'add-repeat', nodeId: repeat.id })).toBe(root);
  });

  it('keeps content the schema does not describe, verbatim', async () => {
    const { schemaSet } = await load('crafted/schema-constructs');
    const xml = '<AnyHolderEl xmlns="urn:wb:sc"><surprise a="1">kept</surprise><blob>?</blob></AnyHolderEl>';
    const root = buildForm(schemaSet, { namespaceUri: SC, localName: 'AnyHolderEl' }, xml);
    expect(applyForm(root)).toContain('<surprise a="1">kept</surprise>');
  });

  it('falls back to an any node for an element the schema does not declare', () => {
    const empty = buildSchemaSet({ schemaElements: [] });
    const bare = buildForm(empty, { namespaceUri: 'urn:x', localName: 'Nope' });
    expect(bare.kind).toBe('any');
    const fromXml = buildForm(empty, { namespaceUri: 'urn:x', localName: 'Nope' }, '<Nope>text</Nope>');
    expect(applyForm(fromXml)).toBe('<Nope>text</Nope>');
  });
});

describe('buildRequestForm', () => {
  it('locates the Body child of a document/literal envelope', async () => {
    const { schemaSet, definition } = await load('public/calculator');
    const op = {
      bindingName: { namespaceUri: 'http://tempuri.org/', localName: 'CalculatorSoap' },
      operationName: 'Add',
    };
    const generated = buildSampleRequest({ definition, schemaSet }, op);
    const form = buildRequestForm({ definition, schemaSet }, op, generated.envelopeXml);
    expect(form.root.label).toBe('tem:Add');
    expect(generated.envelopeXml.slice(form.bodyRange.start, form.bodyRange.end)).toContain('<tem:Add>');
    expect(form.root.children.map((c) => c.label)).toEqual(['tem:intA', 'tem:intB']);
    // Ranges must address the whole envelope, not the sliced body fragment: the
    // renderer splices a value edit straight into the envelope text.
    const intA = form.root.children[0] as FormNode;
    expect(generated.envelopeXml.slice(intA.valueRange?.start, intA.valueRange?.end)).toBe('?');
  });

  it('treats the rpc wrapper element as the form root', async () => {
    const input = await load('crafted/rpc-literal');
    const binding = input.definition.bindings[0];
    if (binding === undefined) {
      throw new Error('fixture has no binding');
    }
    const operationName = binding.operations[0]?.name as string;
    const op = { bindingName: binding.name, operationName };
    const generated = buildSampleRequest(input, op);
    const form = buildRequestForm(input, op, generated.envelopeXml);
    expect(form.root.label.endsWith(operationName)).toBe(true);
    expect(form.root.children.length).toBeGreaterThan(0);
  });

  it('reports an envelope with no Body, and one with an empty Body', async () => {
    const input = await load('public/calculator');
    const op = {
      bindingName: { namespaceUri: 'http://tempuri.org/', localName: 'CalculatorSoap' },
      operationName: 'Add',
    };
    const none = buildRequestForm(input, op, '<hello/>');
    expect(none.problems).toContain('This envelope has no soapenv:Body element');
    expect(none.root.kind).toBe('any');

    const empty = buildRequestForm(
      input,
      op,
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body/></soapenv:Envelope>',
    );
    expect(empty.problems).toContain('This envelope has an empty Body');
  });

  it('gathers several body parts under one splice-able root', async () => {
    const input = await load('public/calculator');
    const op = {
      bindingName: { namespaceUri: 'http://tempuri.org/', localName: 'CalculatorSoap' },
      operationName: 'Add',
    };
    const envelopeXml =
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">' +
      '<soapenv:Body><tem:Add><tem:intA>1</tem:intA><tem:intB>2</tem:intB></tem:Add>' +
      '<tem:Subtract><tem:intA>3</tem:intA><tem:intB>4</tem:intB></tem:Subtract></soapenv:Body></soapenv:Envelope>';
    const form = buildRequestForm(input, op, envelopeXml);
    expect(form.root.label).toBe('');
    expect(form.root.children.map((c) => c.label)).toEqual(['tem:Add', 'tem:Subtract']);
    expect(envelopeXml.slice(form.bodyRange.start, form.bodyRange.end)).toContain('</tem:Subtract>');
  });

  it('models an rpc/encoded operation from its message parts', async () => {
    const input = await load('crafted/rpc-encoded');
    const binding = input.definition.bindings[0];
    if (binding === undefined) {
      throw new Error('fixture has no binding');
    }
    const operationName = binding.operations[0]?.name as string;
    const op = { bindingName: binding.name, operationName };
    const generated = buildSampleRequest(input, op);
    const form = buildRequestForm(input, op, generated.envelopeXml);
    expect(form.root.kind).toBe('group');
    expect(form.root.label.endsWith(operationName)).toBe(true);
  });
});
