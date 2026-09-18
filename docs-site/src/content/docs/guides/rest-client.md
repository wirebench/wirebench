---
title: REST Client Guide
description: Creating REST requests, configuring query parameters, path variables, request bodies, and inspecting responses.
---

import Shortcut from '../../components/Shortcut.astro';

# REST Client Guide

Wirebench includes a modern REST client engineered for speed, high contrast, and full OpenAPI 3.0 compatibility.

![Wirebench REST Client & Response Inspector](/wirebench/images/rest-response.png)

---

## Supported HTTP Methods

The method picker in the URL bar supports standard REST methods:

- `GET`: Safe, idempotent resource retrieval.
- `POST`: Resource creation or command execution.
- `PUT`: Complete resource replacement.
- `PATCH`: Partial resource updates.
- `DELETE`: Resource deletion.

---

## URL Address Bar & Path Variables

### Dynamic Address Bar
The address bar combines the HTTP method selector with the target endpoint URL:


Press <Shortcut keys={["Cmd", "Enter"]} /> (or <Shortcut keys={["Ctrl", "Enter"]} />) to execute immediately from the URL input.

### Path Variables
Path variables are declared in the URL using curly braces: `{variableName}`.

When Wirebench detects a path variable:
1. It automatically generates an entry in the **Path Variables** sub-tab.
2. You can provide static values or dynamic property placeholders:
   - `userId`: `${#Env#activeUserId}`
3. Before dispatching the HTTP request, Wirebench interpolates the resolved value into the URL path.

---

## Query Parameters Table

Under the **Params** tab, manage query string parameters in a clean table:

| Key | Value | Description | Enabled |
| :--- | :--- | :--- | :--- |
| `limit` | `25` | Page size limit | Yes |
| `status` | `active` | Filter active records | Yes |
| `sort` | `createdAt:desc` | Ordering criteria | Yes |

- **Auto-Sync**: Editing key-value rows in the table updates the URL in real time, and editing query parameters in the address bar automatically updates the table.
- **Toggle Switches**: Enable or disable specific parameters without deleting them.

---

## Request Body Formats

Under the **Body** tab, configure the request payload:

### 1. JSON (`application/json`)
- Syntax highlighting and indentation formatting (<Shortcut keys={["Option", "Shift", "F"]} />).
- Real-time JSON validation with syntax error badges.
- Supports property expansion inside JSON fields:
  ```json
  {
    "accountId": "${#Env#accountId}",
    "role": "editor",
    "updatedAt": "${#Env#currentTimestamp}"
  }
  ```

### 2. Multipart Form Data (`multipart/form-data`)
- Supports mixed text fields and binary file uploads.
- Select local files for attachments with automatic Content-Type detection.

### 3. URL-Encoded (`application/x-www-form-urlencoded`)
- Standard key-value pairs formatted for HTML form submissions and OAuth 2 token requests.

### 4. Raw Text / Custom MIME Types
- Send raw XML, plain text, GraphQL queries, or custom application formats with manual Content-Type headers.

---

## Response Inspector

The right-hand response viewer provides instant feedback:

- **Status Badge**: Displays HTTP status code (e.g. `200 OK`, `201 Created`, `404 Not Found`) and HTTP status message.
- **Latency & Size**: Accurate round-trip network execution time in milliseconds and formatted payload size (e.g. `1.4 KB`).
- **Body Viewer**: Formatted JSON response with syntax coloring, search (<Shortcut keys={["Cmd", "F"]} />), and line numbers.
- **Headers Tab**: Filterable list of all HTTP response headers sent by the server.
