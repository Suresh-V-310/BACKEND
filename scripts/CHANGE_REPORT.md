# Execution Engine Fix — Change Report

Generated: 2026-06-01

## Root cause

The UI opens most languages as **single-file project tabs** and always sent `files: { "main.go": "..." }` to `/api/compiler/run`.

The backend treated **any `files` payload** as a multi-file project and called `hostRunProject()`, which:

- Skipped **Judge0** entirely
- Required **local SDKs** (go, php, rustc, g++, etc.) on the host
- Failed on Windows when those tools were not installed

Only **C** (special path + Judge0), **Java** (dedicated `runJavaProject`), and **Python** (often had local `python`) appeared to work.

## Solution

1. **`server/src/executionRouter.js`** — unified pipeline: **host → Docker → Judge0**
2. **Single-file projects** use `runSingleFileWithFallbacks()` (Judge0 receives **raw** source, not Python/JS preprocess bootstrap)
3. **True multi-file projects** use `runProjectWithFallbacks()` with Docker project support
4. **Frontend** sends `files` only when `fileCount > 1`
5. **Clearer output** — runner name, warnings, diagnostics in the console panel

## Files modified (this fix)

| File | Change |
|------|--------|
| `server/src/executionRouter.js` | **New** — fallback execution router |
| `server/src/dockerExecution.js` | `dockerRunProject`, broader Docker fallback detection, C++17 in containers |
| `server/src/services/executionService.js` | Route through router; Python `py -3` on Windows; `runner` metadata |
| `client/src/features/compiler/hooks/useRunCode.js` | Only send `files` for multi-file projects |
| `client/src/features/languages/languageMeta.js` | Added `mern` metadata |
| `client/src/features/compiler/utils/formatOutput.js` | Show runner / warning / diagnostics |
| `scripts/verify-all-languages.js` | Simulates UI project file payloads |
| `scripts/CHANGE_REPORT.md` | This report |

## Verification

```bash
npm run runtimes:verify
```

With UI-like payloads: **20/20 passed** (see `scripts/verification-report.json`).

## Remaining environment notes

- **Docker** optional but recommended for offline/native SDK execution
- **Judge0 CE** (`JUDGE0_API_URL`) used when local/Docker unavailable
- **iOS-only Swift frameworks** remain stubbed on Linux containers
- **Full Flutter SDK** not bundled; Dart runs, Flutter imports stubbed
