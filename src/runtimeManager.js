import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import path from 'path';
import { RUNTIME_CAPABILITIES } from '../languages/runtimeCapabilities.js';

const execAsync = promisify(exec);

const RUNTIME_TOOLS = {
  c: ['gcc'],
  cpp: ['g++'],
  python: ['python'],
  java: ['javac', 'java'],
  javascript: ['node', 'npm'],
  typescript: ['node', 'npm', 'npx'],
  csharp: ['dotnet'],
  php: ['php'],
  go: ['go'],
  rust: ['rustc', 'cargo'],
  kotlin: ['kotlinc', 'java'],
  swift: ['swift'],
  ruby: ['ruby'],
  r: ['Rscript'],
  dart: ['dart'],
  scala: ['scala'],
  sql: ['sqlite3'],
  web: ['node'],
};

const DOCKER_LANGUAGES = Object.keys(RUNTIME_CAPABILITIES).filter(
  (language) => language !== 'web'
);

const imageTag = (lang) => `compiler/${lang}:latest`;

async function commandExists(command) {
  const probe = process.platform === 'win32' ? `where ${command}` : `command -v ${command}`;
  try {
    const { stdout } = await execAsync(probe);
    return Boolean(stdout.trim());
  } catch {
    return false;
  }
}

async function dockerExists() {
  return commandExists('docker');
}

async function dockerImageExists(tag) {
  if (!(await dockerExists())) return false;
  try {
    const { stdout } = await execAsync(`docker images -q ${tag}`);
    return Boolean(stdout.trim());
  } catch {
    return false;
  }
}

async function localToolStatus(language) {
  const tools = RUNTIME_TOOLS[language] || [];
  const checks = await Promise.all(tools.map(async (tool) => [tool, await commandExists(tool)]));
  const missing = checks.filter(([, ok]) => !ok).map(([tool]) => tool);
  return {
    tools: Object.fromEntries(checks),
    localReady: tools.length > 0 && missing.length === 0,
    missing,
  };
}

/**
 * Build missing Docker images when Docker is available and a docker/<language> folder exists.
 */
export async function initializeRuntimes() {
  console.log('Initializing language runtimes...');

  // STEP 5 — DEPLOYMENT VALIDATION
  console.log('[JAVA] Checking runtime...');
  try {
    await execAsync('java -version');
    console.log('[JAVA] OpenJDK detected');
  } catch (err) {
    console.error('[JAVA] java executable not found or failed to run! Failing startup.');
    process.exit(1);
  }

  try {
    await execAsync('javac -version');
    console.log('[JAVA] javac detected');
  } catch (err) {
    console.error('[JAVA] javac compiler not found or failed to run! Failing startup.');
    process.exit(1);
  }

  if (!(await dockerExists())) {
    console.warn('Docker is not installed or not on PATH; skipping container image builds.');
    return;
  }

  for (const lang of DOCKER_LANGUAGES) {
    const dockerDir = path.resolve(process.cwd(), '..', 'docker', lang);
    if (!existsSync(dockerDir)) {
      console.warn(`No Dockerfile found for ${lang}; skipping ${imageTag(lang)}.`);
      continue;
    }

    const tag = imageTag(lang);
    if (await dockerImageExists(tag)) {
      console.log(`${lang} runtime already present.`);
      continue;
    }

    console.log(`Building Docker image for ${lang}...`);
    try {
      await execAsync(`docker build -t ${tag} ${dockerDir}`, { timeout: 15 * 60 * 1000 });
      console.log(`Built ${tag}`);
    } catch (buildErr) {
      console.error(`Failed to build ${lang} image:`, buildErr.message);
    }
  }
  console.log('Runtime initialization complete.');
}

/**
 * Get a status map for the frontend/API.
 */
export async function getRuntimeStatus() {
  const dockerAvailable = await dockerExists();
  const status = {};

  for (const lang of DOCKER_LANGUAGES) {
    const local = await localToolStatus(lang);
    const tag = imageTag(lang);
    const dockerReady = dockerAvailable ? await dockerImageExists(tag) : false;
    status[lang] = {
      ...local,
      dockerAvailable,
      dockerImage: tag,
      dockerReady,
      ready: local.localReady || dockerReady,
      capabilities: RUNTIME_CAPABILITIES[lang],
    };
  }

  return status;
}

/**
 * Ensure a specific language image exists before execution.
 */
export async function ensureRuntime(lang) {
  if (!(await dockerExists())) {
    throw new Error('Docker is not installed or not available on PATH.');
  }

  const dockerDir = path.resolve(process.cwd(), '..', 'docker', lang);
  if (!existsSync(dockerDir)) {
    throw new Error(`No Docker runtime definition exists for ${lang}.`);
  }

  const tag = imageTag(lang);
  if (!(await dockerImageExists(tag))) {
    await execAsync(`docker build -t ${tag} ${dockerDir}`, { timeout: 15 * 60 * 1000 });
  }
}
