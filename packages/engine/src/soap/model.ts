/**
 * The SOAP part of the project model: the project's *interfaces*, each a WSDL binding with its
 * operations and the requests saved under them.
 */

import type { Interface, Project } from '../project/model.js';
import { containersOf, withContainersOf } from '../project/model.js';

/** The project's SOAP interfaces, in the order the project holds them. */
export function soapInterfacesOf(project: Project): readonly Interface[] {
  return containersOf(project, 'soap') as readonly Interface[];
}

/** `project` with its SOAP interfaces replaced; every other kind's containers are kept. */
export function withSoapInterfaces(project: Project, interfaces: readonly Interface[]): Project {
  return withContainersOf(project, 'soap', interfaces);
}
