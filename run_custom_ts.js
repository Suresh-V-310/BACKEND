import { localRunCode } from './src/services/executionService.js';

async function run() {
  const code = `
    const message: string = "Start small. Ship something.";
    console.log(message);
    let age: number = 25;
    let isCoding: boolean = true;
    let skills: string[] = ["TypeScript", "JavaScript", "Node"];
  `;
  const result = await localRunCode({ language: 'typescript', code, files: [], stdin: '' });
  console.log('Result:', result);
}

run();
