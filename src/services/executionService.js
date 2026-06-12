import { exec, spawn } from 'child_process';
import { mkdtemp, writeFile, readFile, rm, mkdir, readdir, copyFile } from 'fs/promises';
import { existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { getLanguageByKey } from '../../languages/index.js';
import { dockerRunCode, shouldAttemptDockerFallback } from '../dockerExecution.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, '..', '..');
import {
  configureExecutionRouter,
  runSingleFileWithFallbacks,
  runProjectWithFallbacks,
  isMultiFileProject,
  extractPrimarySource,
} from '../executionRouter.js';

const JAVA_IDENTIFIER = '[A-Za-z_$][A-Za-z0-9_$]*';
const JAVA_PACKAGE_RE = new RegExp(`^${JAVA_IDENTIFIER}(?:\\.${JAVA_IDENTIFIER})*$`);
const JAVA_KEYWORDS = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char',
  'class', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum',
  'extends', 'final', 'finally', 'float', 'for', 'goto', 'if', 'implements',
  'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new',
  'package', 'private', 'protected', 'public', 'return', 'short', 'static',
  'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws',
  'transient', 'try', 'void', 'volatile', 'while', 'record', 'sealed',
  'permits', 'non-sealed', 'var', 'yield'
]);
const C_STANDARDS = new Set(['c11', 'c17', 'c23']);
const C_SOURCE_EXTENSIONS = new Set(['.c']);
const C_HEADER_EXTENSIONS = new Set(['.h']);
const C_STATIC_LIBRARY_EXTENSIONS = new Set(['.a', '.lib']);
const C_DYNAMIC_LIBRARY_EXTENSIONS = new Set(['.so', '.dll', '.dylib']);
const C_COMPILER_FLAGS = ['-Wall', '-Wextra', '-O2', '-pthread'];
const C_LINKER_FLAGS = ['-lm', '-pthread'];

function execCommand(cmd, options = {}) {
  return new Promise((resolve, reject) => {
    const child = exec(
      cmd,
      {
        timeout: 30000,
        maxBuffer: 4 * 1024 * 1024,
        shell: true,
        ...options,
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
        } else {
          resolve({ stdout, stderr });
        }
      }
    );

    if (options.stdin) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

function quotePath(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function javaArgFilePath(value) {
  return `"${String(value).replace(/\\/g, '/').replace(/"/g, '\\"')}"`;
}

function shellPath(value) {
  return quotePath(String(value));
}

const PROJECT_ENTRYPOINTS = {
  python: ['main.py', 'app.py'],
  javascript: ['main.js', 'index.js', 'server.js'],
  typescript: ['main.ts', 'index.ts', 'server.ts'],
  cpp: ['main.cpp', 'src/main.cpp'],
  csharp: ['Program.cs'],
  php: ['main.php', 'index.php'],
  go: ['main.go'],
  rust: ['src/main.rs', 'main.rs'],
  kotlin: ['Main.kt', 'src/main/kotlin/Main.kt'],
  swift: ['main.swift'],
  ruby: ['main.rb', 'app.rb'],
  r: ['main.R', 'main.r'],
  dart: ['main.dart', 'bin/main.dart'],
  scala: ['Main.scala', 'src/main/scala/Main.scala'],
  sql: ['script.sql', 'main.sql'],
};

function hasProjectFile(projectFiles, filePath) {
  return projectFiles.some(file => file.path.replace(/\\/g, '/') === filePath);
}

function findProjectEntry(projectFiles, language) {
  const candidates = PROJECT_ENTRYPOINTS[language] || [getSourceFileName(language)];
  const normalized = projectFiles.map(file => file.path.replace(/\\/g, '/'));
  for (const candidate of candidates) {
    const index = normalized.indexOf(candidate);
    if (index >= 0) return projectFiles[index].path;
  }
  const extension = getSourceFileName(language).split('.').pop();
  const fallback = projectFiles.find(file => file.path.replace(/\\/g, '/').endsWith(`.${extension}`));
  return fallback?.path || candidates[0];
}

function getProjectInstallCommands(language, projectFiles) {
  const commands = [];
  if (['javascript', 'typescript'].includes(language) && hasProjectFile(projectFiles, 'package.json')) {
    commands.push('npm install');
  }
  if (language === 'python' && hasProjectFile(projectFiles, 'requirements.txt')) {
    commands.push(`${quotePath(getPythonExecutable())} -m pip install --disable-pip-version-check -r requirements.txt -t .python-packages`);
  }
  if (language === 'go' && hasProjectFile(projectFiles, 'go.mod')) {
    commands.push('go mod download');
  }
  if (language === 'rust' && hasProjectFile(projectFiles, 'Cargo.toml')) {
    commands.push('cargo fetch');
  }
  if (language === 'php' && hasProjectFile(projectFiles, 'composer.json')) {
    commands.push('composer install --no-interaction');
  }
  if (language === 'ruby' && hasProjectFile(projectFiles, 'Gemfile')) {
    commands.push('bundle install');
  }
  if (language === 'dart' && hasProjectFile(projectFiles, 'pubspec.yaml')) {
    commands.push('dart pub get');
  }
  if (language === 'scala' && (hasProjectFile(projectFiles, 'build.sbt') || hasProjectFile(projectFiles, 'project/build.properties'))) {
    commands.push('sbt update');
  }
  if (language === 'csharp' && projectFiles.some(file => file.path.endsWith('.csproj'))) {
    commands.push('dotnet restore');
  }
  return commands;
}

async function runProjectInstallCommands(language, projectFiles, cwd) {
  const commands = getProjectInstallCommands(language, projectFiles);
  const output = [];
  for (const command of commands) {
    const result = await execCommand(command, {
      cwd,
      stdin: '',
      timeout: 120000,
      env: {
        ...process.env,
        PYTHONPATH: path.join(cwd, '.python-packages'),
        NODE_PATH: path.join(cwd, 'node_modules'),
      },
    });
    output.push(result.stderr || result.stdout || '');
  }
  return output.join('\n');
}

function getProjectRunCommand(language, entryPath, cwd, projectFiles) {
  const entry = path.join(cwd, assertSafeProjectPath(entryPath));
  return buildRunCommand(language, entryPath, cwd, projectFiles);
}

export async function hostRunProject(language, code, files, stdin) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), `${language}-project-`));
  const requestId = Date.now();
  try {
    const projectFiles = normalizeProjectFiles(files, code);
    if (projectFiles.length === 0) {
      throw new Error('No project files were provided.');
    }
    const entryPath = findProjectEntry(projectFiles, language);
    for (const file of projectFiles) {
      let content = file.content;
      if (language === 'python' && file.path === entryPath) {
        content = preprocessPython(content);
      }
      await writeProjectFile(tmpDir, file.path, file.encoding ? { content, encoding: file.encoding } : content);
    }
    const installOutput = await runProjectInstallCommands(language, projectFiles, tmpDir);

    let stdout = '';
    let stderr = '';

    if (language === 'python') {
      const pythonPath = getPythonExecutable();
      console.log("[PYTHON PATH USED]:", pythonPath);
      const command = `"${pythonPath}" "${entryPath}"`;

      try {
        const result = await new Promise((resolve, reject) => {
          const child = spawn(pythonPath, [entryPath], {
            cwd: tmpDir,
            env: {
              ...process.env,
              PYTHONPATH: [path.join(tmpDir, '.python-packages'), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
              NODE_PATH: [path.join(tmpDir, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
              PYTHONIOENCODING: 'utf-8',
              MPLBACKEND: 'Agg',
            }
          });

          child.on("error", (err) => {
            logExecutionError("CHILD_PROCESS_ERROR", err, { requestId, command });
          });

          child.on("exit", (codeVal) => {
            if (codeVal !== 0 && codeVal !== null) {
              logExecutionError("PROCESS_EXIT_FAILURE", new Error("Non-zero exit"), { requestId, code: codeVal });
            }
          });

          const stdoutChunks = [];
          const stderrChunks = [];
          let totalBytes = 0;
          const maxOutputBytes = 4 * 1024 * 1024;
          let killed = false;

          child.stdout.on('data', (chunk) => {
            totalBytes += chunk.length;
            if (totalBytes > maxOutputBytes) {
              killed = true;
              child.kill('SIGKILL');
              return;
            }
            stdoutChunks.push(chunk);
          });

          child.stderr.on('data', (chunk) => {
            totalBytes += chunk.length;
            if (totalBytes > maxOutputBytes) {
              killed = true;
              child.kill('SIGKILL');
              return;
            }
            stderrChunks.push(chunk);
          });

          if (stdin) {
            child.stdin.write(stdin);
          }
          child.stdin.end();

          const timeout = setTimeout(() => {
            killed = true;
            child.kill('SIGKILL');
          }, 15000);

          child.on('close', (codeVal, signalVal) => {
            clearTimeout(timeout);
            const out = Buffer.concat(stdoutChunks).toString('utf8');
            const errStr = Buffer.concat(stderrChunks).toString('utf8');

            if (killed) {
              const error = new Error('Execution timed out (15s limit).');
              error.killed = true;
              error.stdout = out;
              error.stderr = errStr;
              reject(error);
            } else if (codeVal !== 0 || signalVal) {
              const error = new Error(errStr || `Process exited with code ${codeVal}`);
              error.code = codeVal;
              error.signal = signalVal;
              error.stdout = out;
              error.stderr = errStr;
              reject(error);
            } else {
              resolve({ stdout: out, stderr: errStr });
            }
          });
        });
        stdout = result.stdout;
        stderr = result.stderr;
      } catch (err) {
        logExecutionError("PYTHON_EXECUTION", err, {
          requestId,
          pythonPath,
          command,
          filePath: entryPath,
          cwd: process.cwd()
        });

        // 8. FAILURE HANDLING: If pandas missing
        const isPandasMissing = (err.stderr || err.message || '').includes("No module named 'pandas'");
        if (isPandasMissing) {
          const pipPath = pythonPath.replace(/python3$/, 'pip').replace(/python\.exe$/, 'pip.exe').replace(/python$/, 'pip');
          console.error("====== PANDAS MODULE MISSING ======");
          console.error("pythonPath:", pythonPath);
          console.error("pipPath:", pipPath);
          const reqPath = path.resolve(backendRoot, 'requirements.txt');
          console.error("requirementsPath:", reqPath);
          if (existsSync(reqPath)) {
            try {
              const reqContent = await readFile(reqPath, 'utf8');
              console.error("requirements.txt Content:\n", reqContent);
            } catch (readErr) {
              console.error("Failed to read requirements.txt:", readErr.message);
            }
          }
          console.error("===================================");
        }

        return {
          success: false,
          error: isPandasMissing ? "ModuleNotFoundError: No module named 'pandas'. Ensure it is installed in Render virtual environment." : (err.message || 'Execution failed'),
          stderr: err.stderr || err.message || '',
          stdout: err.stdout || '',
          debug: {
            pythonPath,
            command,
            cwd: process.cwd()
          }
        };
      }
    } else {
      const cmd = getProjectRunCommand(language, entryPath, tmpDir, projectFiles);
      const execRes = await execCommand(cmd, {
        cwd: tmpDir,
        stdin,
        timeout: 15000,
        env: {
          ...process.env,
          PYTHONPATH: [path.join(tmpDir, '.python-packages'), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
          NODE_PATH: [path.join(tmpDir, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
        },
      });
      stdout = execRes.stdout;
      stderr = execRes.stderr;
    }

    let image = null;
    if (language === 'python') {
      image = await detectAndReadImage(tmpDir);
    }

    return {
      success: true,
      stdout: stdout || '',
      stderr: filterWarnings(stderr || ''),
      packageInstallOutput: filterWarnings(installOutput),
      ...(image ? { image } : {}),
    };
  } catch (err) {
    const stderr = filterWarnings(err.stderr || err.message || '');
    const failure = describeProcessFailure(err, stderr);
    return {
      success: false,
      stdout: err.stdout || '',
      stderr: failure.stderr,
      error: failure.error,
      line: parseErrorLine(failure.stderr, language),
      exitCode: typeof err.code === 'number' ? err.code : undefined,
      signal: err.signal,
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Map language key to source file name.
 */
function getSourceFileName(lang) {
  const map = {
    python: 'main.py',
    javascript: 'main.js',
    typescript: 'main.ts',
    java: 'Main.java',
    c: 'main.c',
    cpp: 'main.cpp',
    go: 'main.go',
    rust: 'main.rs',
    php: 'main.php',
    ruby: 'main.rb',
    perl: 'main.pl',
    kotlin: 'Main.kt',
    swift: 'main.swift',
    csharp: 'Program.cs',
    r: 'main.R',
    matlab: 'main.m',
    dart: 'main.dart',
    scala: 'Main.scala',
    bash: 'script.sh',
    sql: 'script.sql',
    web: 'index.html',
  };
  return map[lang] || 'main.txt';
}

/**
 * Helper to resolve the virtual environment python interpreter if it exists in the workspace.
 */
export function getPythonExecutable() {
  const pythonPath = os.platform() === 'win32'
    ? path.resolve(backendRoot, '.venv', 'Scripts', 'python.exe')
    : path.resolve(backendRoot, '.venv', 'bin', 'python3');

  console.log('[PYTHON EXEC]', pythonPath);
  return pythonPath;
}

/**
 * Structured error logger for execution failures
 */
export function logExecutionError(context, error, extra = {}) {
  console.error("========== EXECUTION ERROR ==========");
  console.error("Context:", context);
  console.error("Message:", error?.message || error);
  console.error("Stack:", error?.stack);
  console.error("Extra:", JSON.stringify(extra, null, 2));
  console.error("=====================================");
}

/**
 * Return the shell command to compile + run the given language locally.
 * Used as a fallback on the local host.
 */
function getRunCommand(lang, srcPath) {
  const dir = path.dirname(srcPath);

  switch (lang) {
    case 'python':
      return `"${getPythonExecutable()}" "${srcPath}"`;
    case 'javascript':
      return `node "${srcPath}"`;
    case 'typescript':
      const tsDir = path.dirname(srcPath);
      const tsOutputFile = path.join(tsDir, 'output.js');
      return `tsc "${srcPath}" --target es2020 --module commonjs --outDir "${tsDir}" && node "${tsOutputFile}"`;
    case 'java':
      return `javac "${srcPath}" && java -cp "${dir}" Main`;
    case 'c':
      return `gcc "${srcPath}" -o "${dir}/main" -lm -pthread && "${dir}/main"`;
    case 'cpp':
      return `g++ -std=c++17 "${srcPath}" -o "${dir}/a.exe" -lm -pthread && "${dir}/a.exe"`;
    case 'go':
      return `go run "${srcPath}"`;
    case 'rust':
      return `rustc "${srcPath}" -o "${dir}/a.exe" && "${dir}/a.exe"`;
    case 'php':
      return `php "${srcPath}"`;
    case 'ruby':
      return `ruby "${srcPath}"`;
    case 'perl':
      return `perl "${srcPath}"`;
    case 'kotlin':
      return `kotlinc "${srcPath}" -include-runtime -d "${dir}/main.jar" 2>&1 && java -jar "${dir}/main.jar"`;
    case 'swift':
      return `swift "${srcPath}"`;
    case 'csharp':
      return `csc "${srcPath}" && "${dir}/Program.exe"`;
    case 'r':
      return `Rscript "${srcPath}"`;
    case 'matlab':
      return `octave --no-gui --quiet "${srcPath}"`;
    case 'dart':
      return `dart "${srcPath}"`;
    case 'scala':
      return `scala "${srcPath}"`;
    case 'bash':
      return `bash "${srcPath}"`;
    case 'sql':
      return `sqlite3 :memory: ".headers on" ".mode list" ".separator |" ".read ${srcPath}"`;
    case 'web':
      return `node -e "console.log('Open the Web preview panel to render HTML/CSS/JS.')"`;
    default:
      throw new Error(`Unsupported language: ${lang}`);
  }
}

/**
 * Build shell command to compile and run a multi-file project.
 * Used for projects with package.json, build files, etc.
 */
function buildRunCommand(language, entryPath, cwd, projectFiles) {
  const isWindows = os.platform() === 'win32';
  const normalizedEntry = String(entryPath).replace(/\\/g, '/');

  switch (language) {
    case 'python': {
      const pythonExe = getPythonExecutable();
      return `"${pythonExe}" "${normalizedEntry}"`;
    }
    case 'javascript': {
      return `node "${normalizedEntry}"`;
    }
    case 'typescript': {
      const outDir = path.join(cwd, 'out');
      const tsEntry = normalizedEntry.replace(/\.ts$/, '.js');
      const jsEntry = path.join(outDir, path.basename(tsEntry));
      return `tsc --target es2020 --module commonjs --outDir "${outDir}" && node "${jsEntry}"`;
    }
    case 'java': {
      const outDir = path.join(cwd, 'out');
      return `javac -d "${outDir}" "${normalizedEntry}" && java -cp "${outDir}" Main`;
    }
    case 'cpp': {
      const outDir = path.join(cwd, 'out');
      const outExe = path.join(outDir, isWindows ? 'a.exe' : 'a');
      return `mkdir -p "${outDir}" && g++ -std=c++17 "${normalizedEntry}" -o "${outExe}" && "${outExe}"`;
    }
    case 'c': {
      const outDir = path.join(cwd, 'out');
      const outExe = path.join(outDir, isWindows ? 'main.exe' : 'main');
      return `mkdir -p "${outDir}" && gcc "${normalizedEntry}" -o "${outExe}" && "${outExe}"`;
    }
    case 'go': {
      return `go run "${normalizedEntry}"`;
    }
    case 'rust': {
      return `cargo run --manifest-path "${path.join(cwd, 'Cargo.toml')}"`;
    }
    case 'ruby': {
      return `ruby "${normalizedEntry}"`;
    }
    case 'php': {
      return `php "${normalizedEntry}"`;
    }
    case 'csharp': {
      return `dotnet run --project "${cwd}"`;
    }
    case 'kotlin': {
      const outDir = path.join(cwd, 'out');
      const jarFile = path.join(outDir, 'app.jar');
      return `mkdir -p "${outDir}" && kotlinc "${normalizedEntry}" -include-runtime -d "${jarFile}" && java -jar "${jarFile}"`;
    }
    case 'swift': {
      return `swift "${normalizedEntry}"`;
    }
    case 'dart': {
      return `dart "${normalizedEntry}"`;
    }
    case 'scala': {
      return `scala "${normalizedEntry}"`;
    }
    case 'r': {
      return `Rscript "${normalizedEntry}"`;
    }
    default: {
      return `node "${normalizedEntry}"`;
    }
  }
}

/**
 * Parse compiler / runtime error messages to extract line numbers.
 */
function parseErrorLine(stderr, lang) {
  if (!stderr) return undefined;
  const patterns = [
    // Python:  File "main.py", line 3
    /File ".*?", line (\d+)/,
    // GCC/G++:  main.c:5:10: error: ...
    /:\s*(\d+):\d+:\s*error:/,
    // Java:  Main.java:5: error: ...
    /\.java:(\d+):/,
    // Node/TS:  main.js:3
    /\.(?:js|ts):(\d+)/,
    // Go:  ./main.go:10:2:
    /\.go:(\d+):/,
    // Rust:  --> main.rs:3:5
    /-->\s*.*?:(\d+):\d+/,
    // Generic:  line 5
    /line\s+(\d+)/i,
  ];

  for (const pat of patterns) {
    const m = stderr.match(pat);
    if (m) return parseInt(m[1], 10);
  }
}

/**
 * Filter out verbose JVM/build warnings from the compiler/runtime output.
 */
function filterWarnings(text) {
  if (!text) return '';
  return text.split('\n').filter(line => {
    const trimmed = line.trim();
    if (trimmed.includes('OpenJDK 64-Bit Server VM warning') || trimmed.includes('-Xverify:none') || trimmed.includes('-noverify')) {
      return false;
    }
    if (trimmed.includes('Info: Compiling with sound null safety.')) {
      return false;
    }
    if (trimmed.startsWith('Generated: ') || trimmed.startsWith('Compiled: ') || trimmed.includes('box/main.exe') || trimmed.includes('Program.exe')) {
      return false;
    }
    if (trimmed === 'Note: Recompile with -Xlint:unchecked for details.' || trimmed === 'Note: Some input files use unchecked or unsafe operations.') {
      return false;
    }
    return true;
  }).join('\n');
}

/**
 * Run code using the sandboxed Judge0 CE API.
 */
async function judge0RunCode(langConfig, code, stdin) {
  const judge0Url = process.env.JUDGE0_API_URL || 'https://ce.judge0.com';
  
  const base64Code = Buffer.from(code).toString('base64');
  const base64Stdin = Buffer.from(stdin || '').toString('base64');

  const url = `${judge0Url}/submissions?base64_encoded=true&wait=true`;

  const headers = {
    'Content-Type': 'application/json',
  };
  if (process.env.JUDGE0_RAPIDAPI_KEY) {
    headers['X-RapidAPI-Key'] = process.env.JUDGE0_RAPIDAPI_KEY;
    headers['X-RapidAPI-Host'] = process.env.JUDGE0_RAPIDAPI_HOST || 'judge0-ce.p.rapidapi.com';
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      language_id: langConfig.id,
      source_code: base64Code,
      stdin: base64Stdin,
      ...(langConfig.judge0CompilerOptions || langConfig.compilerOptions ? { compiler_options: langConfig.judge0CompilerOptions || langConfig.compilerOptions } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(`Judge0 API returned HTTP ${response.status}: ${response.statusText}`);
  }

  const result = await response.json();

  const stdout = result.stdout ? Buffer.from(result.stdout, 'base64').toString('utf8') : '';
  const stderr = result.stderr ? Buffer.from(result.stderr, 'base64').toString('utf8') : '';
  const compileOutput = result.compile_output ? Buffer.from(result.compile_output, 'base64').toString('utf8') : '';

  const statusId = result.status?.id;
  const statusDescription = result.status?.description || 'Execution finished';

  // Extract compiler or runtime line number
  const line = parseErrorLine(compileOutput || stderr, langConfig.monaco);

  const cleanStderr = filterWarnings(stderr);
  const cleanCompileOutput = filterWarnings(compileOutput);

  // Accepted (Successful execution)
  if (statusId === 3) {
    return {
      success: true,
      stdout,
      stderr: cleanStderr,
      compileOutput: cleanCompileOutput,
      runner: 'judge0',
    };
  }

  // Time Limit Exceeded
  if (statusId === 5) {
    return {
      success: false,
      stdout,
      stderr: cleanStderr || 'Execution timed out (Time Limit Exceeded).',
      compileOutput: cleanCompileOutput,
      error: 'Time Limit Exceeded',
      line,
    };
  }

  // Compilation Error
  if (statusId === 6) {
    const firstErr = cleanCompileOutput.split('\n')[0] || 'Compilation Error';
    return {
      success: false,
      stdout,
      stderr: cleanCompileOutput,
      compileOutput: cleanCompileOutput,
      error: firstErr,
      line,
    };
  }

  // Runtime error or other failure codes
  const firstErr = cleanStderr.split('\n')[0] || statusDescription;
  return {
    success: false,
    stdout,
    stderr: cleanStderr || statusDescription,
    compileOutput: cleanCompileOutput,
    error: firstErr,
    line,
  };
}

/**
 * Fallback: Run code locally on the host machine using custom Promise wrapped child_process.exec.
 */
async function hostRunCode(language, code, stdin) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'code-'));
  const requestId = Date.now();

  try {
    const sourceFile = getSourceFileName(language);
    const sourcePath = path.join(tmpDir, sourceFile);
    await writeFile(sourcePath, code, 'utf8');

    let stdout = '';
    let stderr = '';

    if (language === 'python') {
      const pythonPath = getPythonExecutable();
      console.log("[PYTHON PATH USED]:", pythonPath);
      const command = `"${pythonPath}" "${sourcePath}"`;

      try {
        const result = await new Promise((resolve, reject) => {
          const child = spawn(pythonPath, [sourcePath], {
            cwd: tmpDir,
            env: {
              ...process.env,
              PYTHONIOENCODING: 'utf-8',
              MPLBACKEND: 'Agg',
              NODE_PATH: [path.resolve(process.cwd(), 'node_modules'), path.join(tmpDir, 'node_modules')].filter(Boolean).join(path.delimiter),
            }
          });

          child.on("error", (err) => {
            logExecutionError("CHILD_PROCESS_ERROR", err, { requestId, command });
          });

          child.on("exit", (codeVal) => {
            if (codeVal !== 0 && codeVal !== null) {
              logExecutionError("PROCESS_EXIT_FAILURE", new Error("Non-zero exit"), { requestId, code: codeVal });
            }
          });

          const stdoutChunks = [];
          const stderrChunks = [];
          let totalBytes = 0;
          const maxOutputBytes = 2 * 1024 * 1024;
          let killed = false;

          child.stdout.on('data', (chunk) => {
            totalBytes += chunk.length;
            if (totalBytes > maxOutputBytes) {
              killed = true;
              child.kill('SIGKILL');
              return;
            }
            stdoutChunks.push(chunk);
          });

          child.stderr.on('data', (chunk) => {
            totalBytes += chunk.length;
            if (totalBytes > maxOutputBytes) {
              killed = true;
              child.kill('SIGKILL');
              return;
            }
            stderrChunks.push(chunk);
          });

          if (stdin) {
            child.stdin.write(stdin);
          }
          child.stdin.end();

          const timeout = setTimeout(() => {
            killed = true;
            child.kill('SIGKILL');
          }, 15000);

          child.on('close', (codeVal, signalVal) => {
            clearTimeout(timeout);
            const out = Buffer.concat(stdoutChunks).toString('utf8');
            const errStr = Buffer.concat(stderrChunks).toString('utf8');

            if (killed) {
              const error = new Error('Execution timed out (15s limit).');
              error.killed = true;
              error.stdout = out;
              error.stderr = errStr;
              reject(error);
            } else if (codeVal !== 0 || signalVal) {
              const error = new Error(errStr || `Process exited with code ${codeVal}`);
              error.code = codeVal;
              error.signal = signalVal;
              error.stdout = out;
              error.stderr = errStr;
              reject(error);
            } else {
              resolve({ stdout: out, stderr: errStr });
            }
          });
        });
        stdout = result.stdout;
        stderr = result.stderr;
      } catch (err) {
        logExecutionError("PYTHON_EXECUTION", err, {
          requestId,
          pythonPath,
          command,
          filePath: sourcePath,
          cwd: process.cwd()
        });

        // 8. FAILURE HANDLING: If pandas missing
        const isPandasMissing = (err.stderr || err.message || '').includes("No module named 'pandas'");
        if (isPandasMissing) {
          const pipPath = pythonPath.replace(/python3$/, 'pip').replace(/python\.exe$/, 'pip.exe').replace(/python$/, 'pip');
          console.error("====== PANDAS MODULE MISSING ======");
          console.error("pythonPath:", pythonPath);
          console.error("pipPath:", pipPath);
          const reqPath = path.resolve(backendRoot, 'requirements.txt');
          console.error("requirementsPath:", reqPath);
          if (existsSync(reqPath)) {
            try {
              const reqContent = await readFile(reqPath, 'utf8');
              console.error("requirements.txt Content:\n", reqContent);
            } catch (readErr) {
              console.error("Failed to read requirements.txt:", readErr.message);
            }
          }
          console.error("===================================");
        }

        return {
          success: false,
          error: isPandasMissing ? "ModuleNotFoundError: No module named 'pandas'. Ensure it is installed in Render virtual environment." : (err.message || 'Execution failed'),
          stderr: err.stderr || err.message || '',
          stdout: err.stdout || '',
          debug: {
            pythonPath,
            command,
            cwd: process.cwd()
          }
        };
      }
    } else {
      // Build shell command
      const cmd = getRunCommand(language, sourcePath);

      // Execute with timeout (15 seconds) and piping stdin
      const execRes = await new Promise((resolve, reject) => {
        const child = exec(
          cmd,
          {
            timeout: 15000,
            maxBuffer: 2 * 1024 * 1024,
            cwd: tmpDir,
            shell: true,
            env: {
              ...process.env,
              PYTHONIOENCODING: 'utf-8',
              MPLBACKEND: 'Agg',
              NODE_PATH: [path.resolve(process.cwd(), 'node_modules'), path.join(tmpDir, 'node_modules')].filter(Boolean).join(path.delimiter),
            }
          },
          (error, stdout, stderr) => {
            if (error) {
              error.stdout = stdout;
              error.stderr = stderr;
              reject(error);
            } else {
              resolve({ stdout, stderr });
            }
          }
        );

        if (stdin) {
          child.stdin.write(stdin);
        }
        child.stdin.end();
      });
      stdout = execRes.stdout;
      stderr = execRes.stderr;
    }

    let image = null;
    if (language === 'python') {
      image = await detectAndReadImage(tmpDir);
    }

    const cleanStderr = filterWarnings(stderr || '');
    const isSuccess = true;

    return {
      success: isSuccess,
      stdout: stdout || '',
      stderr: cleanStderr,
      runner: 'host',
      ...(image ? { image } : {}),
    };
  } catch (err) {
    const stderr = err.stderr || err.message || '';
    const stdout = err.stdout || '';
    const line = parseErrorLine(stderr, language);

    // Timeout
    if (err.killed) {
      return {
        success: false,
        stdout,
        stderr: 'Execution timed out (15s limit).',
        error: 'Time Limit Exceeded',
      };
    }

    const cleanStderr = filterWarnings(stderr);
    // If we have no stderr but the process failed, surface the error message.
    const finalStderr = cleanStderr || err.message || 'Execution failed.';
    if (shouldAttemptDockerFallback(language, cleanStderr, err.message)) {
      try {
        const dockerResult = await dockerRunCode(
          language,
          code,
          stdin,
          getSourceFileName(language)
        );
        return {
          ...dockerResult,
          warning: 'Local toolchain was unavailable; executed in Docker container.',
        };
      } catch (dockerErr) {
        return {
          success: false,
          stdout,
          stderr: finalStderr,
          error: finalStderr.split('\n')[0] || 'Execution failed',
          line,
          diagnostics: [{ message: `Docker fallback failed: ${dockerErr.message}` }],
        };
      }
    }

    return {
      success: false,
      stdout,
      stderr: finalStderr,
      error: finalStderr.split('\n')[0] || 'Execution failed',
      line,
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function normalizeCProjectFiles(files, code) {
  const normalized = normalizeProjectFiles(files, code);
  if (files) return normalized;
  return [{ path: path.join('src', 'main.c'), content: code || '' }];
}

function getSingleCSourceForRemote(files, code) {
  if (!files) return code || '';
  const projectFiles = normalizeCProjectFiles(files, code);
  const cFiles = projectFiles.filter(file => path.extname(file.path).toLowerCase() === '.c');
  const nonRemoteFiles = projectFiles.filter(file => {
    const ext = path.extname(file.path).toLowerCase();
    return ext && ext !== '.c';
  });
  if (cFiles.length === 1 && nonRemoteFiles.length === 0) {
    return String(cFiles[0].content ?? '');
  }
  return '';
}

function getCStandard(cStandard) {
  const normalized = String(cStandard || 'c17').toLowerCase();
  return C_STANDARDS.has(normalized) ? normalized : 'c17';
}

function classifyCProjectFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (C_SOURCE_EXTENSIONS.has(ext)) return 'source';
  if (C_HEADER_EXTENSIONS.has(ext)) return 'header';
  if (C_STATIC_LIBRARY_EXTENSIONS.has(ext)) return 'static-library';
  if (C_DYNAMIC_LIBRARY_EXTENSIONS.has(ext)) return 'dynamic-library';
  if (path.basename(filePath).toLowerCase() === 'makefile') return 'makefile';
  return 'resource';
}

function buildCProjectIndex(projectFiles) {
  const diagnostics = [];
  const seen = new Set();
  const sources = [];
  const headers = [];
  const staticLibraries = [];
  const dynamicLibraries = [];
  const includeDirs = new Set();
  let hasMain = false;

  for (const file of projectFiles) {
    const safePath = assertSafeProjectPath(file.path).replace(/\\/g, '/');
    if (seen.has(safePath)) {
      diagnostics.push({
        file: file.path,
        message: `Duplicate project file: ${safePath}`,
        suggestedFix: 'Keep one file for each relative project path.',
      });
      continue;
    }
    seen.add(safePath);

    const kind = classifyCProjectFile(safePath);
    if (kind === 'source') {
      sources.push(safePath);
      if (/\bint\s+main\s*\(|\bint\s+main\s*\(\s*void\s*\)/.test(String(file.content ?? ''))) {
        hasMain = true;
      }
    }
    if (kind === 'header') {
      headers.push(safePath);
      includeDirs.add(path.posix.dirname(safePath));
    }
    if (kind === 'static-library') staticLibraries.push(safePath);
    if (kind === 'dynamic-library') dynamicLibraries.push(safePath);
  }

  if (sources.length === 0) {
    diagnostics.push({
      file: 'project',
      message: 'No C source files were found.',
      suggestedFix: 'Add at least one .c file, usually src/main.c.',
    });
  }
  if (!hasMain) {
    diagnostics.push({
      file: sources[0] || 'project',
      message: 'No int main(...) entry point was found.',
      suggestedFix: 'Add int main(void) or int main(int argc, char **argv) to one C source file.',
    });
  }

  return { diagnostics, sources, headers, staticLibraries, dynamicLibraries, includeDirs: [...includeDirs] };
}

function cDiagnosticSuggestions(stderr) {
  const suggestions = [];
  if (/fatal error: .*: No such file or directory/.test(stderr)) {
    suggestions.push('Check the #include name or add the missing header file to the project.');
  }
  if (/undefined reference to/.test(stderr)) {
    suggestions.push('Add the missing .c file, link the required static/dynamic library, or verify the function name.');
  }
  if (/multiple definition of/.test(stderr)) {
    suggestions.push('Keep function definitions in .c files and declarations in .h files, or mark header functions static inline.');
  }
  if (/Segmentation fault|access violation|STATUS_ACCESS_VIOLATION/i.test(stderr)) {
    suggestions.push('Check pointer validity, array bounds, allocation sizes, and freed memory usage.');
  }
  if (/Permission denied|Operation not permitted/i.test(stderr)) {
    suggestions.push('The sandbox restricts some filesystem, process, and network operations.');
  }
  if (/(gcc.*not recognized|gcc: command not found|spawn gcc ENOENT)/i.test(stderr)) {
    suggestions.push('Install GCC locally or build/run the docker/c image for C execution.');
  }
  return suggestions.map(message => ({ message }));
}

function describeProcessFailure(err, stderr) {
  const exitCode = typeof err.code === 'number' ? err.code : undefined;
  const signal = err.signal;
  const combined = `${stderr}\n${err.message || ''}`;

  if (err.killed) {
    return { error: 'Time Limit Exceeded', stderr: stderr || 'Execution timed out (15s limit).' };
  }
  if (/(gcc.*not recognized|gcc: command not found|spawn gcc ENOENT)/i.test(combined)) {
    return { error: 'C compiler not found', stderr: stderr || 'gcc was not found on the execution host.' };
  }
  if (signal === 'SIGSEGV' || exitCode === 139 || exitCode === 3221225477 || /Segmentation fault|STATUS_ACCESS_VIOLATION/i.test(combined)) {
    return { error: 'Segmentation fault', stderr: stderr || 'Segmentation fault: invalid memory access.' };
  }
  if (signal) {
    return { error: `Process terminated by ${signal}`, stderr: stderr || `Process terminated by ${signal}.` };
  }
  if (exitCode !== undefined) {
    return { error: `Process exited with code ${exitCode}`, stderr };
  }
  return { error: stderr.split('\n')[0] || 'Execution failed', stderr };
}

async function runCProject({ code, files, stdin = '', cStandard }) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'c-project-'));

  try {
    const projectFiles = normalizeCProjectFiles(files, code);
    const index = buildCProjectIndex(projectFiles);
    if (index.diagnostics.length > 0) {
      return {
        success: false,
        stdout: '',
        stderr: index.diagnostics.map(d => `${d.file}: ${d.message}\nSuggested fix: ${d.suggestedFix}`).join('\n'),
        error: index.diagnostics[0].message,
        diagnostics: index.diagnostics,
      };
    }

    for (const file of projectFiles) {
      await writeProjectFile(tmpDir, file.path, file.encoding ? { content: file.content, encoding: file.encoding } : file.content);
    }

    const standard = getCStandard(cStandard);
    const outPath = path.join(tmpDir, os.platform() === 'win32' ? 'main.exe' : 'main');
    const sourcePaths = index.sources.map(source => path.join(tmpDir, source));
    const includeFlags = [...new Set(['.', 'src', ...index.includeDirs])]
      .map(includeDir => `-I${shellPath(path.join(tmpDir, includeDir))}`);
    const libraryPaths = [...index.staticLibraries, ...index.dynamicLibraries].map(lib => path.join(tmpDir, lib));
    const runtimeLibraryDirs = index.dynamicLibraries.map(lib => path.dirname(path.join(tmpDir, lib)));
    const rpathFlags = os.platform() === 'win32'
      ? []
      : [...new Set(runtimeLibraryDirs)].map(dir => `-Wl,-rpath,${shellPath(dir)}`);
    const compileCommand = [
      'gcc',
      `-std=${standard}`,
      ...C_COMPILER_FLAGS,
      ...includeFlags,
      ...sourcePaths.map(shellPath),
      ...libraryPaths.map(shellPath),
      ...rpathFlags,
      '-o',
      shellPath(outPath),
      ...C_LINKER_FLAGS,
    ].join(' ');

    const compile = await execCommand(compileCommand, {
      cwd: tmpDir,
      stdin: '',
      env: {
        ...process.env,
        PATH: [tmpDir, ...runtimeLibraryDirs, process.env.PATH].filter(Boolean).join(path.delimiter),
      },
    });
    const run = await execCommand(shellPath(outPath), {
      cwd: tmpDir,
      stdin,
      timeout: 15000,
      env: {
        ...process.env,
        PATH: [tmpDir, ...runtimeLibraryDirs, process.env.PATH].filter(Boolean).join(path.delimiter),
        LD_LIBRARY_PATH: [...runtimeLibraryDirs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter),
        DYLD_LIBRARY_PATH: [...runtimeLibraryDirs, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(path.delimiter),
      },
    });

    return {
      success: true,
      stdout: run.stdout || '',
      stderr: filterWarnings(`${compile.stderr || ''}${run.stderr || ''}`),
      compileOutput: filterWarnings(compile.stderr || ''),
      buildTool: 'gcc',
      compiler: 'gcc',
      cStandard: standard,
      exitCode: 0,
      command: 'gcc main.c -o main -lm -pthread',
    };
  } catch (err) {
    const rawStderr = filterWarnings(err.stderr || err.message || '');
    const failure = describeProcessFailure(err, rawStderr);
    return {
      success: false,
      stdout: err.stdout || '',
      stderr: failure.stderr,
      compileOutput: failure.stderr,
      error: failure.error,
      line: parseErrorLine(failure.stderr, 'c'),
      exitCode: typeof err.code === 'number' ? err.code : undefined,
      signal: err.signal,
      diagnostics: cDiagnosticSuggestions(failure.stderr),
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function stripJavaComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
    .replace(/\/\/.*$/gm, '');
}

function validateJavaPackageName(packageName) {
  if (!packageName) return true;
  if (!JAVA_PACKAGE_RE.test(packageName)) return false;
  return packageName.split('.').every(part => !JAVA_KEYWORDS.has(part));
}

function parseJavaPackage(code) {
  const clean = stripJavaComments(code);
  const match = clean.match(/^\s*package\s+([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)\s*;/m);
  return match?.[1] || '';
}

function parseJavaImports(code) {
  const clean = stripJavaComments(code);
  const imports = [];
  const importRegex = /^\s*import\s+(static\s+)?([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*|\.\*)*)\s*;/gm;
  let match;
  while ((match = importRegex.exec(clean)) !== null) {
    imports.push({ name: match[2], isStatic: Boolean(match[1]) });
  }
  return imports;
}

function parseJavaTypeName(code) {
  const clean = stripJavaComments(code);
  const publicType = clean.match(/\bpublic\s+(?:abstract\s+|final\s+|sealed\s+|non-sealed\s+)*(@interface|class|interface|enum|record)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/);
  if (publicType) return publicType[2];

  const anyType = clean.match(/\b(@interface|class|interface|enum|record)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/);
  return anyType?.[2] || 'Main';
}

function hasJavaMainMethod(code) {
  return /\bpublic\s+static\s+void\s+main\s*\(\s*String(?:\s*\[\s*\]|\s+\.\.\.)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*\)/.test(stripJavaComments(code));
}

function normalizeProjectFiles(files, code) {
  if (files && !Array.isArray(files) && typeof files === 'object') {
    return Object.entries(files).map(([filePath, content]) => ({
      path: filePath,
      content,
    }));
  }

  if (Array.isArray(files)) {
    return files.map(file => ({
      path: file.path || file.name,
      content: file.content ?? file.code ?? '',
      encoding: file.encoding,
    }));
  }

  const packageName = parseJavaPackage(code || '');
  const typeName = parseJavaTypeName(code || '');
  const filePath = path.join('src', 'main', 'java', ...packageName.split('.').filter(Boolean), `${typeName}.java`);
  return [{ path: filePath, content: code || '' }];
}

function assertSafeProjectPath(relativePath) {
  if (!relativePath || typeof relativePath !== 'string') {
    throw new Error('Every project file must include a valid relative path.');
  }

  const normalized = relativePath.replace(/\\/g, '/');
  if (path.isAbsolute(normalized) || normalized.includes('\0')) {
    throw new Error(`Unsafe project path: ${relativePath}`);
  }

  const parts = normalized.split('/').filter(Boolean);
  if (parts.some(part => part === '..')) {
    throw new Error(`Path traversal is not allowed in project files: ${relativePath}`);
  }

  return parts.join(path.sep);
}

function javaPackageToPath(packageName) {
  return packageName ? packageName.split('.').join(path.sep) : '';
}

function suggestJavaDiagnostic(stderr) {
  const suggestions = [];
  if (/package .* does not exist/.test(stderr)) {
    suggestions.push('Check the import name, add the missing source file, or declare the dependency in pom.xml/build.gradle.');
  }
  if (/cannot find symbol/.test(stderr)) {
    suggestions.push('Verify the class name, package declaration, and imports for the referenced symbol.');
  }
  if (/duplicate class:/.test(stderr)) {
    suggestions.push('Remove duplicate type declarations or ensure each public class has one matching .java file.');
  }
  if (/class .* is public, should be declared in a file named/.test(stderr)) {
    suggestions.push('Rename the file to match the public class, or remove the public modifier.');
  }
  if (/Could not find or load main class/.test(stderr)) {
    suggestions.push('Set mainClass to the fully qualified class name, for example com.example.Main.');
  }
  return suggestions;
}

async function writeProjectFile(rootDir, relativePath, content) {
  const safePath = assertSafeProjectPath(relativePath);
  const fullPath = path.join(rootDir, safePath);
  const resolvedRoot = path.resolve(rootDir);
  const resolvedFile = path.resolve(fullPath);
  if (!resolvedFile.startsWith(resolvedRoot + path.sep) && resolvedFile !== resolvedRoot) {
    throw new Error(`Project file escapes the sandbox: ${relativePath}`);
  }
  await mkdir(path.dirname(fullPath), { recursive: true });
  if (content && typeof content === 'object' && content.encoding === 'base64') {
    await writeFile(fullPath, Buffer.from(String(content.content ?? content.data ?? ''), 'base64'));
  } else {
    await writeFile(fullPath, String(content ?? ''), 'utf8');
  }
  return fullPath;
}

async function collectFiles(dir, predicate) {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(fullPath, predicate));
    } else if (predicate(fullPath)) {
      files.push(fullPath);
    }
  }
  return files;
}

async function copyDirectoryContents(sourceDir, targetDir) {
  if (!existsSync(sourceDir)) return;
  const entries = await readdir(sourceDir, { withFileTypes: true });
  await mkdir(targetDir, { recursive: true });
  for (const entry of entries) {
    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryContents(source, target);
    } else {
      await copyFile(source, target);
    }
  }
}

function inferJavaSourceRoot(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  const srcMain = normalized.indexOf('src/main/java/');
  if (srcMain >= 0) return normalized.slice(0, srcMain + 'src/main/java'.length);
  const srcTest = normalized.indexOf('src/test/java/');
  if (srcTest >= 0) return normalized.slice(0, srcTest + 'src/test/java'.length);
  const src = normalized.indexOf('src/');
  if (src >= 0) return normalized.slice(0, src + 'src'.length);
  return '';
}

function buildJavaProjectIndex(projectFiles) {
  const classes = new Map();
  const diagnostics = [];
  let mainClass = '';

  for (const file of projectFiles.filter(f => f.path.replace(/\\/g, '/').endsWith('.java'))) {
    const packageName = parseJavaPackage(file.content);
    const typeName = parseJavaTypeName(file.content);
    const imports = parseJavaImports(file.content);
    const sourceRoot = inferJavaSourceRoot(file.path);
    const expectedPackagePath = javaPackageToPath(packageName).replace(/\\/g, '/');
    const normalizedPath = file.path.replace(/\\/g, '/');
    const fqcn = packageName ? `${packageName}.${typeName}` : typeName;

    if (!validateJavaPackageName(packageName)) {
      diagnostics.push({
        file: file.path,
        message: `Invalid Java package declaration: ${packageName}`,
        suggestedFix: 'Use dot-separated Java identifiers and avoid reserved keywords.',
      });
    }

    if (packageName && sourceRoot) {
      const expectedSuffix = `${sourceRoot}/${expectedPackagePath}/${path.basename(normalizedPath)}`.replace(/\\/g, '/');
      if (normalizedPath !== expectedSuffix && normalizedPath.endsWith('.java')) {
        diagnostics.push({
          file: file.path,
          message: `Package declaration '${packageName}' does not match folder structure.`,
          suggestedFix: `Move the file under ${sourceRoot}/${expectedPackagePath}/ or update the package declaration.`,
        });
      }
    }

    if (classes.has(fqcn)) {
      diagnostics.push({
        file: file.path,
        message: `Duplicate class: ${fqcn}`,
        suggestedFix: 'Keep one source file per fully qualified public type.',
      });
    }
    classes.set(fqcn, { ...file, packageName, typeName, imports });

    if (!mainClass && hasJavaMainMethod(file.content)) {
      mainClass = fqcn;
    }
  }

  return { classes, diagnostics, mainClass };
}

function commandExists(command) {
  return new Promise((resolve) => {
    const probe = process.platform === 'win32' ? `where "${command}"` : `command -v "${command}"`;
    exec(probe, (err, stdout) => {
      resolve(!err && Boolean(stdout.trim()));
    });
  });
}

async function runJavaProject({ code, files, stdin = '', mainClass, buildTool }) {
  // 1. Java runtime detection & javac validation
  const hasJavac = await commandExists('javac');
  const hasJava = await commandExists('java');
  if (!hasJavac || !hasJava) {
    return {
      success: false,
      errorType: "JAVA_RUNTIME_MISSING",
      message: "Java compiler not available"
    };
  }

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'java-project-'));

  try {
    const projectFiles = normalizeProjectFiles(files, code);
    const index = buildJavaProjectIndex(projectFiles);
    if (index.diagnostics.length > 0) {
      return {
        success: false,
        stdout: '',
        stderr: index.diagnostics.map(d => `${d.file}: ${d.message}\nSuggested fix: ${d.suggestedFix}`).join('\n'),
        error: index.diagnostics[0].message,
        diagnostics: index.diagnostics,
      };
    }

    // 2. main() validation
    const detectedMainClass = mainClass || index.mainClass;
    if (!detectedMainClass) {
      return {
        success: false,
        stdout: '',
        stderr: "Error: Main method not found in project. Please define the main method as:\npublic static void main(String[] args)",
        error: "Main method not found",
        diagnostics: [{ message: "Please define: public static void main(String[] args)" }],
      };
    }

    for (const file of projectFiles) {
      await writeProjectFile(tmpDir, file.path, file.content);
    }

    const hasPom = existsSync(path.join(tmpDir, 'pom.xml'));
    const hasGradle = existsSync(path.join(tmpDir, 'build.gradle')) || existsSync(path.join(tmpDir, 'build.gradle.kts'));
    const selectedBuildTool = buildTool || (hasPom ? 'maven' : hasGradle ? 'gradle' : 'javac');

    if (selectedBuildTool === 'maven' && hasPom) {
      const cpFile = path.join(tmpDir, 'classpath.txt');
      const command = `mvn -q -DskipTests compile dependency:build-classpath -Dmdep.outputFile=${quotePath(cpFile)}`;
      const build = await execCommand(command, { cwd: tmpDir, stdin: '' });
      const dependencyClasspath = existsSync(cpFile) ? String(await readFile(cpFile, 'utf8')).trim() : '';
      const classpath = [path.join(tmpDir, 'target', 'classes'), dependencyClasspath].filter(Boolean).join(path.delimiter);
      const run = await execCommand(`java -cp ${quotePath(classpath)} ${detectedMainClass}`, { cwd: tmpDir, stdin, timeout: 15000 });
      return {
        success: true,
        stdout: run.stdout || '',
        stderr: filterWarnings(`${build.stderr || ''}${run.stderr || ''}`),
        mainClass: detectedMainClass,
        buildTool: 'maven',
      };
    }

    if (selectedBuildTool === 'gradle' && hasGradle) {
      const gradleCommand = existsSync(path.join(tmpDir, os.platform() === 'win32' ? 'gradlew.bat' : 'gradlew')) ? (os.platform() === 'win32' ? 'gradlew.bat' : './gradlew') : 'gradle';
      const build = await execCommand(`${gradleCommand} -q classes`, { cwd: tmpDir, stdin: '' });
      const classpath = [
        path.join(tmpDir, 'build', 'classes', 'java', 'main'),
        path.join(tmpDir, 'build', 'resources', 'main'),
      ].join(path.delimiter);
      const run = await execCommand(`java -cp ${quotePath(classpath)} ${detectedMainClass}`, { cwd: tmpDir, stdin, timeout: 15000 });
      return {
        success: true,
        stdout: run.stdout || '',
        stderr: filterWarnings(`${build.stderr || ''}${run.stderr || ''}`),
        mainClass: detectedMainClass,
        buildTool: 'gradle',
      };
    }

    const sourceRoots = [
      path.join(tmpDir, 'src', 'main', 'java'),
      path.join(tmpDir, 'src'),
      tmpDir,
    ].filter((value, index, arr) => existsSync(value) && arr.indexOf(value) === index);
    const javaFiles = [...new Set((await Promise.all(
      sourceRoots.map(root => collectFiles(root, file => file.endsWith('.java')))
    )).flat())];

    if (javaFiles.length === 0) {
      throw new Error('No Java source files were found.');
    }

    const outDir = path.join(tmpDir, 'out');
    await mkdir(outDir, { recursive: true });
    await copyDirectoryContents(path.join(tmpDir, 'src', 'main', 'resources'), outDir);
    const sourcesFile = path.join(tmpDir, 'sources.txt');
    await writeFile(sourcesFile, javaFiles.map(file => javaArgFilePath(file)).join(os.EOL), 'utf8');

    const sourcePath = sourceRoots.join(path.delimiter);
    const compile = await execCommand(`javac -encoding UTF-8 -d ${quotePath(outDir)} -sourcepath ${quotePath(sourcePath)} @${quotePath(sourcesFile)}`, {
      cwd: tmpDir,
      stdin: '',
    });
    const run = await execCommand(`java -cp ${quotePath(outDir)} ${detectedMainClass}`, {
      cwd: tmpDir,
      stdin,
      timeout: 15000,
    });

    return {
      success: true,
      stdout: run.stdout || '',
      stderr: filterWarnings(`${compile.stderr || ''}${run.stderr || ''}`),
      mainClass: detectedMainClass,
      buildTool: 'javac',
    };
  } catch (err) {
    const stderr = filterWarnings(err.stderr || err.message || '');
    const diagnostics = suggestJavaDiagnostic(stderr).map(message => ({ message }));
    return {
      success: false,
      stdout: err.stdout || '',
      stderr,
      error: stderr.split('\n')[0] || 'Java execution failed',
      line: parseErrorLine(stderr, 'java'),
      diagnostics,
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Preprocess code to mock and resolve external package/library dependencies.
 */
async function detectAndReadImage(dirPath) {
  try {
    const files = await readdir(dirPath);
    if (files.includes('matplotlib_plot.png')) {
      const filePath = path.join(dirPath, 'matplotlib_plot.png');
      const imgBuffer = await readFile(filePath);
      return `data:image/png;base64,${imgBuffer.toString('base64')}`;
    }
    const imgExtensions = ['.png', '.jpg', '.jpeg', '.gif'];
    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      if (imgExtensions.includes(ext)) {
        const filePath = path.join(dirPath, file);
        const imgBuffer = await readFile(filePath);
        const mimeType = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
        return `data:${mimeType};base64,${imgBuffer.toString('base64')}`;
      }
    }
  } catch (error) {
    console.error("Error detecting/reading images in tmpDir:", error);
  }
  return null;
}

function preprocessPython(code) {
  let header = '';
  if (code.includes('matplotlib') || code.includes('plt')) {
    header += `import matplotlib\nmatplotlib.use('Agg')\nimport matplotlib.pyplot as plt\n`;
    header += `original_show = plt.show\ndef custom_show(*args, **kwargs):\n    plt.savefig('matplotlib_plot.png', bbox_inches='tight')\nplt.show = custom_show\n`;
  }
  return header + code;
}

function preprocessJS(code, isTS = false) {
  const jsMockPackages = [
    'react', 'react-dom', 'express', 'next', 'vue', '@vue/runtime-dom', 'axios', 'lodash',
    'angular', '@angular/core', '@angular/common', 'jquery', 'socket.io', 'mongoose',
    'bcrypt', 'jsonwebtoken', 'multer', 'cors', 'dotenv', 'redux', '@reduxjs/toolkit',
    '@nestjs/core', '@nestjs/common', '@nestjs/platform-express', 'typeorm', 'prisma',
    'rxjs', 'typescript', 'ts-node', 'bootstrap', 'tailwindcss', '@mui/material',
  ];
  const escapedPackages = jsMockPackages.map(pkg => pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pkgPattern = new RegExp(`(?:${escapedPackages.join('|')})`, 'i');
  if (!pkgPattern.test(code)) {
    return code;
  }

  const bootstrap = `${isTS ? '// @ts-nocheck\n' : ''}const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function(id) {
  try {
    return originalRequire.apply(this, arguments);
  } catch (err) {
    const pkg = id.toLowerCase();
    if (${JSON.stringify(jsMockPackages)}.includes(pkg)) {
      const makeMock = (name) => {
        return new Proxy(() => {}, {
          get(target, prop) {
            if (prop === 'then') return undefined;
            if (prop === 'default') return makeMock(name);
            if (prop === Symbol.iterator) {
              return function* () {
                while (true) {
                  yield makeMock(name + '[iterator]');
                }
              };
            }
            return makeMock(\`\${name}.\${prop}\`);
          },
          apply(target, thisArg, argumentsList) {
            return makeMock(\`\${name}()\`);
          },
          construct(target, args) {
            return makeMock(\`new \${name}\`);
          }
        });
      };
      return makeMock(id);
    }
    throw err;
  }
};
`;

  let cleanCode = code;
  const importPackagePattern = escapedPackages.join('|');
  cleanCode = cleanCode.replace(new RegExp(`import\\s+([\\w\\s{},*]+)\\s+from\\s+['"](${importPackagePattern})['"]`, 'g'), (match, imports, pkg) => {
    if (imports.trim().startsWith('* as')) {
      const alias = imports.replace('* as', '').trim();
      return `const ${alias} = require("${pkg}");`;
    }
    if (imports.includes('{')) {
      const parts = imports.split('{');
      const defaultImport = parts[0].replace(',', '').trim();
      const namedImports = parts[1].replace('}', '').trim();
      let res = '';
      if (defaultImport) {
        res += `const ${defaultImport} = require("${pkg}");\n`;
      }
      const base = defaultImport || `_mock_${pkg}`;
      if (!defaultImport) {
        res += `const ${base} = require("${pkg}");\n`;
      }
      res += `const { ${namedImports} } = ${base};`;
      return res;
    }
    return `const ${imports.trim()} = require("${pkg}");`;
  });

  return bootstrap + '\n' + cleanCode;
}

function preprocessJava(code) {
  return code;
}

function preprocessCPP(code) {
  let cleanCode = code;
  cleanCode = cleanCode.replace(/#include\s*<boost\/.*?>/g, '// #include <boost/...>');
  cleanCode = cleanCode.replace(/#include\s*<opencv2\/.*?>/g, '// #include <opencv2/...>');
  cleanCode = cleanCode.replace(/#include\s*<Q[A-Za-z]+>/g, '// #include <Q...>');
  
  const stubs = `
#include <iostream>
#include <vector>
#include <map>
#include <algorithm>
#include <string>

namespace cv {
    class Mat {
    public:
        Mat() {}
        Mat(int r, int c, int t) {}
        bool empty() const { return false; }
    };
    inline Mat imread(const std::string& s, int f=1) { return Mat(); }
    inline void imshow(const std::string& s, const Mat& m) {}
    inline int waitKey(int d=0) { return 0; }
    inline void cvtColor(const Mat& src, Mat& dst, int code, int dstCn=0) {}
}
#define CV_8UC3 16
#define IMREAD_COLOR 1

class QApplication {
public:
    QApplication(int& argc, char** argv) {}
    int exec() { return 0; }
};
class QWidget {
public:
    void show() {}
    void setWindowTitle(const std::string& s) {}
    void resize(int w, int h) {}
};
class QPushButton : public QWidget {
public:
    QPushButton(const std::string& s, QWidget* parent=nullptr) {}
};
class QLabel : public QWidget {
public:
    QLabel(const std::string& s, QWidget* parent=nullptr) {}
};
class QVBoxLayout {
public:
    void addWidget(QWidget* w) {}
};
class QHBoxLayout {
public:
    void addWidget(QWidget* w) {}
};
`;
  return stubs + '\n' + cleanCode;
}

function preprocessCSharp(code) {
  let cleanCode = code;
  cleanCode = cleanCode.replace(/using\s+Microsoft\.AspNetCore\..*?;/g, '// using Microsoft.AspNetCore...');
  cleanCode = cleanCode.replace(/using\s+Microsoft\.EntityFrameworkCore.*?;/g, '// using Microsoft.EntityFrameworkCore...');
  
  const stubs = `
namespace Microsoft.AspNetCore.Mvc {
    public class Controller { }
    public class ControllerBase { }
    public class RouteAttribute : System.Attribute { public RouteAttribute(string s) {} }
    public class HttpGetAttribute : System.Attribute { public HttpGetAttribute() {} public HttpGetAttribute(string s) {} }
    public class HttpPostAttribute : System.Attribute { public HttpPostAttribute() {} public HttpPostAttribute(string s) {} }
}
namespace Microsoft.EntityFrameworkCore {
    public class DbContext {
        protected virtual void OnConfiguring(DbContextOptionsBuilder optionsBuilder) {}
    }
    public class DbContextOptionsBuilder {}
    public class DbSet<T> where T : class {
        public void Add(T entity) {}
        public System.Collections.Generic.IEnumerable<T> ToList() { return new System.Collections.Generic.List<T>(); }
    }
}
`;
  return cleanCode + '\n' + stubs;
}

function preprocessPHP(code) {
  const bootstrap = `spl_autoload_register(function ($class) {
    $classLower = strtolower($class);
    if (strpos($classLower, 'illuminate') !== false || strpos($classLower, 'symfony') !== false || strpos($classLower, 'codeigniter') !== false) {
        $parts = explode('\\\\', $class);
        $className = end($parts);
        $namespace = implode('\\\\', array_slice($parts, 0, -1));
        if ($namespace) {
            if (!class_exists($class, false)) {
                eval("namespace $namespace { class $className { public function __call(\\$m, \\$a) { return new \\stdClass(); } static public function __callStatic(\\$m, \\$a) { return new \\stdClass(); } } }");
            }
        } else {
            if (!class_exists($class, false)) {
                eval("class $className { public function __call(\\$m, \\$a) { return new \\stdClass(); } static public function __callStatic(\\$m, \\$a) { return new \\stdClass(); } }");
            }
        }
    }
});
`;
  if (code.includes('<?php')) {
    return code.replace('<?php', '<?php\n' + bootstrap);
  }
  return '<?php\n' + bootstrap + '\n' + code;
}

function preprocessGo(code) {
  let cleanCode = code;
  cleanCode = cleanCode.replace(/import\s+\(\s*[^)]*?["']github\.com\/gin-gonic\/gin["'][^)]*?\)/g, (match) => {
    return match.replace(/"github\.com\/gin-gonic\/gin"/, '// "github.com/gin-gonic/gin"');
  });
  cleanCode = cleanCode.replace(/import\s+["']github\.com\/gin-gonic\/gin["']/g, '// import "github.com/gin-gonic/gin"');
  
  cleanCode = cleanCode.replace(/import\s+\(\s*[^)]*?["']github\.com\/gofiber\/fiber\/v2["'][^)]*?\)/g, (match) => {
    return match.replace(/"github\.com\/gofiber\/fiber\/v2"/, '// "github.com/gofiber/fiber/v2"');
  });
  cleanCode = cleanCode.replace(/import\s+["']github\.com\/gofiber\/fiber\/v2["']/g, '// import "github.com/gofiber/fiber/v2"');

  cleanCode = cleanCode.replace(/import\s+\(\s*[^)]*?["']gorm\.io\/gorm["'][^)]*?\)/g, (match) => {
    return match.replace(/"gorm\.io\/gorm"/, '// "gorm.io/gorm"');
  });
  cleanCode = cleanCode.replace(/import\s+["']gorm\.io\/gorm["']/g, '// import "gorm.io/gorm"');

  cleanCode = cleanCode.replace(/\bgin\.Context\b/g, 'interface{}');
  cleanCode = cleanCode.replace(/\bfiber\.Ctx\b/g, 'interface{}');
  cleanCode = cleanCode.replace(/\bgorm\.DB\b/g, 'GormDB');

  const stubs = `
type GinEngine struct{}
func (g *GinEngine) Run(addr ...string) error { return nil }
func (g *GinEngine) GET(path string, handlers ...interface{}) {}
func (g *GinEngine) Use(handlers ...interface{}) {}

type ginType struct{}
func (ginType) Default() *GinEngine { return &GinEngine{} }
var gin ginType

type FiberApp struct{}
func (f *FiberApp) Listen(addr string) error { return nil }
func (f *FiberApp) Get(path string, handlers ...interface{}) {}
func (f *FiberApp) Use(handlers ...interface{}) {}

type fiberType struct{}
func (fiberType) New() *FiberApp { return &FiberApp{} }
var fiber fiberType

type GormDB struct{}
type GormModel struct{}
type gormType struct{}
func (gormType) Open(dialector interface{}, config ...interface{}) (*GormDB, error) { return &GormDB{}, nil }
var gorm gormType
`;
  return cleanCode + '\n' + stubs;
}

function preprocessRust(code) {
  let cleanCode = code;
  cleanCode = cleanCode.replace(/#\[tokio::main\]\s*async\s*fn\s*main\s*\(\s*\)/g, 'fn main()');
  cleanCode = cleanCode.replace(/async\s*fn\s*main\s*\(\s*\)/g, 'fn main()');
  
  // Comment out external crate declarations or imports to avoid redefined name collisions
  cleanCode = cleanCode.replace(/\buse\s+tokio\b(.*?);/g, '// use tokio$1;');
  cleanCode = cleanCode.replace(/\buse\s+rocket\b(.*?);/g, '// use rocket$1;');
  cleanCode = cleanCode.replace(/\buse\s+serde\b(.*?);/g, '// use serde$1;');
  cleanCode = cleanCode.replace(/\buse\s+actix_web\b(.*?);/g, '// use actix_web$1;');
  cleanCode = cleanCode.replace(/\buse\s+reqwest\b(.*?);/g, '// use reqwest$1;');
  cleanCode = cleanCode.replace(/\buse\s+clap\b(.*?);/g, '// use clap$1;');
  cleanCode = cleanCode.replace(/\buse\s+rand\b(.*?);/g, '// use rand$1;');
  cleanCode = cleanCode.replace(/\buse\s+chrono\b(.*?);/g, '// use chrono$1;');
  cleanCode = cleanCode.replace(/\buse\s+diesel\b(.*?);/g, '// use diesel$1;');
  
  cleanCode = cleanCode.replace(/use\s+tokio::.*?;/g, '// use tokio::...;');
  cleanCode = cleanCode.replace(/use\s+serde::.*?;/g, '// use serde::...;');
  cleanCode = cleanCode.replace(/use\s+actix_web::.*?;/g, '// use actix_web::...;');
  cleanCode = cleanCode.replace(/use\s+rocket::.*?;/g, '// use rocket::...;');
  cleanCode = cleanCode.replace(/use\s+reqwest::.*?;/g, '// use reqwest::...;');
  cleanCode = cleanCode.replace(/use\s+clap::.*?;/g, '// use clap::...;');
  cleanCode = cleanCode.replace(/use\s+rand::.*?;/g, '// use rand::...;');
  cleanCode = cleanCode.replace(/use\s+chrono::.*?;/g, '// use chrono::...;');
  cleanCode = cleanCode.replace(/use\s+diesel::.*?;/g, '// use diesel::...;');

  const stubs = `
#[allow(dead_code)]
pub mod tokio {
    pub use std::future::Future;
    pub fn spawn<F>(_: F) where F: Future + Send + 'static {}
}
#[allow(dead_code)]
pub mod serde {
    pub trait Serialize {}
    pub trait Deserialize<'de> {}
}
#[allow(dead_code)]
pub mod actix_web {
    pub struct HttpServer;
    impl HttpServer {
        pub fn new<F, I>(_: F) -> Self { HttpServer }
        pub fn bind<A>(self, _: A) -> std::io::Result<Self> { Ok(self) }
        pub fn run(self) -> std::io::Result<()> { Ok(()) }
    }
    pub mod web {
        pub struct Data<T>(T);
    }
}
#[allow(dead_code)]
pub mod rocket {
    pub struct Rocket;
    pub fn build() -> Rocket { Rocket }
    impl Rocket {
        pub fn mount(self, _: &str, _: Vec<()>) -> Self { self }
        pub fn launch(self) {}
    }
}
#[allow(dead_code)]
pub mod reqwest {
    pub fn get(_: &str) -> Result<Response, ()> { Ok(Response) }
    pub struct Response;
}
#[allow(dead_code)]
pub mod clap {
    pub struct Command;
    impl Command {
        pub fn new(_: &str) -> Self { Command }
    }
}
#[allow(dead_code)]
pub mod rand {
    pub fn random<T: Default>() -> T { T::default() }
}
#[allow(dead_code)]
pub mod chrono {
    pub struct Utc;
    impl Utc {
        pub fn now() -> &'static str { "now" }
    }
}
#[allow(dead_code)]
pub mod diesel {
    pub mod prelude {}
}
`;
  return cleanCode + '\n' + stubs;
}

function preprocessSwift(code) {
  let cleanCode = code;
  cleanCode = cleanCode.replace(/import\s+UIKit/g, '// import UIKit');
  cleanCode = cleanCode.replace(/import\s+SwiftUI/g, '// import SwiftUI');
  cleanCode = cleanCode.replace(/import\s+CoreData/g, '// import CoreData');
  cleanCode = cleanCode.replace(/import\s+Combine/g, '// import Combine');
  cleanCode = cleanCode.replace(/import\s+AVFoundation/g, '// import AVFoundation');
  cleanCode = cleanCode.replace(/import\s+Alamofire/g, '// import Alamofire');

  const stubs = `
import Foundation
class UIView {}
class UIViewController {}
struct View {}
struct Text { init(_ s: String) {} }
class NSManagedObject {}
class NSPersistentContainer {}
class AnyCancellable {}
class AVPlayer {}
struct AF {
    static func request(_ url: String) -> Session { Session() }
}
struct Session {
    func response(completionHandler: @escaping (Any) -> Void) {}
}
`;
  return cleanCode + '\n' + stubs;
}

function preprocessKotlin(code) {
  let cleanCode = code;
  cleanCode = cleanCode.replace(/import\s+io\.ktor\..*/g, '// import io.ktor...');
  cleanCode = cleanCode.replace(/import\s+kotlinx\.coroutines\..*/g, '// import kotlinx.coroutines...');
  cleanCode = cleanCode.replace(/import\s+androidx\.compose\..*/g, '// import androidx.compose...');
  cleanCode = cleanCode.replace(/import\s+retrofit2\..*/g, '// import retrofit2...');

  const stubs = `
// Kotlin Mock Stubs
class CoroutineScope
fun runBlocking(block: () -> Unit) { block() }
class HttpClient
class Retrofit
`;
  return cleanCode + '\n' + stubs;
}

function preprocessRuby(code) {
  const stubs = `module Rails
  class Application; end
end
module Sinatra
  class Base; end
end
module RSpec
  def self.describe(*args, &block); end
end
`;
  return stubs + '\n' + code;
}

function preprocessR(code) {
  const stubs = `library <- function(package, ...) {
  pkg <- as.character(substitute(package))
  if (pkg %in% c("ggplot2", "dplyr", "tidyverse", "tidyr", "shiny")) {
    if (pkg == "ggplot2" || pkg == "tidyverse") {
      assign("ggplot", function(...) list(), envir = .GlobalEnv)
      assign("aes", function(...) list(), envir = .GlobalEnv)
      assign("geom_point", function(...) list(), envir = .GlobalEnv)
      assign("geom_line", function(...) list(), envir = .GlobalEnv)
    }
    if (pkg %in% c("readr", "data.table", "caret", "shiny")) {
    return(invisible(NULL))
  }
  if (pkg == "dplyr" || pkg == "tidyverse") {
      assign("filter", function(df, ...) df, envir = .GlobalEnv)
      assign("select", function(df, ...) df, envir = .GlobalEnv)
      assign("mutate", function(df, ...) df, envir = .GlobalEnv)
      assign("%>%", function(lhs, rhs) {
        parent <- parent.frame()
        env <- new.env(parent = parent)
        env$\`_lhs\` <- lhs
        expr <- substitute(rhs)
        if (is.call(expr)) {
          new_call <- as.call(c(expr[[1]], quote(\`_lhs\`), as.list(expr[-1])))
          eval(new_call, envir = env)
        } else {
          new_call <- as.call(list(expr, quote(\`_lhs\`)))
          eval(new_call, envir = env)
        }
      }, envir = .GlobalEnv)
    }
    return(invisible(NULL))
  }
  base::library(pkg, character.only = TRUE, ...)
}
`;
  return stubs + '\n' + code;
}

function preprocessMATLAB(code) {
  return code;
}

function preprocessDart(code) {
  let cleanCode = code;
  cleanCode = cleanCode.replace(/import\s+['"]package:flutter\/.*?;/g, '// import Flutter');
  cleanCode = cleanCode.replace(/import\s+['"]package:http\/.*?;/g, '// import HTTP');
  cleanCode = cleanCode.replace(/import\s+['"]package:provider\/.*?;/g, '// import Provider');
  cleanCode = cleanCode.replace(/import\s+['"]package:get\/.*?;/g, '// import GetX');
  cleanCode = cleanCode.replace(/import\s+['"]package:riverpod\/.*?;/g, '// import Riverpod');

  const stubs = `
class StatelessWidget {}
class StatefulWidget {}
class Widget {}
class BuildContext {}
class Provider {}
class Riverpod {}
class Get {
  static void to(dynamic page) {}
}
`;
  return cleanCode + '\n' + stubs;
}

function preprocessC(code) {
  return code;
}

function preprocessScala(code) {
  return code;
}

function preprocessCode(language, code) {
  if (!code) return '';
  switch (language) {
    case 'python': return preprocessPython(code);
    case 'javascript':
      return preprocessJS(code, false);
    case 'typescript': return preprocessJS(code, true);
    case 'java': return preprocessJava(code);
    case 'cpp': return preprocessCPP(code);
    case 'c': return preprocessC(code);
    case 'csharp': return preprocessCSharp(code);
    case 'php': return preprocessPHP(code);
    case 'go': return preprocessGo(code);
    case 'rust': return preprocessRust(code);
    case 'swift': return preprocessSwift(code);
    case 'kotlin': return preprocessKotlin(code);
    case 'ruby': return preprocessRuby(code);
    case 'r': return preprocessR(code);
    case 'scala': return preprocessScala(code);
    case 'dart': return preprocessDart(code);
    case 'matlab': return preprocessMATLAB(code);
    default: return code;
  }
}

function pythonImportsThirdParty(code) {
  // Regex to match Python imports
  const importRegex = /^\s*(?:import\s+([\w\s,]+)|from\s+(\w+)\s+import)/gm;
  let match;
  const stdlib = new Set([
    'os', 'sys', 'math', 'random', 'datetime', 'time', 'json', 're',
    'collections', 'itertools', 'functools', 'urllib', 'hashlib', 'socket',
    'struct', 'select', 'threading', 'asyncio', 'pathlib', 'sqlite3', 'csv',
    'xml', 'logging', 'argparse', 'glob', 'shutil', 'subprocess', 'tempfile',
    'copy', 'uuid', 'ast', 'weakref', 'types', 'importlib', 'traceback',
    'string', 'io', 'enum', 'dataclasses', 'typing', 'contextlib', 'inspect',
    'unittest', 'http', 'email', 'html', 'secrets', 'statistics', 'decimal',
    'fractions', 'queue', 'signal', 'mmap', 'pickle', 'base64', 'binascii',
    'codecs', 'configparser', 'getopt', 'heapq', 'bisect', 'array', 'cmath',
  ]);

  while ((match = importRegex.exec(code)) !== null) {
    if (match[1]) {
      const names = match[1].split(',').map(n => n.trim().split(/\s+/)[0].split('.')[0]);
      for (const name of names) {
        if (name && !stdlib.has(name)) {
          return true;
        }
      }
    }
    if (match[2]) {
      const name = match[2].trim().split('.')[0];
      if (name && !stdlib.has(name)) {
        return true;
      }
    }
  }
  return false;
}

function stripCommentsAndStrings(code) {
  if (!code) return '';
  let result = '';
  let i = 0;
  const len = code.length;
  while (i < len) {
    if (code[i] === '#') {
      while (i < len && code[i] !== '\n' && code[i] !== '\r') {
        i++;
      }
      continue;
    }
    if (code.startsWith('"""', i)) {
      i += 3;
      while (i < len && !code.startsWith('"""', i)) {
        if (code[i] === '\\' && i + 1 < len) i += 2;
        else i++;
      }
      i += 3;
      continue;
    }
    if (code.startsWith("'''", i)) {
      i += 3;
      while (i < len && !code.startsWith("'''", i)) {
        if (code[i] === '\\' && i + 1 < len) i += 2;
        else i++;
      }
      i += 3;
      continue;
    }
    if (code[i] === '"') {
      i++;
      while (i < len && code[i] !== '"') {
        if (code[i] === '\\' && i + 1 < len) i += 2;
        else i++;
      }
      i++;
      continue;
    }
    if (code[i] === "'") {
      i++;
      while (i < len && code[i] !== "'") {
        if (code[i] === '\\' && i + 1 < len) i += 2;
        else i++;
      }
      i++;
      continue;
    }
    result += code[i];
    i++;
  }
  return result;
}

function findBlockedLibrary(code, files = null) {
  const checkCode = (str) => {
    if (!str) return { blocked: false };
    const stripped = stripCommentsAndStrings(str);

    // 1. Tkinter Check
    if (
      /\bimport\s+tkinter\b/.test(stripped) ||
      /\bfrom\s+tkinter\b/.test(stripped) ||
      /\btkinter\.Tk\b/.test(stripped) ||
      /\bTk\s*\(/.test(stripped) ||
      /\bmainloop\s*\(/.test(stripped)
    ) {
      return { blocked: true, library: "tkinter" };
    }

    // 2. Pygame Check
    if (/\bpygame\.display\.set_mode\b/.test(stripped)) {
      return { blocked: true, library: "pygame" };
    }
    if (/\bpygame\.init\s*\(/.test(stripped)) {
      const hasPygameGUI = [
        /\bpygame\.display\b/,
        /\bpygame\.event\b/,
        /\bpygame\.draw\b/,
        /\bpygame\.key\b/,
        /\bpygame\.mouse\b/,
        /\bpygame\.image\.load\b/
      ].some(pat => pat.test(stripped));
      if (hasPygameGUI) {
        return { blocked: true, library: "pygame" };
      }
    }

    // 3. Turtle Check
    if (
      /\bimport\s+turtle\b/.test(stripped) ||
      /\bfrom\s+turtle\b/.test(stripped) ||
      /\bturtle\.Screen\b/.test(stripped) ||
      /\bturtle\.Turtle\b/.test(stripped) ||
      /\bmainloop\s*\(/.test(stripped)
    ) {
      return { blocked: true, library: "turtle" };
    }

    // 4. OpenCV Check
    if (
      /\bcv2\.imshow\b/.test(stripped) ||
      /\bcv2\.namedWindow\b/.test(stripped) ||
      /\bcv2\.waitKey\b/.test(stripped)
    ) {
      return { blocked: true, library: "cv2-gui" };
    }

    return { blocked: false };
  };

  const mainCheck = checkCode(code);
  if (mainCheck.blocked) return mainCheck;

  if (files) {
    try {
      const normalized = normalizeProjectFiles(files, code);
      for (const file of normalized) {
        const fileCheck = checkCode(file.content);
        if (fileCheck.blocked) return fileCheck;
      }
    } catch (e) {
      // Ignore normalization errors
    }
  }

  return { blocked: false };
}

/**
 * Main execution router: Coordinates sandboxed execution via Judge0
 * and falls back seamlessly to host-based local process execution.
 */
export async function localRunCode({ language, code, files, stdin = '', mainClass, buildTool, cStandard }) {
  if (language === 'python') {
    const check = findBlockedLibrary(code, files);
    if (check.blocked === true) {
      const requestId = Date.now();
      console.log("[BLOCKED LIBRARY]", check.library, requestId);
      return {
        success: false,
        errorType: "BLOCKED_LIBRARY",
        blockedLibrary: check.library,
        message: "GUI libraries are not supported in this online compiler (headless Render environment).",
        suggestion: [
          "Use matplotlib for graphs & visualization",
          "Use pandas for data handling",
          "Use numpy for computations",
          "Use Flask/FastAPI for UI backend",
          "Use Streamlit for dashboards",
          "Use React/HTML frontend for GUI apps"
        ]
      };
    }
  }

  if (language === 'web') {
    return {
      success: true,
      stdout: 'Web stack runs in the browser preview (HTML5, CSS3, Bootstrap, Tailwind, Material UI).',
      stderr: '',
      runner: 'preview',
    };
  }

  if (language === 'c') {
    const localResult = await runCProject({ code, files, stdin, cStandard });
    if (localResult.error !== 'C compiler not found') {
      return localResult;
    }

    const remoteSource = getSingleCSourceForRemote(files, code);
    const langConfig = getLanguageByKey(language);
    if (remoteSource && langConfig?.id) {
      try {
        const remoteResult = await judge0RunCode(langConfig, remoteSource, stdin);
        return {
          ...remoteResult,
          runner: 'judge0',
          warning: 'Local GCC was not found; ran single-file C code with Judge0 instead.',
        };
      } catch (err) {
        return {
          ...localResult,
          diagnostics: [
            ...(localResult.diagnostics || []),
            { message: `Judge0 fallback failed: ${err.message}` },
          ],
        };
      }
    }

    return localResult;
  }

  if (language === 'java') {
    return await runJavaProject({ code, files, stdin, mainClass, buildTool });
  }

  if (files) {
    const projectFiles = normalizeProjectFiles(files, code);
    if (isMultiFileProject(language, projectFiles)) {
      return await runProjectWithFallbacks(language, code, files, stdin);
    }
    const primarySource = extractPrimarySource(projectFiles, language);
    return await runSingleFileWithFallbacks(language, primarySource, stdin);
  }

  return await runSingleFileWithFallbacks(language, code ?? '', stdin);
}

configureExecutionRouter({
  preprocessCode,
  hostRunCode,
  judge0RunCode,
  getSourceFileName,
  findProjectEntry,
  normalizeProjectFiles,
  hostRunProject,
  getProjectRunCommand,
  pythonImportsThirdParty,
});
