import { hostRunProject } from './src/services/executionService.js';
(async () => {
  const code = `function greet(name: string): string { return \`Hello ${name}!\`; }
const add = (a: number, b: number): number => a + b;
console.log(greet('Developer'));
console.log(add(5,10));`;
  const result = await hostRunProject('typescript', code, [], '');
  console.log('Result:', JSON.stringify(result, null, 2));
})();
