import { localRunCode } from './src/services/executionService.js';

async function runTest(name, payload) {
  console.log(`\n==================================================`);
  console.log(`Running Test: ${name}`);
  if (payload.code) {
    console.log(`Code to run:\n${payload.code.trim()}`);
  } else if (payload.files) {
    console.log(`Files to run: ${JSON.stringify(payload.files, null, 2)}`);
  }
  console.log(`--------------------------------------------------`);

  try {
    const start = Date.now();
    const result = await localRunCode({ language: 'java', ...payload });
    const duration = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`Finished in ${duration}s.`);
    console.log(`Success status: ${result.success}`);
    if (result.errorType) {
      console.log(`Error Type: ${result.errorType}`);
    }
    if (result.message) {
      console.log(`Message: ${result.message}`);
    }
    if (result.stdout) {
      console.log(`STDOUT:\n${result.stdout.trim()}`);
    }
    if (result.stderr) {
      console.log(`STDERR:\n${result.stderr.trim()}`);
    }
    if (result.error) {
      console.log(`ERROR Field:\n${result.error}`);
    }
  } catch (err) {
    console.error('Test execution failed with error:', err);
  }
}

async function startTests() {
  // Test 1: Single File Java Execution (Success)
  await runTest('Single-File Java Execution (Success)', {
    code: `
public class Main {
    public static void main(String[] args) {
        System.out.println("Hello from Local Java runner!");
        System.out.println("Java version: " + System.getProperty("java.version"));
    }
}
`
  });

  // Test 2: Single File Java Execution (Compilation Error)
  await runTest('Single-File Java Execution (Compilation Error)', {
    code: `
public class Main {
    public static void main(String[] args) {
        System.out.println("Missing semicolon")
    }
}
`
  });

  // Test 3: Missing main() Method Validation Check
  await runTest('Java Execution (Missing main method)', {
    code: `
public class Main {
    public void hello() {
        System.out.println("No main method here");
    }
}
`
  });
}

startTests();
