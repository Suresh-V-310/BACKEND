export default {
  id: 50,
  name: 'C',
  extension: 'c',
  monaco: 'c',
  compilerOptions: '-std=c17 -Wall -Wextra -O2 -pthread -lm',
  judge0CompilerOptions: '-std=c17 -Wall -Wextra -O2 -pthread -lm',
  supportedStandards: ['c11', 'c17', 'c23'],
  defaultCode: `#include <stdio.h>

int main() {
    printf("Learning C is Easy");
    return 0;
}
`,
};
