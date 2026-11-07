// Project initializer — creates .zelto directory, policy, and config
// for an existing project being brought under zelto governance.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import type { ProjectMap, ProjectInitOptions } from './types.js';

/**
 * Check if a build tool is available on the system.
 */
function toolExists(name: string): boolean {
  try {
    execSync(`${process.platform === 'win32' ? 'where' : 'which'} ${name}`, { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect available C++ build tools and generate an appropriate test command.
 */
function detectCppTestCommand(): string {
  const hasCmake = toolExists('cmake');
  if (!hasCmake) {
    return 'echo "⚠️  cmake not found — skipping C++ build"';
  }

  // Detect available build generators
  const generators: string[] = [];
  if (toolExists('ninja')) generators.push('ninja');
  if (toolExists('make')) generators.push('make');
  if (process.platform === 'win32') {
    if (toolExists('nmake')) generators.push('nmake');
    // MSBuild detection via vswhere
    try {
      execSync('where msbuild 2>nul || where MSBuild.exe 2>nul', { stdio: 'ignore', timeout: 5000 });
      generators.push('MSBuild');
    } catch { /* msbuild not found */ }
  }

  if (generators.length === 0) {
    return 'mkdir -p build && cd build && cmake .. && echo "⚠️  No build generator found (install make, ninja, or MSBuild)"';
  }

  // Prefer ninja > make > nmake > MSBuild
  const preferredGen = generators[0];
  const genFlag = preferredGen === 'ninja' ? '-GNinja'
    : preferredGen === 'make' ? ''
    : preferredGen === 'nmake' ? '-GNMake Makefiles'
    : preferredGen === 'MSBuild' ? '-G "Visual Studio 17 2022"'
    : '';

  const buildCmd = preferredGen === 'ninja' ? 'ninja'
    : preferredGen === 'MSBuild' ? 'msbuild'
    : preferredGen;

  return `mkdir -p build && cd build && cmake .. ${genFlag} && ${buildCmd} && ctest`;
}

export function initializeProject(
  projectMap: ProjectMap,
  options: ProjectInitOptions = { autoDetect: true, policyTemplate: 'default' },
): { zeltoDir: string; created: string[] } {
  const rootDir = projectMap.rootDir;
  const created: string[] = [];

  // 1. Create .zelto directory structure
  const zeltoDir = join(rootDir, '.zelto');
  const subdirs = ['slices', 'events', 'versions', 'designs', 'requirements'];
  for (const sub of subdirs) {
    const d = join(zeltoDir, sub);
    if (!existsSync(d)) {
      mkdirSync(d, { recursive: true });
      created.push(`.zelto/${sub}/`);
    }
  }

  // 2. Create .zelto/config.yaml
  const configPath = join(zeltoDir, 'config.yaml');
  if (!existsSync(configPath)) {
    const defaultTestCmd = projectMap.projectType === 'cpp' ? detectCppTestCommand() : 'pnpm test';
    const defaultLintCmd = projectMap.projectType === 'cpp' ? '' : 'pnpm lint';
    const testCmd = options.autoDetect && projectMap.testCommand
      ? projectMap.testCommand
      : defaultTestCmd;
    const lintCmd = options.autoDetect && projectMap.lintCommand
      ? projectMap.lintCommand
      : defaultLintCmd;

    const configYaml = [
      '# zelto project configuration',
      `# Auto-generated for "${projectMap.projectName}"`,
      '',
      'gate:',
      '  commands:',
      `    - name: test`,
      `      run: ${testCmd}`,
      `    - name: lint`,
      `      run: ${lintCmd}`,
      '  timeoutSec: 120',
      '  retry:',
      '    max: 2',
      '',
      '# 切片级验收（ADR-033，默认关闭）。打开后门禁②会额外跑本片自己的验收目标，',
      '# 跑不起来就判失败（fail closed）。{acceptance} 会替换成验收目标里的具体测试文件。',
      '# acceptance:',
      '#   command: "node --test {acceptance}"',
      '#   required: true',
      'agent:',
      '  command: "npx @anthropic-ai/claude-code"',
      '',
      '# Budget limit in USD per slice (0 = unlimited)',
      'budgetLimitUsd: 1.0',
      '',
    ].join('\n');
    writeFileSync(configPath, configYaml, 'utf-8');
    created.push('.zelto/config.yaml');
  }

  // 3. Create policy/policy.yaml
  const policyDir = join(rootDir, 'policy');
  if (!existsSync(policyDir)) {
    mkdirSync(policyDir, { recursive: true });
    created.push('policy/');
  }

  const policyPath = join(policyDir, 'policy.yaml');
  if (!existsSync(policyPath)) {
    // Build source path patterns from project modules
    const srcPatterns = new Set<string>();
    srcPatterns.add('src/**');
    for (const mod of projectMap.modules) {
      const topDir = mod.name.split('/')[0];
      if (topDir && !topDir.startsWith('.')) srcPatterns.add(`${topDir}/**`);
    }

    // Build write rules from source patterns
    const writeRules = Array.from(srcPatterns).map((pattern, i) => [
      `  - id: allow-write-${i}`,
      `    match:`,
      `      path: "${pattern}"`,
      `      operation: "write"`,
      `    action: allow`,
      `    basis: "policy.yaml#allow-write-${i}"`,
      `    reason: "Source directory — agents may write"`,
      '',
    ].join('\n'));

    const policyYaml = [
      '# zelto policy rules',
      `# Auto-generated for "${projectMap.projectName}"`,
      '',
      'rules:',
      '',
      ...writeRules,
      '  - id: allow-read-all',
      '    match:',
      '      path: "**"',
      '      operation: "read"',
      '    action: allow',
      '    basis: "policy.yaml#allow-read-all"',
      '    priority: 0',
      '    reason: "All files are readable"',
      '',
      '  - id: protect-policy',
      '    match:',
      '      path: "policy/**"',
      '    action: deny',
      '    basis: "policy.yaml#protect-policy"',
      '    reason: "Policy directory is the truth source"',
      '',
      '  - id: protect-zelto',
      '    match:',
      '      path: ".zelto/**"',
      '    action: deny',
      '    basis: "policy.yaml#protect-zelto"',
      '    reason: "zelto state is managed by zelto itself"',
      '',
      '  - id: protect-agents',
      '    match:',
      '      path: "AGENTS.md"',
      '    action: deny',
      '    basis: "policy.yaml#protect-agents"',
      '    reason: "Project instructions are read-only"',
      '',
      'anchors:',
      '  policy: "sha256:init"',
      '',
    ].join('\n');
    writeFileSync(policyPath, policyYaml, 'utf-8');
    created.push('policy/policy.yaml');
  }

  // 4. Save project map
  const mapPath = join(zeltoDir, 'project-map.json');
  if (!existsSync(mapPath)) {
    writeFileSync(mapPath, JSON.stringify(projectMap, null, 2), 'utf-8');
    created.push('.zelto/project-map.json');
  }

  // 5. Ensure .gitignore covers zelto's own runtime state.
  //
  // 为什么必须做：zelto 的状态写在 `.zelto/` 里，而合并有前置条件——
  // 主仓工作区必须干净（`merge-executor.ts` 的守卫）。人第一次
  // `git add -A` 会把 `.zelto/` 连同里面的 worktree 一起提交，
  // worktree 还是个嵌套 git 仓库，git 会直接拒绝或警告。
  // 之后每次跑 zelto 都会改动 `.zelto/`，工作区永远不干净，
  // 于是合并永远被守卫拦下——人得先搞清楚「为什么要 ignore .zelto/」。
  //
  // 只追加 zelto 需要的条目，不动用户已有的规则。
  created.push(...ensureGitignore(rootDir));

  return { zeltoDir, created };
}

/** zelto 运行时产物必须忽略的路径 */
const GITIGNORE_ENTRIES = [
  // zelto 状态目录：切片、事件、锁、会话、worktree、看板产物
  '.zelto/',
];

/**
 * 把 zelto 需要的条目补进 `.gitignore`（不存在就新建）。
 *
 * 只追加缺失的条目，不改写用户已有的内容——`.gitignore` 是用户的文件，
 * zelto 只负责往里加自己需要的那几行。
 */
export function ensureGitignore(rootDir: string): string[] {
  const path = join(rootDir, '.gitignore');
  const created: string[] = [];

  let existing = '';
  if (existsSync(path)) {
    try {
      existing = readFileSync(path, 'utf-8');
    } catch {
      existing = '';
    }
  }

  const present = new Set(
    existing
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#')),
  );

  const missing = GITIGNORE_ENTRIES.filter((e) => !present.has(e));
  if (missing.length === 0) return created;

  const header = existing.length === 0
    ? '# zelto 运行时产物（不入库）\n'
    : '';
  const addition = `${header}${missing.join('\n')}\n`;

  try {
    // 追加而不是覆盖：用户已有的规则一个字都不动
    appendFileSync(path, addition, 'utf-8');
    created.push('.gitignore');
  } catch {
    // 写不了 .gitignore 不阻断初始化——项目仍可用，只是要人自己加
  }

  return created;
}
