// Project initializer — creates .zelto directory, policy, and config
// for an existing project being brought under zelto governance.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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

  return { zeltoDir, created };
}
