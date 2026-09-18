---
title: 5-Minute Quickstart
description: Create a workspace, import an API, edit the request envelope, and inspect the response.
---

import { Steps } from '@astrojs/starlight/components';
import Shortcut from '../../components/Shortcut.astro';

# 5-Minute Quickstart

This walkthrough takes you from zero to executing your first API request and inspecting response payloads in Wirebench.

<Steps>

1. #### Open or Create a Workspace

   When you first launch Wirebench, the **Workspace Picker** appears. You can select an existing workspace folder or click **New Workspace** to initialize a new workbench container.

   ![Wirebench Workspace Picker](/wirebench/images/getting-started/workspace-picker.png)

   *Shortcut:* Press <Shortcut keys={["Cmd", "Shift", "N"]} /> (macOS) or <Shortcut keys={["Ctrl", "Shift", "N"]} /> (Windows/Linux) to create a new workspace at any time.

2. #### Import a Service Definition (WSDL or OpenAPI)

   Wirebench lets you import existing service contracts directly into your projects:
   
   - In the Explorer sidebar, click **Import** or right-click your project and select **Import WSDL…**
   - Provide a local file path or enter a remote service URL (such as a local mock or enterprise endpoint).
   - Wirebench automatically parses the service contracts, bindings, port types, and linked XML Schemas.

   ![Import WSDL Modal](/wirebench/images/getting-started/import-wsdl.png)

3. #### Explore Operations & Edit the Request Envelope

   Once imported, all services and operations are displayed hierarchically in the Explorer tree:
   
   - Click an operation (e.g. `Add`) to open the request editor.
   - Wirebench generates a clean, compliant SOAP envelope with sample placeholders for all required input parameters.
   - The editor provides full XML syntax highlighting, tag auto-closing, and real-time validation.

   ![SOAP Request Editor and Envelope](/wirebench/images/getting-started/request-editor.png)

4. #### Execute the Request and Inspect the Response

   Click the **Send** button in the upper right, or press <Shortcut keys={["Cmd", "Enter"]} /> (<Shortcut keys={["Ctrl", "Enter"]} /> on Windows/Linux) to dispatch the request.

   The response inspector displays:
   - **Status & Latency**: HTTP status code, round-trip execution duration, and payload size.
   - **Formatted XML/JSON Body**: Syntax-highlighted response body with collapsible nodes and line numbers.
   - **Headers & Raw View**: Complete response headers and raw HTTP stream inspector.

   ![SOAP Response Inspector](/wirebench/images/getting-started/response.png)

</Steps>

---

## What's Next?

Now that you have executed your first request:
- Learn how to send REST requests, set path variables, and configure query parameters in the [REST Client Guide](/wirebench/guides/rest-client/).
- Configure dynamic variables across environments in [Environments & Property Expansion](/wirebench/guides/environments/).
- Share your workspace with your team using Git in [Shared Workspaces](/wirebench/guides/workspaces/).
