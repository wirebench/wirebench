Wirebench portable data folder
==============================

This folder makes this copy of Wirebench portable. While it sits next to Wirebench.exe,
Wirebench keeps everything it writes in here: workspaces, preferences, history, saved
secrets and caches. Nothing is written to %APPDATA%.

- Keep the folder writable. Read-only media cannot hold a portable copy.
- Saved secrets are encrypted for the Windows user who saved them, on that machine. Moved
  to another machine or another user, they need entering again. Everything else travels.
- To update, unpack the new version's zip and move this folder into it, replacing the
  data folder the zip came with.
- Delete or rename the folder to make this copy use %APPDATA%\Wirebench instead.
