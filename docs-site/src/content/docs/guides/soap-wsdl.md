---
title: SOAP & WSDL Guide
description: Importing WSDL definitions, navigating schemas, editing envelopes, configuring WS-Security, and handling attachments.
---

import Shortcut from '../../components/Shortcut.astro';

# SOAP & WSDL Guide

Wirebench delivers a clean-room, standards-compliant environment for testing and debugging SOAP 1.1 and 1.2 web services.

---

## 1. Importing a Service Definition

To import a WSDL:
1. In the Explorer sidebar, click **Import WSDL…**
2. Enter a local filesystem path (e.g. `path/to/service.wsdl`) or an HTTP/HTTPS URL.
3. Wirebench parses all bindings, ports, operations, and nested XML Schemas (`.xsd`).

![Import WSDL Dialog](/wirebench/images/import-wsdl.png)

---

## 2. The Operations Tree & Schema Explorer

Imported services are organized hierarchically:
- **Service Name** → **Port / Binding** → **Operations** (e.g. `Add`, `Subtract`, `GetCustomer`).

Clicking any operation opens the request editor:
- Wirebench generates a compliant SOAP envelope with sample placeholders for all required parameters.
- Optional parameters are marked with comments indicating `minOccurs="0"`.
- Complex types, nested sequences, and choice elements are clearly visualized.

![SOAP Request Envelope Editor](/wirebench/images/request-editor.png)

---

## 3. Executing Requests & Response Analysis

Click **Send** or press <Shortcut keys={["Cmd", "Enter"]} /> to dispatch the envelope over HTTP or HTTPS.

The response viewer renders:
- **Status Banner**: HTTP status code, SOAP Fault indicator (if returned), and latency.
- **XML Formatter**: Collapsible XML elements, syntax coloring, and tag matching.
- **Headers**: Raw HTTP headers, cookies, and transfer encoding metadata.

![SOAP Response Viewer](/wirebench/images/response.png)

---

## 4. WS-Security (WSS) Configuration

Under the **Auth / Security** tab, configure message-level security without writing custom code:

### UsernameToken
- Supports `PasswordText` and `PasswordDigest` (SHA-1 digest over Password + Nonce + Created).
- Automatic nonce generation and ISO-8601 timestamp injection (`wsu:Timestamp`).

### X.509 Certificate Signing & Encryption
- Keystore support: PKCS#12 (`.p12` / `.pfx`) and Java Keystores (`.jks`).
- Configure key alias, keystore password, and private key passphrase.
- Signature canonicalization algorithms: `C14N11` (Inclusive) and `ExcC14N` (Exclusive).
- Inspect the `<wsse:Security>` header block directly in the generated envelope before transmission.

---

## 5. MTOM & SwA Attachments

Wirebench supports both binary attachment protocols:

1. **MTOM / XOP (Message Transmission Optimization Mechanism)**:
   - Binary data is optimized as separate MIME parts while referenced in the XML body via `cid:` URIs:
     ```xml
     <doc:DocumentContent>
       <xop:Include xmlns:xop="http://www.w3.org/2004/08/xop/include" href="cid:invoice.pdf"/>
     </doc:DocumentContent>
     ```
2. **SOAP with Attachments (SwA)**:
   - Attachments are packaged as MIME parts alongside the primary SOAP envelope.

Open the **Attachments** drawer at the bottom of the editor to add files, set Content-Types, and review outgoing MIME multipart streams.

---

## 6. Update Definition (Zero Data Loss)

When an upstream WSDL changes:
1. Right-click the service in the Explorer and choose **Update Definition**.
2. Wirebench merges the updated schema with your existing workspace.
3. Your custom request envelopes, saved tests, and environment parameters are preserved intact.
