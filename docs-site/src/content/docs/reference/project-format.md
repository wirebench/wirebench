---
title: Project Folder Format (v3)
description: Specification for Wirebench's filesystem-backed version 3 project format.
---

# Project Folder Format (v3)

Wirebench persists workspaces, projects, and environments directly as structured filesystem directories. This design guarantees complete version control compatibility, legible Git diffs, and zero vendor lock-in.

---

## 1. Directory Structure

A complete Wirebench workspace follows this layout:

```text
my-workspace/
├── .wirebench/
│   ├── workspace.json          # Workspace manifest (active env, window layout)
│   └── environments/
│       ├── development.json    # Environment variables
│       └── production.json
└── projects/
    └── customer-billing/
        ├── project.json        # Project manifest (v3 format)
        ├── interfaces/
        │   ├── BillingService.wsdl # Cached service contract
        │   └── openapi.yaml
        ├── requests/
        │   ├── generateInvoice.xml # Saved SOAP operation
        │   └── processPayment.xml
        └── rest/
            ├── getSubscriptions.json # Saved REST request
            └── cancelPlan.json
```

---

## 2. Project Manifest Schema (`project.json`)

Each project folder contains a `project.json` adhering to the version 3 specification:

```json
{
  "version": 3,
  "id": "proj_94b1a45ce",
  "name": "Customer Billing Service",
  "createdAt": "2026-09-14T12:00:00.000Z",
  "description": "Enterprise billing, subscriptions, and invoicing APIs.",
  "interfaces": [
    {
      "id": "iface_soap_1",
      "name": "BillingBinding",
      "type": "soap",
      "definitionPath": "interfaces/BillingService.wsdl",
      "endpoint": "${#Env#billingServiceUrl}"
    },
    {
      "id": "iface_rest_1",
      "name": "Billing REST API",
      "type": "rest",
      "definitionPath": "interfaces/openapi.yaml",
      "endpoint": "${#Env#billingRestUrl}"
    }
  ]
}
```

---

## 3. Request File Formats

Wirebench deliberately avoids saving all requests in one giant monolithic JSON file:

- **SOAP Requests (`requests/*.xml`)**: Saved as pure XML files containing the envelope payload, with custom metadata (e.g. timeout, headers) stored in a lightweight header comment or sibling `.meta.json`.
- **REST Requests (`rest/*.json`)**: Saved as human-readable JSON files:
  ```json
  {
    "id": "req_8829a",
    "name": "Get Subscriptions",
    "method": "GET",
    "url": "${#Env#baseUrl}/v1/subscriptions",
    "headers": {
      "Accept": "application/json",
      "Authorization": "Bearer ${#Env#apiKey}"
    },
    "queryParams": [
      { "key": "status", "value": "active", "enabled": true }
    ]
  }
  ```

---

## 4. Git Collaboration & Conflict Immunity

Because each request is its own file:
- Two developers can edit different requests in the same project simultaneously without causing Git merge conflicts.
- Adding a new request produces a clean `+1 file` diff in Git.
- Git pull requests are readable and easy to review in GitHub/GitLab.
