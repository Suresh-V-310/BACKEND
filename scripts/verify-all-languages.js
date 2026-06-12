import { writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { LANGUAGES } from '../server/languages/index.js';
import { localRunCode } from '../server/src/services/executionService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const SKIP_DOCKER_ONLY = new Set(['web']);

/** Mirrors client EditorContext PROJECT_MAIN_FILES (UI sends `files` for these). */
const UI_PROJECT_FILES = {
  c: { 'src/main.c': null },
  cpp: { 'src/main.cpp': null },
  java: { 'src/main/java/Main.java': null },
  python: { 'main.py': null },
  javascript: { 'index.js': null },
  typescript: { 'index.ts': null },
  csharp: { 'Program.cs': null },
  php: { 'index.php': null },
  go: { 'main.go': null },
  rust: { 'src/main.rs': null },
  kotlin: { 'Main.kt': null },
  ruby: { 'main.rb': null },
  r: { 'main.R': null },
  dart: { 'bin/main.dart': null },
  scala: { 'Main.scala': null },
  sql: { 'script.sql': null },
};

const results = [];

async function verifyLanguage(key) {
  const lang = LANGUAGES[key];
  if (!lang) {
    return { key, name: key, ok: false, error: 'Not registered' };
  }

  const uiFiles = UI_PROJECT_FILES[key];
  const payload = uiFiles
    ? {
        language: key,
        code: lang.defaultCode,
        files: Object.fromEntries(
          Object.keys(uiFiles).map((path) => [path, lang.defaultCode])
        ),
      }
    : { language: key, code: lang.defaultCode };

  if (SKIP_DOCKER_ONLY.has(key)) {
    const result = await localRunCode(payload);
    return {
      key,
      name: lang.name,
      ok: result.success,
      runner: result.runner || 'preview',
      stdout: (result.stdout || '').trim().slice(0, 200),
      stderr: (result.stderr || '').trim().slice(0, 200),
    };
  }

  const started = Date.now();
  try {
    const result = await localRunCode(payload);
    return {
      key,
      name: lang.name,
      ok: Boolean(result.success),
      ms: Date.now() - started,
      runner: result.runner,
      warning: result.warning,
      stdout: (result.stdout || '').trim().slice(0, 200),
      stderr: (result.stderr || result.error || '').trim().slice(0, 200),
    };
  } catch (err) {
    return {
      key,
      name: lang.name,
      ok: false,
      ms: Date.now() - started,
      error: err.message,
    };
  }
}

async function main() {
  console.log('Verifying all registered languages...\n');
  const keys = Object.keys(LANGUAGES);
  for (const key of keys) {
    process.stdout.write(`  ${key} ... `);
    const row = await verifyLanguage(key);
    results.push(row);
    console.log(row.ok ? `OK (${row.runner || 'host'})` : `FAIL`);
  }

  const reportPath = path.join(root, 'scripts', 'verification-report.json');
  writeFileSync(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${passed}/${results.length} passed`);
  if (failed.length) {
    console.log('Failures:', failed.map((f) => f.key).join(', '));
    process.exitCode = 1;
  }
  console.log(`Report: ${reportPath}`);
}

main();
