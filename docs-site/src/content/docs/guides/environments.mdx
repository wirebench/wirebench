---
title: Environments & Property Expansion
description: Managing environment variables, property scopes, precedence, and encrypted secrets.
---

# Environments & Property Expansion

Wirebench provides a flexible property expansion engine that allows you to parameterize URLs, headers, and request bodies across multiple deployment environments (Local, Staging, Production).

---

## 1. The Environments View

Open the **Environments** view from the left activity bar. Each environment contains a table of key-value variables:

| Variable Name | Value | Secret | Enabled | Description |
| :--- | :--- | :--- | :--- | :--- |
| `baseUrl` | `https://staging.api.internal` | No | Yes | Target host URL |
| `apiKey` | `wb_live_9a7f32...` | Yes (Masked) | Yes | Authentication token |
| `customerId` | `cust_88291` | No | Yes | Test customer ID |
| `debugTrace` | `true` | No | No (Disabled) | Tracing flag |

### Key Controls:
- **Active Environment Picker**: Located in the top header and status bar. Switching the active environment instantly updates all open tabs.
- **Variable Toggle**: Temporarily disable a variable without deleting its value.

---

## 2. Property Scope Hierarchy & Precedence

When Wirebench encounters a placeholder like `${#Scope#Property}`, it resolves the value based on strict precedence:

```text
Highest Precedence
   │
   ├── 1. Environment Scope:  ${#Env#variableName}
   │
   ├── 2. Project Scope:      ${#Project#variableName}
   │
   └── 3. Workspace Scope:    ${#Workspace#variableName}
Lowest Precedence
```

### Precedence Table

| Syntax | Target Scope | When to Use |
| :--- | :--- | :--- |
| `${#Env#var}` | Active Environment | Hostnames, API keys, and environment-specific endpoints (`baseUrl`, `token`). |
| `${#Project#var}` | Current Project | Common IDs, schema versions, or constants shared across one service project. |
| `${#Workspace#var}` | Active Workspace | Shared global constants across all projects in the workspace. |

---

## 3. Real-World Expansion Examples

### In Address Bars & URLs
```text
${#Env#baseUrl}/v1/customers/${#Env#customerId}/orders
```

### In HTTP Headers
```text
Authorization: Bearer ${#Env#apiKey}
X-Tenant-ID: ${#Project#tenantId}
```

### In JSON Payloads
```json
{
  "customerId": "${#Env#customerId}",
  "requestOrigin": "wirebench-desktop",
  "authHash": "${#Env#apiKey}"
}
```

### In SOAP Envelopes
```xml
<soapenv:Header>
  <auth:Token>${#Env#apiKey}</auth:Token>
</soapenv:Header>
<soapenv:Body>
  <cust:GetProfileRequest>
    <cust:Id>${#Env#customerId}</cust:Id>
  </cust:GetProfileRequest>
</soapenv:Body>
```

---

## 4. Encrypted Secrets & Security

Variables flagged as **Secret** benefit from zero-leak protections:
- **UI Masking**: Values are masked with bullet points in the editor interface.
- **Export Safety**: Secret values are excluded when exporting workspaces or sharing Git repositories.
- **OS Keychain Storage**: Secrets are stored in your operating system's local secure credential vault, never written as plain text into project JSON files.

---

## 5. Proxy & Custom CA Certificates

Under **Preferences → Network & Security**:
- **HTTP/HTTPS Proxy**: Configure corporate proxies with optional basic authentication.
- **Custom CA Certificate Bundles**: Add custom internal root CA certificates (`.pem` / `.crt`) to trust corporate internal TLS endpoints without disabling certificate validation.
