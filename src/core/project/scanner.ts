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
