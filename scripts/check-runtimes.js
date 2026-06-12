import { execSync } from 'child_process';

const tools = {
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
  docker: ['docker'],
};

function has(command) {
  const probe = process.platform === 'win32' ? `where ${command}` : `command -v ${command}`;
  try {
    execSync(probe, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

for (const [language, commands] of Object.entries(tools)) {
  const missing = commands.filter((command) => !has(command));
  const state = missing.length ? `missing: ${missing.join(', ')}` : 'ready';
  console.log(`${language.padEnd(12)} ${state}`);
}
