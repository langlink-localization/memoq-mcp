# Security Policy

## Local-Only Architecture

- The bridge daemon binds exclusively to loopback (`127.0.0.1`).
- Control APIs require a per-instance random `Bearer` token stored in the user's local data directory.
- The local Review & QA Workbench requires a persisted random token (`/review?token=...`) and sets a restricted `HttpOnly` cookie, plus strict `Host`, `Origin`, `Sec-Fetch-Site`, and Content-Security-Policy (`CSP`) checks.

## Destructive Operations & Plugin Installation

- Clearing staged translations (`memoq_clear_staged`) and installing/uninstalling the memoQ MT plugin (`memoq_setup`) require explicit `confirmed: true` after presenting the exact scope or file paths to the user.
- Plugin DLL installation verifies SHA-256 against the pinned manifest for the public [memoq-ai-hub](https://github.com/langlink-localization/memoq-ai-hub) release, backs up `ClientDevConfig.xml` before merging `<LoadUnsignedPlugins>true</LoadUnsignedPlugins>`, and removes Zone.Identifier (MOTW) only on the verified target copy.
- Enabling `<LoadUnsignedPlugins>true</LoadUnsignedPlugins>` in memoQ allows unsigned local plugins to load; only install plugins from trusted sources and uninstall via `memoq_setup({ action: "uninstall", confirmed: true })` if you no longer need it.

## Reporting a Vulnerability

Please report security issues privately by opening a GitHub Security Advisory on `langlink-localization/memoq-mcp` rather than a public issue.
