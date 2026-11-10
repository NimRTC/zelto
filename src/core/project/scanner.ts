// Project scanner — static analysis of existing codebase
// Walks directory tree, identifies project type, maps modules.
// No LLM calls, no network — pure file-system analysis.

import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, basename, dirname } from 'node:path';
import type { ProjectMap, ProjectModule, ProjectType } from './types.js';

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.zelto', 'dist', 'dist-test', 'build',
  'target', 'venv', '__pycache__', '.next', '.nuxt', 'coverage',
  '.cache', 'tmp', 'out', '.claude',
]);

/**
 * zelto 自己的治理目录 —— 不是被接管的业务代码，不能算作「模块」。
 *
 * 为什么：`policy/` 与 `specs/` 是 zelto 运行时产物（策略真源、切片规格）。
 * 接管既有项目时它们可能已经存在（人先跑过一次 `zelto init`），
 * 若把它们扫成模块：
 *   - 基线切片会给它们开一片 `v0-policy`，把**保护域登记成可写模块** ——
 *     追溯链从此说「policy/policy.yaml 是某片的写集」，与 C5 直接冲突；
 *   - policy.yaml 会给它们生成一条 `allow-write policy/**` 规则，
 *     与同一文件里的 `protect-policy`（deny）自相矛盾。
 *
 * 所以这里在**根层**排除它们。根层之外的同名目录（`src/core/policy/` 之类）
 * 不受影响 —— 那是业务代码，确实该被扫。
 */
const ZELTO_GOVERNANCE_DIRS = new Set(['policy', 'specs']);

const TEST_FILE_PATTERNS = [
  /\.test\./, /\.spec\./, /_test\./, /test_/, /\.test\./, /__tests__\//,
];

const CONFIG_FILES: Record<string, ProjectType> = {
  'package.json': 'node',
  'pyproject.toml': 'python',
  'Cargo.toml': 'rust',
  'go.mod': 'go',
  'CMakeLists.txt': 'cpp',
  'Makefile': 'cpp',
};

/**
 * 根级构建清单文件 —— agent 加模块时必须能改的那几个文件。
 *
 * 为什么需要它：policy 生成时只给「顶层目录」发 allow 规则（`src/**` 等），
 * 根级的构建清单不在任何规则里 → 落到 `default: deny`。于是
 * 「在顶层 CMakeLists.txt 里加一个 module」这种规格里明确要求的动作，
 * 会被 PreToolUse 钩子当场拒掉。接管任何 CMake / npm 项目都会踩到。
 *
 * 按项目类型认，而不是「根目录里出现过的所有已知文件」：
 * 一个仓库里混着别的语言的构建文件（例如前端工程里的 package.json）
 * 不代表它就是该项目的构建入口。
 *
 * 清单只收**枚举源码/依赖/构建目标**的文件：
 *   - 不收 `tsconfig.json` 之类纯编译期配置（不枚举源码）；
 *   - 收 `package.json`（枚举依赖与入口脚本）——
 *     门禁命令本身存在 `.zelto/config.yaml`（保护域），改不到；
 *     逐写判定还会先过「切片写集预约」，写集是人批准的。
 *     这一层是外层粗粒度边界，不是唯一防线。
 */
const ROOT_BUILD_FILES: Record<ProjectType, readonly string[]> = {
  node: ['package.json'],
  python: ['pyproject.toml', 'setup.py'],
  rust: ['Cargo.toml'],
  go: ['go.mod'],
  cpp: ['CMakeLists.txt', 'CMakePresets.json', 'Makefile'],
  unknown: [],
};

/**
 * 探测根级构建清单文件 —— 只返回**实际存在**的那些。
 *
 * 不存在的文件不该出现在规则里：规则写成 allow 但文件不存在，
 * 只会让人误以为「这个项目有根级 Cargo.toml 可以改」。
 */
export function detectRootBuildFiles(rootDir: string, projectType: ProjectType): string[] {
  const candidates = ROOT_BUILD_FILES[projectType] ?? [];
  return candidates.filter((f) => existsSync(join(rootDir, f)));
}

function detectProjectType(rootDir: string): ProjectType {
  for (const [file, type] of Object.entries(CONFIG_FILES)) {
    if (existsSync(join(rootDir, file))) return type;
  }
  return 'unknown';
}

function isTestFile(name: string, relativePath: string): boolean {
  if (TEST_FILE_PATTERNS.some((p) => p.test(relativePath))) return true;
  // Also check if inside a test directory
  if (relativePath.includes('/tests/') || relativePath.includes('/__test__/')) return true;
  return false;
}

function collectFiles(
  dir: string,
  rootDir: string,
  maxDepth: number,
  depth: number = 0,
): { files: string[]; testFiles: string[] } {
  if (depth > maxDepth) return { files: [], testFiles: [] };

  let files: string[] = [];
  let testFiles: string[] = [];

  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const relPath = relative(rootDir, fullPath);

      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          if (IGNORE_DIRS.has(entry)) continue;
          const sub = collectFiles(fullPath, rootDir, maxDepth, depth + 1);
          files = files.concat(sub.files);
          testFiles = testFiles.concat(sub.testFiles);
        } else if (stat.isFile() && !entry.startsWith('.')) {
          if (isTestFile(entry, relPath)) {
            testFiles.push(relPath);
          } else {
            files.push(relPath);
          }
        }
      } catch {
        // permission denied, skip
      }
    }
  } catch {
    // directory not readable, skip
  }

  return { files, testFiles };
}

function detectEntryPoint(moduleDir: string, rootDir: string, projectType: ProjectType): string | null {
  const candidates: string[] = [];
  switch (projectType) {
    case 'node':
      candidates.push('index.ts', 'index.js', 'index.mjs', 'index.cjs');
      break;
    case 'python':
      candidates.push('__init__.py', 'main.py', 'cli.py');
      break;
    case 'rust':
      candidates.push('lib.rs', 'main.rs');
      break;
    case 'go':
      candidates.push('main.go');
      break;
    case 'cpp':
      candidates.push('main.cpp', 'main.cc', 'main.cxx', 'main.c', 'main.hpp');
      break;
  }
  for (const c of candidates) {
    const p = join(moduleDir, c);
    if (existsSync(p)) return relative(rootDir, p);
  }
  return null;
}

function buildModuleTree(
  dir: string,
  rootDir: string,
  projectType: ProjectType,
  depth: number = 0,
): ProjectModule[] {
  const modules: ProjectModule[] = [];

  // Check if this directory itself contains files (flat module like src/*.cpp)
  const selfRelPath = relative(rootDir, dir);
  const { files: selfFiles, testFiles: selfTestFiles } = collectFiles(dir, rootDir, 0);

  try {
    const entries = readdirSync(dir);
    let subdirs: string[] = [];

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      if (IGNORE_DIRS.has(entry)) continue;

      try {
        const s = statSync(fullPath);
        if (!s.isDirectory()) continue;
      } catch { continue; }

      subdirs.push(entry);

      const relPath = relative(rootDir, fullPath);
      const { files, testFiles } = collectFiles(fullPath, rootDir, 8);

      if (files.length === 0 && testFiles.length === 0) {
        // Recurse into empty directories to find deeper modules
        const subs = buildModuleTree(fullPath, rootDir, projectType, depth + 1);
        if (subs.length > 0) modules.push(...subs);
        continue;
      }

      const module: ProjectModule = {
        name: relPath.replace(/\\/g, '/'),
        files: files.map((f) => f.replace(/\\/g, '/')),
        testFiles: testFiles.map((f) => f.replace(/\\/g, '/')),
        entryPoint: detectEntryPoint(fullPath, rootDir, projectType),
        submodules: [],
      };

      // Check for submodules
      const submodules = buildModuleTree(fullPath, rootDir, projectType, depth + 1);
      if (submodules.length > 0) {
        module.submodules = submodules.filter(
          (sm) => files.some((f) => f.startsWith(sm.name + '/')) || sm.files.length > 0,
        );
      }

      modules.push(module);
    }

    // If this directory has files or test files directly and we're not at root, create a self-module
    if ((selfFiles.length > 0 || selfTestFiles.length > 0) && selfRelPath !== '') {
      const selfModule: ProjectModule = {
        name: selfRelPath.replace(/\\/g, '/'),
        files: selfFiles.map((f) => f.replace(/\\/g, '/')),
        testFiles: selfTestFiles.map((f) => f.replace(/\\/g, '/')),
        entryPoint: detectEntryPoint(dir, rootDir, projectType),
        submodules: modules, // Files in subdirectories become submodules
      };
      return [selfModule];
    }
  } catch { /* ignore */ }

  return modules;
}

function detectTestCommand(rootDir: string): string | null {
  if (existsSync(join(rootDir, 'package.json'))) {
    try {
      const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'));
      if (pkg.scripts?.test) return pkg.scripts.test;
      // Detect test framework
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps) {
        if ('vitest' in deps) return 'npx vitest run';
        if ('jest' in deps) return 'npx jest';
        if ('mocha' in deps) return 'npx mocha';
        if ('ava' in deps) return 'npx ava';
      }
      return 'pnpm test';
    } catch { return null; }
  }
  if (existsSync(join(rootDir, 'pyproject.toml'))) return 'pytest';
  if (existsSync(join(rootDir, 'Cargo.toml'))) return 'cargo test';
  if (existsSync(join(rootDir, 'go.mod'))) return 'go test ./...';
  // C++ test detection
  if (existsSync(join(rootDir, 'CMakeLists.txt'))) {
    if (existsSync(join(rootDir, 'build'))) return 'cd build && ctest';
    return 'mkdir -p build && cd build && cmake .. && make && ctest';
  }
  if (existsSync(join(rootDir, 'Makefile'))) return 'make test';
  return null;
}

function detectLintCommand(rootDir: string): string | null {
  if (existsSync(join(rootDir, 'package.json'))) {
    try {
      const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'));
      if (pkg.scripts?.lint) return pkg.scripts.lint;
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps) {
        if ('biome' in deps) return 'npx biome check';
        if ('eslint' in deps) return 'npx eslint .';
        if ('prettier' in deps) return 'npx prettier --check .';
      }
      return null;
    } catch { return null; }
  }
  // C++ lint detection
  if (existsSync(join(rootDir, '.clang-tidy'))) return 'clang-tidy src/**/*.cpp -- -std=c++17';
  if (existsSync(join(rootDir, '.cppcheck'))) return 'cppcheck src/';
  if (existsSync(join(rootDir, 'CMakeLists.txt'))) return null; // no common default
  if (existsSync(join(rootDir, 'Makefile'))) return null;
  return null;
}

export function scanProject(rootDir: string): ProjectMap {
  const projectType = detectProjectType(rootDir);

  // Collect top-level source dirs
  const srcDirs: string[] = [];
  try {
    const entries = readdirSync(rootDir);
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry) || entry.startsWith('.')) continue;
      // 根层的 zelto 治理目录不是业务模块 —— 见 ZELTO_GOVERNANCE_DIRS 的说明
      if (ZELTO_GOVERNANCE_DIRS.has(entry)) continue;
      const fullPath = join(rootDir, entry);
      try {
        if (statSync(fullPath).isDirectory()) {
          srcDirs.push(entry);
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  // Detect config files
  const configFiles: string[] = [];
  for (const cfgName of Object.keys(CONFIG_FILES)) {
    if (existsSync(join(rootDir, cfgName))) configFiles.push(cfgName);
  }
  // Also check for common config files
  for (const cfgName of ['tsconfig.json', '.gitignore', '.env.example', 'Makefile', '.clang-tidy', '.clang-format', '.clangd']) {
    if (existsSync(join(rootDir, cfgName)) && !configFiles.includes(cfgName)) {
      configFiles.push(cfgName);
    }
  }

  // Build module tree from source directories
  const modules: ProjectModule[] = [];
  for (const srcDir of srcDirs) {
    const fullPath = join(rootDir, srcDir);
    const moduleList = buildModuleTree(fullPath, rootDir, projectType);
    modules.push(...moduleList);
  }

  // 根目录下的源码文件也算一个模块。
  //
  // 为什么：扁平结构的项目（文件直接放在仓库根下，没有 src/ 目录）
  // 扫出来的 modules 会是空的 —— 上面那圈只遍历**子目录**，
  // `buildModuleTree` 里的 self-module 分支又明确排除了根目录
  // （`selfRelPath !== ''`）。结果是：这种项目接管后一片基线切片都没有，
  // 追溯链没有起点，后续切片无从对齐写集。
  //
  // 所以这里把根目录自己当作一个模块补上。名字用 `.` 会被后面的
  // id 生成压成 `v0-`，所以给个明确的名字。
  if (modules.length === 0) {
    const { files, testFiles } = collectFiles(rootDir, rootDir, 0);
    // 根目录的「文件」要排除配置文件与元文件 —— package.json、
    // README、.gitignore 这些不是「模块」，算进去基线切片的写集
    // 就太宽了，后面谁都能改这些文件。
    const rootSource = files.filter((f) => {
      const base = f.split('/').pop() ?? f;
      if (base.startsWith('.')) return false;
      if (CONFIG_FILES[base]) return false;
      if (/^(package|tsconfig|Cargo|go|pyproject|setup|Makefile|CMakeLists)/i.test(base)) return false;
      if (/\.(md|txt|json|ya?ml|toml|lock)$/i.test(base)) return false;
      return true;
    });
    const rootTests = testFiles.filter((f) => {
      const base = f.split('/').pop() ?? f;
      return !base.startsWith('.');
    });

    if (rootSource.length > 0 || rootTests.length > 0) {
      modules.push({
        name: '.',
        files: rootSource,
        testFiles: rootTests,
        entryPoint: detectEntryPoint(rootDir, rootDir, projectType),
        submodules: [],
      });
    }
  }

  const testCommand = detectTestCommand(rootDir);
  const lintCommand = detectLintCommand(rootDir);

  return {
    projectName: basename(rootDir),
    projectType,
    rootDir,
    detectedAt: new Date().toISOString(),
    modules,
    configFiles,
    buildTool: projectType === 'node' ? 'tsc'
      : projectType === 'cpp' && existsSync(join(rootDir, 'CMakeLists.txt')) ? 'cmake'
      : projectType === 'cpp' && existsSync(join(rootDir, 'Makefile')) ? 'make'
      : null,
    testCommand,
    lintCommand,
    ignorePatterns: Array.from(IGNORE_DIRS),
  };
}
