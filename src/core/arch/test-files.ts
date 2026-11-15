// 测试文件识别（ADR-066）
//
// 架构扫描的核心前提：**依赖边 = 生产代码之间的耦合**。
// 而测试文件引用被测对象是测试的**本职** —— 它不构成架构耦合，
// 只构成「这条契约有人验着」。
//
// 真实项目里的证据（nimrtc-zelto 实战演练）：
//
//   src/plugins/tests/test_zero_copy_surface_path.cpp
//       #include <nimrtc/video_frame/frame.hpp>
//
// 这一行产生了 `src/plugins → src/modules` 边，进而伪造出两个
// 「依赖成环」，并让「修这个违反的切片」自己被该违反拦住 —— 死锁。
//
// 识别方式必须是**确定性命名约定**，不能靠内容猜测：
// 看文件里有没有 `test(` / `assert` / `TEST_F` 这类 token，
// 会把含断言的普通源文件误判成测试。

/** 测试目录名（路径的任一段匹配即算） */
const TEST_DIR_NAMES = new Set(['test', 'tests', 'testing', 'spec', 'specs', '__tests__']);

/**
 * 测试文件名的**前缀**约定：`test_foo.cpp` / `testFoo.cpp`
 */
const TEST_FILE_PREFIX = /^test[_\-.]/i;

/**
 * 测试文件名的**后缀**约定：
 *   - `foo_test.cpp` / `foo-test.cpp`（C/C++/Go 生态）
 *   - `FooTest.cpp` / `FooTests.java`（Java 生态）
 *   - `foo_spec.rb`（Ruby 生态）
 */
const TEST_FILE_SUFFIX = /(_test|_tests|-test|-tests|_spec)\.[^.]+$/i;

/** PascalCase 生态的测试后缀：`FooTest.cs` / `FooTests.ts` */
const TEST_CLASS_SUFFIX = /Tests?\.[^.]+$/;

/**
 * 是不是测试目录（路径的任一段）。
 *
 * 只认**整段等于**约定名 —— `src/testing_utils/` 是生产代码目录，
 * `src/contest/` 也是。只有 `test_` 结尾的目录段单独处理
 * （见 `isTestPath`）。
 */
function isTestDirSegment(segment: string): boolean {
  return TEST_DIR_NAMES.has(segment.toLowerCase());
}

/**
 * 目录段以 `test_` 开头（`testdata/` 除外 —— 那是测试数据，不是测试代码）。
 *
 * `testdata/` 是 Go 生态的惯例（测试用固定输入数据），
 * 它是**数据**不是测试代码，不该被排除出依赖图。
 */
function isTestPrefixedDir(segment: string): boolean {
  const lower = segment.toLowerCase();
  if (lower === 'testdata' || lower === 'test-fixtures' || lower === 'testfixtures') return false;
  return lower.startsWith('test_') || lower.startsWith('test-');
}

/**
 * 是不是测试文件（相对项目根，正斜杠路径）。
 *
 * 两层判定：
 *   1. **目录级** —— 路径里任一段是测试目录 → 是测试文件
 *   2. **文件名级** —— 文件名符合测试命名约定 → 是测试文件
 *
 * 目录级优先于文件名级：两者都成立时结果一致，
 * 只有文件名级成立时也成立。
 */
export function isTestFile(path: string): boolean {
  const segments = path.split('/');
  const fileName = segments[segments.length - 1] ?? '';

  // 目录级：除了最后一段（文件名），其它段任一命中即是
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (isTestDirSegment(segment) || isTestPrefixedDir(segment)) return true;
  }

  // 文件名级
  const stem = fileName.replace(/\.[^.]+$/, '');
  if (TEST_FILE_PREFIX.test(stem)) return true;
  if (TEST_FILE_SUFFIX.test(fileName)) return true;
  if (TEST_CLASS_SUFFIX.test(fileName)) return true;
  if (/^tests?$/i.test(stem)) return true;

  return false;
}

/**
 * 一组路径里哪些是测试文件。
 *
 * 单独暴露是为了让调用点把「哪些被排除」讲清楚 ——
 * 报告里要能说出「本项目有多少测试文件被排除出依赖图」。
 */
export function partitionTestFiles(paths: string[]): { testFiles: string[]; productionFiles: string[] } {
  const testFiles: string[] = [];
  const productionFiles: string[] = [];
  for (const path of paths) {
    if (isTestFile(path)) testFiles.push(path);
    else productionFiles.push(path);
  }
  return { testFiles, productionFiles };
}
