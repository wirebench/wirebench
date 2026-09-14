---
title: Shared Workspaces & Collaboration
description: Collaborate on API projects using Git-backed shared workspaces, sync status, and visual merge conflict resolution.
---

import Shortcut from '../../components/Shortcut.astro';

# Shared Workspaces & Git Collaboration

In Wirebench, collaboration is built on **standard Git repositories**. You can share entire workspaces — including projects, environments, and test definitions — across your engineering team without relying on proprietary third-party servers.

---

## 1. Connecting a Shared Workspace

To set up a Git-backed shared workspace:
1. Open the Workspace Manager (<Shortcut keys={["Cmd", "Shift", "N"]} />).
2. Select **Share Workspace** or **Join Shared Workspace**.
3. Provide your Git repository URL (HTTPS or SSH, e.g. `git@github.com:your-org/api-tests.git`).
4. Wirebench initializes the Git repository and hooks into your system Git client.

---

## 2. The Sync Panel

The **Sync Panel** gives you complete visibility into repository state without switching to a terminal:

- **Branch Tracking**: View your current working branch and upstream tracking branch.
- **Ahead / Behind Status**: Shows how many commits you are ahead of or behind the remote.
- **Recent Sync History**: Commit log with commit hashes, author names, and change summaries.
- **Sync Actions**: One-click **Pull**, **Commit & Push**, or **Fetch**.

![Wirebench Shared Workspace Sync Panel](/images/sync-panel.png)

---

## 3. Visual 3-Way Merge Conflict Resolution

When multiple team members modify the same request or project definition concurrently, Wirebench eliminates manual Git conflict markers (`<<<<<<< HEAD`) by providing a built-in **Visual Conflict Resolver**:

- **Three-Way Comparison**:
  - **Local Version**: Your local changes made in this session.
  - **Base Version**: The common ancestor commit.
  - **Remote Version**: Incoming changes pushed by a teammate.
- **Granular Merging**: Accept local, accept remote, or inspect property diffs side-by-side.
- **Safe Resolution**: Resolving marks the file clean and creates an atomic merge commit.

![Three-Way Visual Merge Conflict Resolver](/images/conflict-resolver.png)

---

## 4. Branching & PR Workflows

Because Wirebench workspaces are standard Git repositories:
- You can create feature branches (e.g. `git checkout -b feature/v2-payment-apis`).
- Push branches and open Pull Requests on GitHub, GitLab, or Bitbucket.
- Code reviewers can review API changes, schema updates, and test assertions in standard pull request diffs.

---

## 5. Offline-First Resilience

If you lose internet connectivity:
- Wirebench remains fully functional. You can create requests, edit envelopes, and test local services.
- All modifications are committed to your local Git repository.
- When reconnected, click **Sync** to push your work to the remote team repository.
