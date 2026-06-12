import { localRunCode } from './src/services/executionService.js';

(async () => {
  const result = await localRunCode({ language: 'typescript', code: "console.log('TS Hello');" });
  console.log('Result:', result);
})();
