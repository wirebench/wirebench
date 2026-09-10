import { describe, expect, it } from 'vitest';
import { collectNamespaces, suggestPrefixes } from '../../../src/xpath/namespaces.js';

describe('collectNamespaces', () => {
  it('collects prefixed and default namespace declarations', () => {
    const xml =
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">' +
      '<soapenv:Body><tem:AddResponse xmlns="urn:default"/></soapenv:Body></soapenv:Envelope>';
    expect(collectNamespaces(xml)).toEqual({
      soapenv: 'http://schemas.xmlsoap.org/soap/envelope/',
      tem: 'http://tempuri.org/',
      '': 'urn:default',
    });
  });

  it('first binding wins when a prefix is redeclared deeper in the tree', () => {
    const xml = '<a xmlns:x="urn:outer"><b xmlns:x="urn:inner"/></a>';
    expect(collectNamespaces(xml)).toEqual({ x: 'urn:outer' });
  });

  it('first binding wins when the default namespace is redeclared deeper in the tree', () => {
    const xml = '<a xmlns="urn:outer"><b xmlns="urn:inner"/></a>';
    expect(collectNamespaces(xml)).toEqual({ '': 'urn:outer' });
  });

  it('returns an empty object for a document with no namespace declarations', () => {
    expect(collectNamespaces('<root><child/></root>')).toEqual({});
  });
});

describe('suggestPrefixes', () => {
  it('suggests a conventional prefix for an unbound namespace URI', () => {
    const xml = '<tem:Add xmlns:tem="http://tempuri.org/"><tem:intA>1</tem:intA></tem:Add>';
    // Already bound to `tem`, so nothing should be suggested for it.
    expect(suggestPrefixes(xml)).toEqual({});
  });

  it('suggests a conventional prefix for the default namespace so it can be queried by prefix', () => {
    // The root's own namespace (urn:tempuri) is only ever seen as the default namespace
    // (collectNamespaces exposes that under '', not under a real prefix) — XPath has no way to
    // address the default namespace, so a real prefix must be suggested for it.
    const xml = '<Root xmlns="http://tempuri.org/"><child/></Root>';
    expect(suggestPrefixes(xml)).toEqual({ 'http://tempuri.org/': 'tem' });
  });
});
