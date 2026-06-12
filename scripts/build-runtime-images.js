import { execSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import path from 'path';

function hasDocker() {
  try {
    execSync(process.platform === 'win32' ? 'where docker' : 'command -v docker', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

if (!hasDocker()) {
  console.error('Docker is not installed or not on PATH.');
  process.exit(1);
}

const dockerRoot = path.resolve('docker');
const runtimes = readdirSync(dockerRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(path.join(dockerRoot, entry.name, 'Dockerfile')))
  .map((entry) => entry.name);

for (const runtime of runtimes) {
  const tag = `compiler/${runtime}:latest`;
  const dir = path.join(dockerRoot, runtime);
  console.log(`Building ${tag} from ${dir}`);
  execSync(`docker build -t ${tag} ${dir}`, { stdio: 'inherit' });
}
