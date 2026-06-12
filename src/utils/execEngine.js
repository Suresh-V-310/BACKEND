/* Secure Docker execution engine */

/**
 * This module exports a single Express handler `runCode` that safely executes user
 * supplied source code inside a sandboxed Docker container.
 *
 * Security measures:
 *  • Whitelisted runtimes with pinned image digests
 *  • Non‑root user inside container (`1001:1001`)
 *  • Network disabled, IPC and PID namespaces isolated
 *  • Memory, CPU, and PID limits
 *  • Read‑only filesystem mount
 *  • Per‑request unique temporary directory (auto‑removed)
 *  • Execution timeout (per‑language configurable)
 *  • Maximum output size (default 2 MiB) – excess kills container
 *  • Input validation & strict error handling
 */

const { spawn } = require('child_process');
const { mkdtemp, writeFile, rm } = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const SUPPORTED_LANGUAGES = {
  javascript: {
    // Pin exact image digest – replace with the digest you push to your registry
    image: 'online-compiler-js@sha256:3a7f8c9d5e2b1c4f6a9d0e8b7c1f2a3e4d5c6b7a8e9f0d1c2b3a4f5e6d7c8b9',
    entrypoint: ['node', '/code/index.js'],
    extension: '.js',
    timeoutMs: 10000, // 10 s for JS
    maxOutputBytes: 2 * 1024 * 1024, // 2 MiB
  },
  python: {
    image: 'online-compiler-py@sha256:9b8a7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b',
    entrypoint: ['python', '/code/main.py'],
    extension: '.py',
    timeoutMs: 15000, // 15 s for Python
    maxOutputBytes: 2 * 1024 * 1024,
  },
  // Add more runtimes here following the same schema
};

// Docker hardening options (flags will be added to the CLI args)
const DOCKER_OPTS = {
  memory: '256m',
  cpus: '0.5',
  pids: '100',
  user: '1001:1001', // non‑root inside container
  network: 'none',
  ipc: 'none',
  pid: 'none',
};

// Global fallback timeout (ms) – can be overridden via env
const GLOBAL_TIMEOUT_MS = parseInt(process.env.EXEC_TIMEOUT_MS, 10) || 15000;

/** Build `docker run` argument list safely. */
function buildDockerArgs(langConfig, workDir) {
  const args = [
    'run',
    '--rm',
    '--user', DOCKER_OPTS.user,
    '--network', DOCKER_OPTS.network,
    '--memory', DOCKER_OPTS.memory,
    '--cpus', DOCKER_OPTS.cpus,
    '--pids-limit', DOCKER_OPTS.pids,
    '--ipc', DOCKER_OPTS.ipc,
    '--pid', DOCKER_OPTS.pid,
    '--read-only',
    '--workdir', '/code',
    '--volume', `${workDir}:/code:ro`, // mount read‑only
    '--env', 'HOME=/sandbox', // internal home, not host /tmp
    langConfig.image,
    ...langConfig.entrypoint,
  ];
  return args;
}

/** Express handler – validates input, runs Docker, returns JSON result. */
async function runCode(req, res) {
  try {
    const { language, sourceCode } = req.body;

    // ---------------------------------------------------------------------
    // 1️⃣ Input validation
    // ---------------------------------------------------------------------
    if (!language || !sourceCode) {
      return res.status(400).json({ error: 'Missing language or sourceCode' });
    }
    if (!Object.prototype.hasOwnProperty.call(SUPPORTED_LANGUAGES, language)) {
      return res.status(400).json({ error: `Unsupported language: ${language}` });
    }

    const langConfig = SUPPORTED_LANGUAGES[language];
    const execTimeout = langConfig.timeoutMs || GLOBAL_TIMEOUT_MS;
    const maxOutput = langConfig.maxOutputBytes || (2 * 1024 * 1024);

    // ---------------------------------------------------------------------
    // 2️⃣ Create isolated temporary directory
    // ---------------------------------------------------------------------
    const tempDir = await mkdtemp(path.join(os.tmpdir(), `exec-${crypto.randomUUID()}-`));
    const sourcePath = path.join(tempDir, `index${langConfig.extension}`);
    await writeFile(sourcePath, sourceCode, { encoding: 'utf8' });

    // ---------------------------------------------------------------------
    // 3️⃣ Spawn Docker container
    // ---------------------------------------------------------------------
    const dockerArgs = buildDockerArgs(langConfig, tempDir);
    const child = spawn('docker', dockerArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

    // ---------------------------------------------------------------------
    // 4️⃣ Timeout handling
    // ---------------------------------------------------------------------
    const timeout = setTimeout(() => {
      child.kill('SIGKILL'); // force kill on timeout
    }, execTimeout);

    // ---------------------------------------------------------------------
    // 5️⃣ Capture output with size limiting
    // ---------------------------------------------------------------------
    let stdout = '';
    let stderr = '';
    let totalBytes = 0;

    const handleChunk = (chunk, target) => {
      totalBytes += chunk.length;
      if (totalBytes > maxOutput) {
        child.kill('SIGKILL'); // exceed limit -> abort
        return;
      }
      if (target === 'out') stdout += chunk.toString();
      else stderr += chunk.toString();
    };

    child.stdout.on('data', (data) => handleChunk(data, 'out'));
    child.stderr.on('data', (data) => handleChunk(data, 'err'));

    // ---------------------------------------------------------------------
    // 6️⃣ Process termination
    // ---------------------------------------------------------------------
    child.on('close', async (code, signal) => {
      clearTimeout(timeout);

      // Clean up temporary directory (best‑effort)
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch (e) {
        console.error('Failed to clean temp dir:', e);
      }

      // Signal‑based termination handling
      if (signal) {
        return res.status(504).json({
          error: `Execution terminated by signal ${signal}`,
          timeoutMs: execTimeout,
        });
      }

      // Normal exit – include stdout/stderr regardless of exit code
      const response = {
        exitCode: code,
        output: stdout,
        error: stderr,
      };
      // Use 200 for both success and runtime errors; client can check exitCode
      return res.status(200).json(response);
    });
  } catch (err) {
    // Avoid leaking submitted source code – log only the message
    console.error('Execution engine error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { runCode };
