/**
 * Unified compile/run pipeline: host → Docker → Judge0.
 * Judge0 always receives raw user source (no local-only preprocess bootstrap).
 */
import { getLanguageByKey } from '../languages/index.js';
import { dockerRunCode, dockerRunProject, shouldAttemptDockerFallback } from './dockerExecution.js';

/**
 * @typedef {object} RunResult
 * @property {boolean} success
 * @property {string} [stdout]
 * @property {string} [stderr]
 * @property {string} [error]
 * @property {string} [runner]
 * @property {string} [warning]
 */

/**
 * Inject dependencies from executionService to avoid circular imports.
 */
let deps = null;

export function configureExecutionRouter(implementation) {
  deps = implementation;
}

function assertDeps() {
  if (!deps) {
    throw new Error('Execution router is not configured');
  }
}

const PROJECT_ONLY_LANGUAGES = new Set(['java', 'c', 'cpp']);

/**
 * Whether the payload must use the multi-file project runner.
 */
export function isMultiFileProject(language, projectFiles) {
  if (!projectFiles?.length) return false;
  if (projectFiles.length > 1) return true;
  if (PROJECT_ONLY_LANGUAGES.has(language)) {
    const file = projectFiles[0];
    const normalized = file.path.replace(/\\/g, '/');
    if (language === 'java' && normalized.includes('/')) return true;
    if ((language === 'c' || language === 'cpp') && normalized.startsWith('src/')) return true;
  }
  return false;
}

/**
 * Extract primary source from a single-file project tab.
 */
export function extractPrimarySource(projectFiles, language) {
  if (!projectFiles?.length) return '';
  const entryPath = deps.findProjectEntry(projectFiles, language);
  const entry = projectFiles.find((f) => f.path === entryPath) || projectFiles[0];
  return String(entry.content ?? '');
}

/**
 * Run a single source file with host → Docker → Judge0 fallbacks.
 */
export async function runSingleFileWithFallbacks(language, rawSource, stdin = '') {
  assertDeps();
  const langConfig = getLanguageByKey(language);
  const source = rawSource || '';
  const preprocessed = deps.preprocessCode(language, source);
  const sourceFile = deps.getSourceFileName(language);
  const attempts = [];

  // In production, force remote Judge0 execution for safety, isolation, and library support (numpy, pandas, etc.)
  // Except for Python, which runs on the host using the local venv packages.
  const isProduction = process.env.NODE_ENV === 'production';
  const runners = isProduction
    ? (language === 'python' ? ['host', 'judge0'] : ['judge0'])
    : ['host', 'docker', 'judge0'];

  for (const runner of runners) {
    if (runner === 'host') {
      const hostResult = await deps.hostRunCode(language, preprocessed, stdin);
      attempts.push(hostResult);
      if (hostResult.success) {
        return { ...hostResult, runner: 'host' };
      }
      if (!shouldAttemptDockerFallback(language, hostResult.stderr, hostResult.error)) {
        continue;
      }
    }

    if (runner === 'docker') {
      try {
        const dockerResult = await dockerRunCode(language, preprocessed, stdin, sourceFile);
        attempts.push(dockerResult);
        if (dockerResult.success) {
          return {
            ...dockerResult,
            warning: attempts.some((a) => !a.success)
              ? 'Executed in Docker container (local toolchain unavailable).'
              : undefined,
          };
        }
      } catch (dockerErr) {
        attempts.push({
          success: false,
          stderr: dockerErr.message,
          error: dockerErr.message,
          runner: 'docker',
        });
      }
    }

    if (runner === 'judge0' && langConfig?.id) {
      try {
        const judgeResult = await deps.judge0RunCode(langConfig, source, stdin);
        attempts.push(judgeResult);
        if (judgeResult.success) {
          return {
            ...judgeResult,
            runner: 'judge0',
            warning: attempts.length > 1 ? 'Ran on Judge0 CE (remote sandbox).' : undefined,
          };
        }
      } catch (judgeErr) {
        attempts.push({
          success: false,
          stderr: judgeErr.message,
          error: judgeErr.message,
          runner: 'judge0',
        });
      }
    }
  }

  const best = pickBestFailure(attempts);
  return {
    ...best,
    diagnostics: buildDiagnostics(attempts),
  };
}

/**
 * Multi-file project: host project runner → Docker project → single-file Judge0 (main entry only).
 */
export async function runProjectWithFallbacks(language, code, files, stdin = '') {
  assertDeps();
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction && language !== 'python') {
    const projectFiles = deps.normalizeProjectFiles(files, code);
    if (projectFiles.length === 1) {
      const primary = extractPrimarySource(projectFiles, language);
      return await runSingleFileWithFallbacks(language, primary, stdin);
    }
    return {
      success: false,
      stderr: 'Multi-file compilation is not supported in production sandbox.',
      error: 'Unsupported Execution Mode',
    };
  }

  const projectFiles = deps.normalizeProjectFiles(files, code);
  const hostResult = await deps.hostRunProject(language, code, files, stdin);
  if (hostResult.success) {
    return { ...hostResult, runner: 'host' };
  }

  if (shouldAttemptDockerFallback(language, hostResult.stderr, hostResult.error)) {
    try {
      const dockerResult = await dockerRunProject(language, projectFiles, stdin, {
        findProjectEntry: deps.findProjectEntry,
      });
      if (dockerResult.success) {
        return {
          ...dockerResult,
          warning: 'Local project toolchain unavailable; ran in Docker.',
        };
      }
    } catch (dockerErr) {
      hostResult.diagnostics = [
        ...(hostResult.diagnostics || []),
        { message: `Docker project fallback failed: ${dockerErr.message}` },
      ];
    }
  }

  if (projectFiles.length === 1) {
    const primary = extractPrimarySource(projectFiles, language);
    const single = await runSingleFileWithFallbacks(language, primary, stdin);
    if (single.success) {
      return {
        ...single,
        warning: 'Project runner failed; executed main file via single-file pipeline.',
      };
    }
  }

  return {
    ...hostResult,
    runner: hostResult.runner || 'host',
    diagnostics: [
      ...(hostResult.diagnostics || []),
      {
        message:
          'Install the language SDK locally, install Docker and run npm run runtimes:docker, or configure JUDGE0_API_URL.',
      },
    ],
  };
}

function pickBestFailure(attempts) {
  const failed = attempts.filter((a) => a && !a.success);
  if (!failed.length) {
    return {
      success: false,
      stdout: '',
      stderr: 'Execution failed with no runner available.',
      error: 'Execution failed',
    };
  }
  return failed.sort((a, b) => (b.stderr?.length || 0) - (a.stderr?.length || 0))[0];
}

function buildDiagnostics(attempts) {
  return attempts
    .filter((a) => a && !a.success)
    .map((a) => ({
      runner: a.runner || 'unknown',
      message: a.error || a.stderr?.split('\n')[0] || 'Runner failed',
    }));
}
