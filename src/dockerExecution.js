import { exec } from 'child_process';
import { mkdtemp, writeFile, rm, mkdir } from 'fs/promises';
import os from 'os';
import path from 'path';
import { ensureRuntime } from './runtimeManager.js';

const imageTag = (lang) => `compiler/${lang}:latest`;

function dockerVolumePath(hostPath) {
  if (process.platform === 'win32') {
    return hostPath.replace(/\\/g, '/');
  }
  return hostPath;
}

/**
 * Inner shell command executed inside the language container.
 */
export function getDockerInnerCommand(language, sourceFile) {
  const src = sourceFile.replace(/'/g, "'\\''");
  switch (language) {
    case 'python':
      return `python '${src}'`;
    case 'javascript':
      return `node '${src}'`;
    case 'typescript':
      return `npx ts-node '${src}'`;
    case 'java':
      return `javac '${src}' && java -cp . Main`;
    case 'c':
      return `gcc -std=c17 -Wall -Wextra -O2 -pthread '${src}' -o main -lm -pthread && ./main`;
    case 'cpp':
      return `g++ -std=c++17 -Wall -Wextra -O2 -pthread '${src}' -o main -lm -pthread && ./main`;
    case 'go':
      return `go run '${src}'`;
    case 'rust':
      return `rustc '${src}' -o main && ./main`;
    case 'php':
      return `php '${src}'`;
    case 'ruby':
      return `ruby '${src}'`;
    case 'kotlin':
      return `kotlinc '${src}' -include-runtime -d main.jar && java -jar main.jar`;
    case 'swift':
      return `swift '${src}'`;
    case 'csharp':
      return `dotnet new console -o /tmp/csrun --force >/dev/null 2>&1 && cp '${src}' /tmp/csrun/Program.cs && dotnet run --project /tmp/csrun --nologo`;
    case 'r':
      return `Rscript '${src}'`;
    case 'matlab':
      return `octave --no-gui --quiet '${src}'`;
    case 'dart':
      return `dart '${src}'`;
    case 'scala':
      return `scala '${src}'`;
    case 'sql':
      return `sqlite3 :memory: ".headers on" ".mode list" ".separator |" ".read ${src}"`;
    case 'web':
      return `node -e "console.log('Web preview runs in the browser panel.')"`;
    default:
      throw new Error(`No Docker command mapping for ${language}`);
  }
}

function isDockerUnavailableError(message = '') {
  const lower = message.toLowerCase();
  return (
    lower.includes('docker') &&
    (lower.includes('not found') ||
      lower.includes('not recognized') ||
      lower.includes('cannot connect') ||
      lower.includes('daemon'))
  );
}

function isLocalToolMissingError(stderr = '', message = '') {
  const text = `${stderr}\n${message}`.toLowerCase();
  return (
    text.includes('not recognized') ||
    text.includes('not found') ||
    text.includes('no such file') ||
    text.includes('command not found') ||
    text.includes('is not recognized as an internal or external command')
  );
}

/**
 * Run preprocessed source inside an isolated compiler/<language> container.
 */
export async function dockerRunCode(language, code, stdin = '', sourceFile = 'main.txt') {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), `docker-${language}-`));
  const filePath = path.join(tmpDir, sourceFile);

  try {
    await writeFile(filePath, code, 'utf8');
    await ensureRuntime(language);

    const inner = getDockerInnerCommand(language, sourceFile);
    const mount = dockerVolumePath(tmpDir);
    const dockerCmd =
      `docker run --rm -i --network none --memory 768m --cpus 1 ` +
      `-v "${mount}:/workspace" -w /workspace ${imageTag(language)} ` +
      `sh -lc ${JSON.stringify(inner)}`;

    const { stdout, stderr } = await new Promise((resolve, reject) => {
      const child = exec(
        dockerCmd,
        { timeout: 60000, maxBuffer: 4 * 1024 * 1024, shell: true },
        (error, out, err) => {
          if (error) {
            error.stdout = out;
            error.stderr = err;
            reject(error);
          } else {
            resolve({ stdout: out, stderr: err });
          }
        }
      );
      if (stdin) child.stdin.write(stdin);
      child.stdin.end();
    });

    return {
      success: true,
      stdout: stdout || '',
      stderr: stderr || '',
      runner: 'docker',
      dockerImage: imageTag(language),
    };
  } catch (err) {
    if (isDockerUnavailableError(err.message)) {
      throw err;
    }
    const stderr = err.stderr || err.message || '';
    const stdout = err.stdout || '';
    return {
      success: false,
      stdout,
      stderr,
      error: stderr.split('\n')[0] || 'Docker execution failed',
      runner: 'docker',
      dockerImage: imageTag(language),
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function shouldAttemptDockerFallback(language, stderr = '', message = '') {
  if (['web'].includes(language)) return false;
  const text = `${stderr}\n${message}`.toLowerCase();
  if (isLocalToolMissingError(stderr, message)) return true;
  if (
    text.includes('enoent') ||
    text.includes('failed to spawn') ||
    text.includes('exit code 9009') ||
    text.includes('exit code 127') ||
    text.includes('cannot run program') ||
    text.includes('not installed')
  ) {
    return true;
  }
  return false;
}

function hasProjectFile(projectFiles, filePath) {
  return projectFiles.some((file) => file.path.replace(/\\/g, '/') === filePath);
}

function getDockerProjectInnerCommand(language, entryPath, projectFiles) {
  const entry = entryPath.replace(/\\/g, '/');
  const q = (p) => `'${String(p).replace(/'/g, "'\\''")}'`;
  switch (language) {
    case 'python':
      return `python ${q(entry)}`;
    case 'javascript':
      return `node ${q(entry)}`;
    case 'typescript':
      return `npx ts-node ${q(entry)}`;
    case 'cpp':
      return `g++ -std=c++17 -Wall -Wextra -O2 -pthread ${q(entry)} -o main -lm -pthread && ./main`;
    case 'go':
      return hasProjectFile(projectFiles, 'go.mod') ? 'go run .' : `go run ${q(entry)}`;
    case 'rust':
      return hasProjectFile(projectFiles, 'Cargo.toml') ? 'cargo run --quiet' : `rustc ${q(entry)} -o main && ./main`;
    case 'php':
      return `php ${q(entry)}`;
    case 'ruby':
      return `ruby ${q(entry)}`;
    case 'kotlin':
      return `kotlinc ${q(entry)} -include-runtime -d main.jar && java -jar main.jar`;
    case 'swift':
      return `swift ${q(entry)}`;
    case 'csharp':
      return projectFiles.some((f) => f.path.endsWith('.csproj'))
        ? 'dotnet run'
        : `dotnet new console -o /tmp/csrun --force >/dev/null 2>&1 && cp ${q(entry)} /tmp/csrun/Program.cs && dotnet run --project /tmp/csrun --nologo`;
    case 'r':
      return `Rscript ${q(entry)}`;
    case 'dart':
      return `dart ${q(entry)}`;
    case 'scala':
      return hasProjectFile(projectFiles, 'build.sbt') ? 'sbt run' : `scala ${q(entry)}`;
    case 'sql': {
      const sqlPath = entry.startsWith('/') ? entry.slice(1) : entry;
      return `sqlite3 :memory: ".headers on" ".mode list" ".separator |" ".read ${sqlPath}"`;
    }
    default:
      return `sh -lc 'echo Unsupported project language: ${language}'`;
  }
}

/**
 * Run a multi-file project inside a language container.
 */
export async function dockerRunProject(language, projectFiles, stdin, { findProjectEntry }) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), `docker-${language}-project-`));

  try {
    for (const file of projectFiles) {
      const filePath = path.join(tmpDir, file.path.replace(/\\/g, '/'));
      await mkdir(path.dirname(filePath), { recursive: true });
      const payload = file.encoding
        ? Buffer.from(file.content, file.encoding)
        : file.content;
      await writeFile(filePath, payload);
    }

    await ensureRuntime(language);
    const entryPath = findProjectEntry(projectFiles, language);
    const inner = getDockerProjectInnerCommand(language, entryPath, projectFiles);

    const mount = dockerVolumePath(tmpDir);
    const dockerCmd =
      `docker run --rm -i --network none --memory 768m --cpus 1 ` +
      `-v "${mount}:/workspace" -w /workspace ${imageTag(language)} ` +
      `sh -lc ${JSON.stringify(inner)}`;

    const { stdout, stderr } = await new Promise((resolve, reject) => {
      const child = exec(
        dockerCmd,
        { timeout: 120000, maxBuffer: 4 * 1024 * 1024, shell: true },
        (error, out, err) => {
          if (error) {
            error.stdout = out;
            error.stderr = err;
            reject(error);
          } else {
            resolve({ stdout: out, stderr: err });
          }
        }
      );
      if (stdin) child.stdin.write(stdin);
      child.stdin.end();
    });

    return {
      success: true,
      stdout: stdout || '',
      stderr: stderr || '',
      runner: 'docker',
      dockerImage: imageTag(language),
    };
  } catch (err) {
    const stderr = err.stderr || err.message || '';
    const stdout = err.stdout || '';
    return {
      success: false,
      stdout,
      stderr,
      error: stderr.split('\n')[0] || 'Docker project execution failed',
      runner: 'docker',
      dockerImage: imageTag(language),
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
