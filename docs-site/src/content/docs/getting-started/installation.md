---
title: Installation
description: How to install Wirebench on macOS, Windows, and Linux.
---

# Installing Wirebench

Wirebench is distributed as native standalone binaries for macOS, Windows, and Linux.

## Platform Downloads & Installation

### macOS (Apple Silicon & Intel)
- **Supported Versions**: macOS 12 Monterey or later.
- **Architectures**: Universal (`arm64` Apple Silicon & `x64` Intel).
- **Download**: `Wirebench-2.0.0-arm64.dmg` or `Wirebench-2.0.0-x64.dmg`.

#### Installation Steps:
1. Double-click the downloaded `.dmg` file to mount it.
2. Drag `Wirebench.app` into your **Applications** folder.
3. Eject the mounted disk image.

> **macOS Gatekeeper Note (Unsigned Development Builds):**  
> If you are installing an unsigned development build, macOS Gatekeeper may prompt that the application cannot be opened because Apple cannot check it for malicious software:
> 1. In Finder, navigate to your **Applications** folder.
> 2. Right-click (or Control-click) `Wirebench.app` and select **Open**.
> 3. Click **Open** on the confirmation prompt.
> 
> *Command line alternative:*  
> ```bash
> xattr -d com.apple.quarantine /Applications/Wirebench.app
> ```

---

### Windows (x64 & ARM64)
- **Supported Versions**: Windows 10 and 11.
- **Download**: `Wirebench-Setup-2.0.0.exe` (NSIS Installer) or portable `.zip`.

#### Interactive Setup:
Run `Wirebench-Setup-2.0.0.exe` and follow the on-screen installer prompts.

#### Enterprise Fleet Silent Installation:
For automated deployment via Microsoft Intune or Group Policy:
```powershell
Wirebench-Setup-2.0.0.exe /S /allusers
```

---

### Linux
- **Packages Available**: AppImage (`.AppImage`), Debian package (`.deb`), and archive (`.tar.gz`).
- **Running AppImage**:
  ```bash
  chmod +x Wirebench-2.0.0.AppImage
  ./Wirebench-2.0.0.AppImage
  ```
- **Installing Debian / Ubuntu Package**:
  ```bash
  sudo dpkg -i wirebench_2.0.0_amd64.deb
  ```

---

## Verifying Release Integrity

Every official Wirebench release publishes SHA-256 checksums in `SHASUMS256.txt` on the GitHub Releases page. To verify your download:

```bash
# macOS
shasum -a 256 Wirebench-2.0.0-arm64.dmg

# Windows (PowerShell)
Get-FileHash Wirebench-Setup-2.0.0.exe -Algorithm SHA256

# Linux
sha256sum Wirebench-2.0.0.AppImage
```
