# Contributing to memoq-mcp

Thank you for your interest in contributing!

## Local Setup

1. Install **Node.js >= 22.13** and **pnpm 12**.
2. Install dependencies and run checks:
   ```bash
   pnpm install
   pnpm typecheck
   pnpm test
   ```
3. To test the packaged npm tarball end-to-end:
   ```bash
   pnpm package:memoq-mcp
   ```
4. If you modify `native/memoq-bridge-helper/*.cs` (Windows + .NET SDK):
   ```powershell
   pnpm build:memoq-helper
   ```

## Guidelines

- Keep all MCP tools aligned with strict schema validation (`z.strictObject`), concise parameter `.describe(...)` annotations, accurate `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), `AbortSignal` forwarding, and bounded/paginated outputs.
- Never commit proprietary memoQ SDK DLLs or credentials.
- Add or update unit tests in `packages/memoq-bridge/test/` or `packages/memoq-mcp/test/` for any behavioral change.
