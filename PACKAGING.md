# Packaging (Phase 6)

Builds a Windows **NSIS installer** with [electron-builder](https://www.electron.build/),
configured in [`electron-builder.yml`](electron-builder.yml).

## Build

```bash
npm run package
```

This runs `electron-vite build` (typecheck + bundle to `out/`) then electron-builder,
producing:

```
dist/
├── SSH Terminal-<version>-setup.exe        # the installer (assisted NSIS)
├── SSH Terminal-<version>-setup.exe.blockmap
└── win-unpacked/                            # unpacked app (ssh-terminal.exe) for quick testing
```

`dist/` is git-ignored. The installer is **not one-click**: it lets the user choose the
install directory and creates Start-menu + desktop shortcuts.

### Icon

The app/installer icon is generated from `resources/icon.png` (512×512 RGBA);
electron-builder derives the multi-resolution `.ico` automatically. The runtime
window icon uses the same file (kept outside the asar via `asarUnpack`).

## Known gotcha: winCodeSign symlink extraction fails

On first run electron-builder downloads `winCodeSign-2.6.0.7z`, whose archive contains
**macOS symlinks**. Extracting them needs the *Create symbolic links* privilege, which
standard Windows accounts lack, so the build fails with:

```
ERROR: Cannot create symbolic link : A required privilege is not held by the client.
```

Pick **one** fix:

1. **Enable Developer Mode** — Settings → System → For developers → Developer Mode = On.
   (Grants `SeCreateSymbolicLinkPrivilege` to your account.) Then rebuild.
2. **Run the build from an elevated (Administrator) terminal.**
3. **Pre-extract the Windows-only tools** (no privilege needed) so electron-builder
   skips the symlink-laden extraction:

   ```powershell
   $cache = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign"
   $7za   = ".\node_modules\7zip-bin\win\x64\7za.exe"
   # use any freshly downloaded winCodeSign *.7z in $cache
   & $7za x "$cache\<downloaded>.7z" "-o$cache\winCodeSign-2.6.0" -x!darwin -x!linux -y
   ```

## Code signing

Without a signature, Windows SmartScreen shows an "unknown publisher" warning on first
run. Dev builds are intentionally **unsigned** — verify with:

```powershell
Get-AuthenticodeSignature 'dist\SSH Terminal-<version>-setup.exe'   # Status: NotSigned
```

To sign, enable **exactly one** of the approaches below and rebuild. **Never commit
certificates or passwords** — pass them via environment variables. The scaffolding
([`sign.cjs`](sign.cjs) + commented blocks in `electron-builder.yml`) is already in
place; enabling is a matter of setting env vars / uncommenting one line.

### Which one do I have? (SSL.com)

Check your SSL.com dashboard / what you received:
- An **eSigner** section with a TOTP QR code and a *credential ID* → **B (eSigner cloud)**. Most common for certs issued since 2023.
- A shipped **USB token** (YubiKey FIPS / SafeNet) → **C (hardware token)**.
- A downloadable **`.pfx` / `.p12`** file → **A (file)**.

### A) `.pfx` file

No config change needed — electron-builder signs natively when these are set:

```powershell
$env:CSC_LINK        = "C:\path\to\cert.pfx"
$env:CSC_KEY_PASSWORD = "********"
npm run package
```

### B) eSigner cloud (CodeSignTool) — most likely for SSL.com

1. Install [CodeSignTool](https://www.ssl.com/guide/esigner-codesigntool-command-guide/) (requires Java). Note its `CodeSignTool.bat`.
2. In `electron-builder.yml`, under `win:`, uncomment: `sign: ./sign.cjs`
3. Set env vars and build:

   ```powershell
   $env:CODESIGNTOOL_PATH = "C:\Tools\CodeSignTool\CodeSignTool.bat"  # or put on PATH
   $env:ES_USERNAME       = "you@example.com"
   $env:ES_PASSWORD       = "********"
   $env:ES_CREDENTIAL_ID  = "xxxxxxxx"
   $env:ES_TOTP_SECRET    = "BASE32SECRET"   # the eSigner automation secret
   npm run package
   ```

   `sign.cjs` calls CodeSignTool per artifact; without these vars it no-ops (unsigned).

### C) Hardware token (YubiKey / eToken)

The cert lives in the Windows certificate store via the token's middleware. In
`electron-builder.yml` uncomment and set:

```yaml
win:
  certificateSubjectName: "Your Organization, Inc."
```

Signing is **interactive** (the token prompts for a PIN), so this can't run unattended/CI.

### Verify a signed build

```powershell
Get-AuthenticodeSignature 'dist\SSH Terminal-<version>-setup.exe'   # Status: Valid
```

## Manual acceptance (per plan §7, Phase 6)

- [ ] Run `dist\SSH Terminal-<version>-setup.exe` on a clean Windows VM → installs and launches.
- [ ] Open a real SSH session (password / key / agent), confirm interactive apps work.
