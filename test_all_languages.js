import { localRunCode } from './src/services/executionService.js';
import { LANGUAGES } from './languages/index.js';

// Deprecated: prefer `npm run runtimes:verify` from project root.

async function testAll() {
  console.log("Starting verification for all languages...");
  const keys = Object.keys(LANGUAGES);

  for (const key of keys) {
    const lang = LANGUAGES[key];
    if (!lang) {
      console.error(`ERROR: Language ${key} is not registered in backend!`);
      continue;
    }
    console.log(`\n--------------------------------------------`);
    console.log(`Running ${lang.name}...`);
    try {
      const start = Date.now();
      const result = await localRunCode({ language: key, code: lang.defaultCode });
      const duration = ((Date.now() - start) / 1000).toFixed(2);
      console.log(`Result for ${lang.name} (took ${duration}s):`);
      console.log(`Success: ${result.success}`);
      if (result.stdout) {
        console.log(`STDOUT:\\n${result.stdout.trim()}`);
      }
      if (result.stderr) {
        console.log(`STDERR:\\n${result.stderr.trim()}`);
      }
      if (result.error) {
        console.log(`ERROR FIELD:\\n${result.error}`);
      }
    } catch (err) {
      console.error(`FAILED to execute ${lang.name}:`, err);
    }
  }
}

testAll();
