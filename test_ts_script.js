import { localRunCode } from './src/services/executionService.js';

async function test() {
  const res = await localRunCode({ language: 'typescript', code: "console.log('TS Test');", files: [], stdin: '' });
  console.log('Result:', res);
}

test();
