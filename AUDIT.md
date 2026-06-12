# Pre-Release Audit — Simple SSH

**Date:** 2026-06-12 · **Version audited:** 0.0.1 → released as 1.0.0 · **Scope:** security deep-dive, code quality, functional QA, release readiness.

## Executive summary

The app is in good shape for a first public release. The manual security review found **no exploitable flaws**: host-key verification fails closed, secrets never reach the UI or disk in plaintext, the IPC surface is minimal and validated, port-forward listeners bind loopback only, and the frontend has no XSS vectors. Functional testing against a live SSH server verified the full auth/host-key/MFA/forwarding matrix end-to-end. Release blockers found (clippy gate failure, missing LICENSE, stale 0.0.1 version) were fixed during the audit. Remaining findings are backlog items.

## Findings

| ID | Severity | Area | Finding | Status |
|----|----------|------|---------|--------|
| F1 | Blocker | Quality gate | `cargo clippy -D warnings` failed: `redundant_pattern_matching` in `src-tauri/src/secrets.rs:30` | **Fixed** (use `.is_ok()`) |
| F2 | Blocker | Release | No `LICENSE` file despite MIT declared in `package.json` and `Cargo.toml` | **Fixed** (MIT LICENSE added) |
| F3 | Blocker | Release | Version 0.0.1 in manifests | **Fixed** (bumped to 1.0.0 in `package.json` + `Cargo.toml`; `tauri.conf.json` inherits from package.json) |
| F4 | Medium | Dependencies | RUSTSEC-2023-0071: `rsa` crate Marvin timing side-channel (CVSS 5.9), pulled in via russh's `rsa` feature; **no upstream fix exists**. Practical exploitability against an interactive SSH *client* is low (attacker needs many timed RSA-decrypt observations). Mitigation: prefer Ed25519 keys; track russh releases. | Backlog |
| F5 | Low | Known bug | Theme toggle doesn't repaint window chrome while a terminal is open (WebView2 compositor; minimize+restore flushes). Cosmetic, known workaround. | Backlog |
| F6 | Low | Dead code | `sign.cjs` (Electron-era electron-builder signing hook) is tracked but unused since the Tauri port. Contains no secrets. | Backlog — remove |
| F7 | Low | Secrets | Keyring id scheme `pw:user@host:port` could collide if a username contains `@`/`:` (only affects the local user's own saved entries; no privilege impact). In-memory secrets are not zeroized after use (normal for this app class; OS keyring is the at-rest store). | Backlog |
| F8 | Low | Robustness | `KnownHostsStore`/`ProfileStore` silently start empty on corrupt JSON (good: no crash) and silently ignore write failures — a failed `known_hosts.json` write means a trust decision is re-prompted next time (fail-safe direction). | Backlog — consider surfacing write errors |
| F9 | Info | UX | Kbd-interactive auto-answer sends the typed password once to a single hidden prompt after host-key verification — matches OpenSSH PAM behavior; a malicious server could harvest the password, but only after the user explicitly trusted its key (inherent to SSH password auth). | No action |

## Security review evidence (Phase 1)

- **Host keys** ([handler.rs](src-tauri/src/session/handler.rs), [known_hosts.rs](src-tauri/src/known_hosts.rs)): comparison is over the full raw wire-format key (not the fingerprint); un-encodable keys fail closed; prompt timeout (300 s), dropped sender, and session teardown all resolve to *reject*; verification runs inside the russh handshake, so no channel data flows before acceptance. `hostkey_decision` consumes the per-session oneshot, so a decision can't be replayed or applied cross-session.
- **Secrets** ([secrets.rs](src-tauri/src/secrets.rs), [commands.rs](src-tauri/src/commands.rs)): plaintext exists only in backend memory; saved only after successful auth (`on_ready`); IPC exposes presence/forget only. Verified on disk: Credential Manager holds `pw:test@localhost:2222.simple-ssh`; `profiles.json` recents contain `{"kind":"password"}` with no value (`sanitized()` applied in both profile save and recents paths).
- **IPC surface** (17 commands): session ids are server-generated UUIDs; commands on unknown ids are no-ops; `forward_add` validates ports/host; no command returns secret material.
- **Forwarding** ([forward.rs](src-tauri/src/session/forward.rs)): listeners bind `127.0.0.1` only; cancellation tears down listener + tunneled connections (verified: port closed after stop).
- **Frontend**: no `innerHTML` of dynamic data (the one `innerHTML = TEMPLATE` in connect-form.ts is a static constant); server-provided text (prompts, fingerprints) rendered via `textContent`; no eval; localStorage holds appearance settings only. CSP: `default-src 'self'`, scripts self-only. Capabilities ([capabilities/default.json](src-tauri/capabilities/default.json)): core defaults + dialog-open, clipboard read/write, opener — minimal.
- **Logging**: `tauri-plugin-log` registered in debug builds only; no log statement references credentials.
- **Git history**: no committed secrets, key files, or .env files (pattern scan over full history).

## Dependency scans

- `npm audit`: **0 vulnerabilities**.
- `cargo audit` (cargo-audit 0.22.2): **1 vulnerability** — F4 above. 17 warnings: GTK3/glib “unmaintained/unsound” advisories (Linux-only Tauri transitive deps, never compiled on Windows) plus `proc-macro-error`/`unic-*` unmaintained notices. No action needed for a Windows-only release.

## Quality gates (all pass after F1 fix)

`npm run typecheck` ✓ · `npm run lint` ✓ · `npm run format:check` ✓ · `cargo test` ✓ (10/10) · `cargo clippy --all-targets -- -D warnings` ✓

Unwrap/expect review: all `unwrap()` calls are on `Mutex` locks (poisoning → controlled panic) or in tests; both JSON stores tolerate corrupt/missing files by starting empty (code-verified in `KnownHostsStore::new` / `ProfileStore::new`).

## Functional QA (live, GUI-driven, against scripts/test-sshd.cjs)

| Scenario | Result |
|---|---|
| Password auth + “Save password” | ✓ connected; secret in Credential Manager only |
| Unknown host key (TOFU) | ✓ prompt with SHA-256 fingerprint; trust persisted to known_hosts.json (fingerprint matched dialog) |
| Changed host key | ✓ loud red MITM warning showing new + previously-trusted fingerprints |
| Keyboard-interactive MFA | ✓ password round auto-answered once; OTP round surfaced as dialog; connected |
| Saved-password auto-injection | ✓ reconnect with blank password succeeds; silent host-key match |
| Wrong credentials | ✓ “All configured authentication methods failed”, tab marked red, form retained |
| PTY shell + UTF-8 | ✓ 135×41 PTY, multi-byte UTF-8/CJK/emoji render correctly, echo works |
| Port forward add/traffic/stop | ✓ 127.0.0.1:9999→remote:7777 active; greeting+echo through tunnel; socket released on stop |
| Server-side drop | ✓ all live sessions flagged disconnected |
| Multiple tabs | ✓ three concurrent sessions, independent state |

Not exercised this round (covered by earlier sessions and/or unit tests, or low risk): agent auth, key-with-passphrase (present in recents from prior QA; `tests/key_decode.rs` covers decode), `.ppk` rejection (code-reviewed, friendly message), `~/.ssh/config` import (3 unit tests), copy/paste/search UI, scrollback flood.

## Release readiness

- **Artifacts**: clean `npm run build` produces `simple-ssh.exe` (standalone, ~13 MB) + `Simple SSH_1.0.0_x64-setup.exe` (NSIS per-user, ~3.3 MB).
- **Installer cycle**: silent install to `%LOCALAPPDATA%\Simple SSH` ✓ → installed app launches and shows v1.0.0 ✓ → silent uninstall removes install dir and registry entry ✓; user data in `%APPDATA%\com.simplessh.app` persists across uninstall (deliberate, documented in README).
- **Signing**: `SIGNING-INSTRUCTIONS.md` (untracked, now gitignored — contains no secrets) is **current for the Tauri flow** (two-pass: sign exe → `npx tauri bundle` → sign installer). Not executed to avoid consuming an eSigner operation.
- **Docs**: README is accurate against tested behavior, including the unsigned-build Smart App Control note and data locations. LICENSE now present.
- **Repo hygiene**: `.gitignore` change (ignore local signing notes) is correct; build outputs ignored; no secrets in history.

## Backlog (deferred, non-gating)

1. F5 theme-toggle chrome repaint (WebView2 compositor workaround needed).
2. F6 remove `sign.cjs`; if signing is automated later, use `bundle.windows.signCommand` per SIGNING-INSTRUCTIONS.
3. F4 track russh/`rsa` for a Marvin fix; document Ed25519 preference.
4. CI (GitHub Actions): lint + typecheck + cargo test on push.
5. F8 surface store write failures to the user.
6. Frontend test harness (Playwright/WebDriver) for the dialog flows now covered only manually.
