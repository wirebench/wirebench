---
title: Introduction
description: Overview of Wirebench, design philosophy, architecture, and protocol support.
---

import Endpoint from '../../components/Endpoint.astro';
import Shortcut from '../../components/Shortcut.astro';

# Introduction to Wirebench

**Wirebench** is a native, clean-room desktop workbench built specifically for developers and enterprise engineers who test and debug **SOAP** (WSDL 1.1 / 2.0, XML Schema, WS-Security) and **REST** (OpenAPI 3.0, JSON, multipart) APIs.

![Wirebench Workspace Launcher](/images/workspace-picker.png)

---

## Why Wirebench?

Modern API testing tools have drifted into bloated, cloud-dependent platforms that require mandatory sign-ins, upload proprietary team data to vendor clouds, and neglect SOAP/XML protocols. Wirebench was created to solve this:

1. **Craft Workbench Design**: Built as a dense, distraction-free desktop application. It uses a warm dark ramp, hairline borders, and a single reserved terracotta accent for focus and primary actions.
2. **Git-Native Collaboration**: Workspaces are standard Git repositories. Share test definitions, environments, and mocks with your team using your existing Git workflow (branches, pull requests, code reviews) with zero cloud vendor lock-in.
3. **Clean-Room Implementation**: Built from scratch in TypeScript and Node without legacy baggage. It strictly obeys WS-I Basic Profile 1.1 and OpenAPI 3 specifications.
4. **Offline First & Secure**: All files, keystores, and environments reside locally on your disk. Sensitive credentials are encrypted in your local OS vault, never synced to external servers.

---

## Core Capabilities Matrix

| Protocol / Area | Standards Supported | Core Capabilities |
| :--- | :--- | :--- |
| **REST Client** | HTTP/1.1, HTTP/2, OpenAPI 3.0 | Path variables (`/users/{id}`), dynamic query table, form-data file uploads, urlencoded bodies, response headers, and status code assertions. |
| **SOAP Client** | WSDL 1.1, WSDL 2.0, SOAP 1.1, SOAP 1.2 | XSD Schema Tree, operation inspector, automatic envelope generation, WS-I compliance checks, and Update Definition sync. |
| **WS-Security** | UsernameToken, X.509, Keystores | PKCS#12 (`.p12` / `.pfx`) and Java Keystores (`.jks`), XML Signature, XML Encryption, timestamp headers. |
| **Attachments** | MTOM / XOP, SOAP with Attachments (SwA) | Multipart MIME streaming, binary file packaging, inline CID referencing. |
| **Environments** | Local & Workspace Scopes | Property expansion syntax (`${#Env#x}`, `${#Project#x}`), masked secret values, and per-variable enable/disable switches. |
| **Workspaces** | Git repositories, Local folders | Multi-project workspace containers, branch awareness, and visual 3-way conflict resolution. |

---

## Next Steps

- Proceed to [Installation](/getting-started/installation/) to install Wirebench on macOS, Windows, or Linux.
- Follow the [5-Minute Quickstart](/getting-started/quickstart/) to send your first request.
