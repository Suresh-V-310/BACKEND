export default {
  id: 54,
  name: 'C++',
  extension: 'cpp',
  monaco: 'cpp',
  compilerOptions: '-std=c++17 -Wall -Wextra -O2 -pthread -lm',
  judge0CompilerOptions: '-std=c++17 -Wall -Wextra -O2 -pthread -lm',
  supportedStandards: ['c++17', 'c++20', 'c++23'],
  defaultCode: `#include <iostream>

int main() {
    std::cout << "Hello, World!" << std::endl;
    return 0;
}
`,
};
