import { describe, expect, it } from 'vitest';
import { reidentifyProject } from '../../../src/workspace/reidentify.js';
import { projectFiles } from '../../../src/project/serialize.js';
import type { Project, SoapOwnerAuth } from '../../../src/project/model.js';
import { fixedIds, sampleProject } from '../project/fixture.js';

/** Every entity id in `project`, in the order `reidentifyProject` visits them. */
function allIds(project: Project): string[] {
  const ids: string[] = [project.id];
  for (const iface of project.interfaces) {
    ids.push(iface.id);
    for (const endpoint of iface.endpoints) {
      ids.push(endpoint.id);
    }
    for (const operation of iface.operations) {
      for (const request of operation.requests) {
        ids.push(request.id);
        for (const attachment of request.attachments) {
          ids.push(attachment.id);
        }
      }
    }
  }
  for (const environment of project.environments) {
    ids.push(environment.id);
  }
  for (const ref of [...project.wss.outgoing, ...project.wss.incoming, ...project.wss.keystores]) {
    ids.push(ref.id);
  }
  return ids;
}

/** `passwordRef`, present only on the Basic/NTLM arm of {@link SoapOwnerAuth}. */
function passwordRefOf(auth: SoapOwnerAuth | undefined): string | undefined {
  return auth?.type === 'basic' || auth?.type === 'ntlm' ? auth.passwordRef : undefined;
}

/** Every string value that looks like a `secretRef`/`passwordRef`/sha256 attachment source, by path, for before/after comparison. */
function secretValues(project: Project): string[] {
  const values: string[] = [];
  for (const iface of project.interfaces) {
    const ifaceRef = passwordRefOf(iface.auth);
    if (ifaceRef !== undefined) {
      values.push(ifaceRef);
    }
    for (const endpoint of iface.endpoints) {
      const endpointRef = passwordRefOf(endpoint.auth);
      if (endpointRef !== undefined) {
        values.push(endpointRef);
      }
    }
    for (const operation of iface.operations) {
      for (const request of operation.requests) {
        const requestRef = passwordRefOf(request.auth);
        if (requestRef !== undefined) {
          values.push(requestRef);
        }
        for (const attachment of request.attachments) {
          if (attachment.source.kind === 'cache') {
            values.push(attachment.source.sha256);
          }
        }
      }
    }
  }
  for (const ref of project.wss.keystores) {
    const passwordSecretRef = ref.document['passwordSecretRef'];
    if (typeof passwordSecretRef === 'string') {
      values.push(passwordSecretRef);
    }
  }
  return values;
}

/** Deep-replaces every entity id in `value` with a stable placeholder, for structural comparison after reidentification. */
function normalizeIds(project: Project): unknown {
  const ids = new Set(allIds(project));
  const placeholders = new Map<string, string>();
  let n = 0;
  const placeholderFor = (id: string): string => {
    let placeholder = placeholders.get(id);
    if (placeholder === undefined) {
      placeholder = `<id-${(n += 1)}>`;
      placeholders.set(id, placeholder);
    }
    return placeholder;
  };
  const sortedIds = [...ids].sort((a, b) => b.length - a.length);
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      let replaced = value;
      for (const id of sortedIds) {
        replaced = replaced.split(id).join(placeholderFor(id));
      }
      return replaced;
    }
    if (Array.isArray(value)) {
      return value.map(walk);
    }
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };
  return walk(project);
}

describe('reidentifyProject', () => {
  it('keeps disabledProperties, at both project and environment scope, untouched', () => {
    const project = sampleProject();
    const reidentified = reidentifyProject(project, fixedIds('NEW'));

    expect(reidentified.disabledProperties).toEqual(project.disabledProperties);
    expect(reidentified.environments.map((e) => e.disabledProperties)).toEqual(
      project.environments.map((e) => e.disabledProperties),
    );
  });

  it('gives every entity a new id and leaves no old id in any file', () => {
    const project = sampleProject();
    const oldIds = allIds(project);
    const reidentified = reidentifyProject(project, fixedIds('NEW'));

    const files = projectFiles(reidentified);
    for (const oldId of oldIds) {
      for (const [path, content] of files) {
        expect(content, `${path} should not contain old id ${oldId}`).not.toContain(oldId);
      }
    }
  });

  it('rewrites every id and every reference to it, preserving whether it resolved', () => {
    const project = sampleProject();
    const reidentified = reidentifyProject(project, fixedIds('NEW'));

    expect(reidentified.id).not.toBe(project.id);
    expect(new Set(allIds(reidentified)).size).toBe(allIds(reidentified).length);
    expect(new Set(allIds(reidentified))).not.toContain(project.id);

    const endpointIdsBefore = new Set(project.interfaces.flatMap((iface) => iface.endpoints.map((e) => e.id)));
    const endpointIdsAfter = new Set(reidentified.interfaces.flatMap((iface) => iface.endpoints.map((e) => e.id)));
    for (let i = 0; i < project.interfaces.length; i += 1) {
      const before = project.interfaces[i]!;
      const after = reidentified.interfaces[i]!;
      expect(after.defaultEndpointId !== undefined && endpointIdsAfter.has(after.defaultEndpointId)).toBe(
        before.defaultEndpointId !== undefined && endpointIdsBefore.has(before.defaultEndpointId),
      );
    }

    const wssOutgoingIdsBefore = new Set(project.wss.outgoing.map((r) => r.id));
    const wssOutgoingIdsAfter = new Set(reidentified.wss.outgoing.map((r) => r.id));
    const wssIncomingIdsBefore = new Set(project.wss.incoming.map((r) => r.id));
    const wssIncomingIdsAfter = new Set(reidentified.wss.incoming.map((r) => r.id));
    const keystoreIdsBefore = new Set(project.wss.keystores.map((r) => r.id));
    const keystoreIdsAfter = new Set(reidentified.wss.keystores.map((r) => r.id));

    for (let i = 0; i < project.interfaces.length; i += 1) {
      const beforeIface = project.interfaces[i]!;
      const afterIface = reidentified.interfaces[i]!;
      for (let o = 0; o < beforeIface.operations.length; o += 1) {
        for (let r = 0; r < beforeIface.operations[o]!.requests.length; r += 1) {
          const before = beforeIface.operations[o]!.requests[r]!;
          const after = afterIface.operations[o]!.requests[r]!;
          expect(after.endpointId !== undefined && endpointIdsAfter.has(after.endpointId)).toBe(
            before.endpointId !== undefined && endpointIdsBefore.has(before.endpointId),
          );
          expect(after.wssOutgoingRef !== undefined && wssOutgoingIdsAfter.has(after.wssOutgoingRef)).toBe(
            before.wssOutgoingRef !== undefined && wssOutgoingIdsBefore.has(before.wssOutgoingRef),
          );
          expect(after.wssIncomingRef !== undefined && wssIncomingIdsAfter.has(after.wssIncomingRef)).toBe(
            before.wssIncomingRef !== undefined && wssIncomingIdsBefore.has(before.wssIncomingRef),
          );
          expect(
            after.properties.sslKeystoreRef !== undefined && keystoreIdsAfter.has(after.properties.sslKeystoreRef),
          ).toBe(
            before.properties.sslKeystoreRef !== undefined && keystoreIdsBefore.has(before.properties.sslKeystoreRef),
          );
        }
      }
    }
  });

  it('rewrites the attachment default content id but leaves the attachment bytes source untouched', () => {
    const project = sampleProject();
    const reidentified = reidentifyProject(project, fixedIds('NEW'));

    const oldAttachments = project.interfaces.flatMap((i) =>
      i.operations.flatMap((o) => o.requests.flatMap((r) => r.attachments)),
    );
    const newAttachments = reidentified.interfaces.flatMap((i) =>
      i.operations.flatMap((o) => o.requests.flatMap((r) => r.attachments)),
    );
    expect(newAttachments).toHaveLength(oldAttachments.length);
    for (let i = 0; i < oldAttachments.length; i += 1) {
      const before = oldAttachments[i]!;
      const after = newAttachments[i]!;
      expect(after.id).not.toBe(before.id);
      expect(after.contentId).toBe(`${after.id}@wirebench`);
      expect(after.source).toEqual(before.source);
    }
  });

  it('leaves secretRef, passwordSecretRef and attachment sha256 values byte-identical', () => {
    const project = sampleProject();
    const before = secretValues(project);
    const reidentified = reidentifyProject(project, fixedIds('NEW'));
    const after = secretValues(reidentified);

    expect(after).toEqual(before);
  });

  it('rewrites a keystore id buried inside a WssRef.document bag, at any depth, arrays included', () => {
    const project = sampleProject();
    const keystoreId = project.wss.keystores[0]!.id;
    const withDocumentRef: Project = {
      ...project,
      wss: {
        ...project.wss,
        incoming: project.wss.incoming.map((ref, index) =>
          index === 0
            ? {
                ...ref,
                document: {
                  ...ref.document,
                  decryptKeystoreRef: keystoreId,
                  nested: { entries: [{ signatureKeystoreRef: keystoreId }] },
                },
              }
            : ref,
        ),
      },
    };

    const reidentified = reidentifyProject(withDocumentRef, fixedIds('NEW'));
    const newKeystoreId = reidentified.wss.keystores[0]!.id;
    const document = reidentified.wss.incoming[0]!.document as {
      decryptKeystoreRef: string;
      nested: { entries: [{ signatureKeystoreRef: string }] };
    };
    expect(document.decryptKeystoreRef).toBe(newKeystoreId);
    expect(document.nested.entries[0].signatureKeystoreRef).toBe(newKeystoreId);
  });

  it('rewrites a wssOutgoingRef/wssIncomingRef/sslKeystoreRef that actually resolves to a config id', () => {
    const project = sampleProject();
    const outgoingRefId = project.wss.outgoing[0]!.id;
    const incomingRefId = project.wss.incoming[0]!.id;
    const keystoreRefId = project.wss.keystores[0]!.id;
    const withRealRefs: Project = {
      ...project,
      interfaces: project.interfaces.map((iface, index) =>
        index === 0
          ? {
              ...iface,
              operations: iface.operations.map((operation, opIndex) =>
                opIndex === 0
                  ? {
                      ...operation,
                      requests: operation.requests.map((request, reqIndex) =>
                        reqIndex === 0
                          ? {
                              ...request,
                              wssOutgoingRef: outgoingRefId,
                              wssIncomingRef: incomingRefId,
                              properties: { ...request.properties, sslKeystoreRef: keystoreRefId },
                            }
                          : request,
                      ),
                    }
                  : operation,
              ),
            }
          : iface,
      ),
    };

    const reidentified = reidentifyProject(withRealRefs, fixedIds('NEW'));
    const request = reidentified.interfaces[0]?.operations[0]?.requests[0];
    expect(request?.wssOutgoingRef).toBe(reidentified.wss.outgoing[0]!.id);
    expect(request?.wssIncomingRef).toBe(reidentified.wss.incoming[0]!.id);
    expect(request?.properties.sslKeystoreRef).toBe(reidentified.wss.keystores[0]!.id);
    expect(request?.wssOutgoingRef).not.toBe(outgoingRefId);
  });

  it('leaves an unknown (dangling) reference as-is instead of inventing an entity for it', () => {
    const project = sampleProject();
    const withDangling: Project = {
      ...project,
      interfaces: project.interfaces.map((iface, index) =>
        index === 0
          ? {
              ...iface,
              operations: iface.operations.map((operation, opIndex) =>
                opIndex === 0
                  ? {
                      ...operation,
                      requests: operation.requests.map((request, reqIndex) =>
                        reqIndex === 0 ? { ...request, wssOutgoingRef: 'no-such-config' } : request,
                      ),
                    }
                  : operation,
              ),
            }
          : iface,
      ),
    };

    const reidentified = reidentifyProject(withDangling, fixedIds('NEW'));
    const dangling = reidentified.interfaces[0]?.operations[0]?.requests[0];
    expect(dangling?.wssOutgoingRef).toBe('no-such-config');
  });

  it('is deterministic under an injected id generator and idempotent in structure across two passes', () => {
    const project = sampleProject();
    const first = reidentifyProject(project, fixedIds('NEW'));
    const second = reidentifyProject(project, fixedIds('NEW'));
    expect(second).toEqual(first);

    const reAgain = reidentifyProject(first, fixedIds('AGAIN'));
    expect(normalizeIds(reAgain)).toEqual(normalizeIds(first));
  });

  it('defaults to generateId (ULIDs) when no generator is injected', () => {
    const project = sampleProject();
    const reidentified = reidentifyProject(project);
    expect(reidentified.id).not.toBe(project.id);
    expect(reidentified.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
