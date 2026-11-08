// Project initializer — creates .zelto directory, policy, and config
// for an existing project being brought under zelto governance.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { ProjectMap, ProjectInitOptions } from './types.js';

/**
 * 自动生成文件的标记。
 *
 * 为什么需要它：`zelto init` 与 `zelto project init` 都会写
 * `.zelto/config.yaml` 与 `policy/policy.yaml`。人先跑了 `zelto init`，
 * 再跑 `project init`（接管既有项目的正常路径）时，文件已存在 ——
 * 旧实现一律跳过，于是接管静默失败：门禁命令还是通用的
 * `pnpm test` / `pnpm lint`，写集规则也没按实际模块生成。
 *
 * 但「文件存在」不等于「不能动」：
 *   - zelto 自己生成、且**此后没被改过** → 可以安全更新（接管就该用真实探测结果）
 *   - 人手写的（或改过的）    → 必须尊重，一个字都不改
 *
 * 怎么判「没被改过」：生成时把**生成内容的哈希**记进文件里
 * （`# zelto:generated:<hash>`）。接管时重新算一遍当前内容的哈希，
 * 与记录的比对：
 *   - 一致 → 文件还是 zelto 留下的原样，可以重建
 *   - 不一致 → 人动过了，不能动
 *
 * 只写「这里是 zelto 生成的」这种标记是不够的：人在 zelto 生成的文件上
 * 加一条自己的规则后，标记还在，但内容已经是人写的了 —— 按标记判断会
 * 覆盖掉人的规则。哈希比对才能真正区分这两种情况。
 *
 * 这是纯文件判定，不调模型、不触网（C3）。
 */
const GENERATED_MARKER_PREFIX = '# zelto:generated:';

/**
 * 生成内容哈希。
 *
 * 用 node 内置的 crypto —— core/ 零第三方依赖（C2）。
 */
function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex').slice(0, 16);
}

/**
 * 生成带哈希标记的内容。
 *
 * 哈希算的是**去掉标记行之后的正文** —— 标记行自己不能参与自己的哈希
 * （否则就成了自指：标记里记的哈希会因为标记本身的存在而对不上）。
 * 所以这里的做法是：先把标记行从正文里摘掉算哈希，再把带哈希的标记行
 * 插回原位。摘掉与插回都必须按「整行」处理，不能按子串处理 ——
 * 否则正文里恰好含有这串文本的行会被误伤。
 */
function withMarker(body: string): string {
  const lines = body.split('\n');
  const markerIdx = lines.findIndex((l) => l.trimStart().startsWith(GENERATED_MARKER_PREFIX));
  if (markerIdx < 0) return body;

  const withoutMarker = lines.filter((_, i) => i !== markerIdx);
  const hash = contentHash(withoutMarker.join('\n'));

  lines[markerIdx] = `${GENERATED_MARKER_PREFIX}${hash}`;
  return lines.join('\n');
}

/**
 * 这个文件是 zelto 自动生成、且此后未被改过吗（因而可以安全重建）？
 *
 * 判据：文件里有一行 `# zelto:generated:<hash>`，且去掉该行后的
 * 正文哈希与记录的一致。
 *
 * 拿不到标记（人手写的文件）、哈希对不上（人改过）→ 一律返回 false，
 * 调用方据此一个字都不动。
 */
function isGeneratedFile(path: string): boolean {
  if (!existsSync(path)) return false;
  let content: string;
  try {
    content = readFileSync(path, 'utf-8');
  } catch {
    return false;
  }

  const lines = content.split('\n');
  const markerIdx = lines.findIndex((l) => l.trimStart().startsWith(GENERATED_MARKER_PREFIX));
  if (markerIdx < 0) return false;

  const recorded = lines[markerIdx].trim().slice(GENERATED_MARKER_PREFIX.length).trim();
  if (!recorded) return false;

  // 去掉标记行再算哈希 —— 标记行自己不能参与自己的哈希。
  //
  // 按**下标**移除，不能按行的值过滤：正文里若恰好有一行与标记行内容
  // 完全相同，按值过滤会把它一起删掉，算出的哈希与生成时对不上 ——
  // 于是「没被人改过的文件」被误判成「人改过」，接管时白白不敢更新。
  // 口径必须与 `withMarker` 一致：那边也是按下标摘掉标记行。
  const withoutMarker = lines.filter((_, i) => i !== markerIdx).join('\n');
  return contentHash(withoutMarker) === recorded;
}

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
): { zeltoDir: string; created: string[]; updated: string[]; skipped: string[] } {
  const rootDir = projectMap.rootDir;
  const created: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];

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
  //
  // 接管既有项目时（`zelto init` 已经建过），要按真实探测结果更新门禁命令 ——
  // 通用的 `pnpm test` 在一个 npm 项目或 Rust 项目上是错的。
  // 但人手写的 config.yaml 一个字都不动。
  const configPath = join(zeltoDir, 'config.yaml');
  const configGenerated = isGeneratedFile(configPath);
  if (!existsSync(configPath)) {
    writeFileSync(configPath, buildConfigYaml(projectMap, options), 'utf-8');
    created.push('.zelto/config.yaml');
  } else if (configGenerated) {
    // zelto 自己生成的 → 用真实探测结果重建门禁命令
    const rebuilt = buildConfigYaml(projectMap, options);
    const previous = readFileSync(configPath, 'utf-8');
    if (previous !== rebuilt) {
      writeFileSync(configPath, rebuilt, 'utf-8');
      updated.push('.zelto/config.yaml');
    }
  } else {
    // 人手写的 → 不动，但要让人知道「门禁命令可能与项目不符」
    skipped.push('.zelto/config.yaml（人手写的，未改动）');
  }

  // 3. Create policy/policy.yaml
  const policyDir = join(rootDir, 'policy');
  if (!existsSync(policyDir)) {
    mkdirSync(policyDir, { recursive: true });
    created.push('policy/');
  }

  const policyPath = join(policyDir, 'policy.yaml');
  const policyGenerated = isGeneratedFile(policyPath);
  if (!existsSync(policyPath)) {
    writeFileSync(policyPath, buildPolicyYaml(projectMap), 'utf-8');
    created.push('policy/policy.yaml');
  } else if (policyGenerated) {
    // 同样是 zelto 生成的 → 按实际模块重建写集规则
    const rebuilt = buildPolicyYaml(projectMap);
    const previous = readFileSync(policyPath, 'utf-8');
    if (previous !== rebuilt) {
      writeFileSync(policyPath, rebuilt, 'utf-8');
      updated.push('policy/policy.yaml');
    }
  } else {
    // 人手写的 policy 是保护域的真源（C5）—— 绝不覆盖
    skipped.push('policy/policy.yaml（人手写的，未改动）');
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

  return { zeltoDir, created, updated, skipped };
}

/**
 * 生成 `.zelto/config.yaml` 的内容。
 *
 * 抽成独立函数是为了「新建」与「接管时重建」走同一份逻辑 ——
 * 否则接管生成的配置会与首次生成的悄悄不同，人看不出差别。
 */
function buildConfigYaml(projectMap: ProjectMap, options: ProjectInitOptions): string {
  const defaultTestCmd = projectMap.projectType === 'cpp' ? detectCppTestCommand() : 'pnpm test';
  const defaultLintCmd = projectMap.projectType === 'cpp' ? '' : 'pnpm lint';
  const testCmd = options.autoDetect && projectMap.testCommand
    ? projectMap.testCommand
    : defaultTestCmd;
  const lintCmd = options.autoDetect && projectMap.lintCommand
    ? projectMap.lintCommand
    : defaultLintCmd;

  return withMarker([
    '# zelto project configuration',
    `# Auto-generated for "${projectMap.projectName}"`,
    GENERATED_MARKER_PREFIX,
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
  ].join('\n'));
}

/**
 * 生成 `policy/policy.yaml` 的内容。
 *
 * 写集规则按探测到的实际模块生成 —— 接管既有项目时，模块目录才是
 * agent 该被允许写的地方。`src/**` 只是兜底（探测不到模块时的默认）。
 */
function buildPolicyYaml(projectMap: ProjectMap): string {
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

  return withMarker([
    '# zelto policy rules',
    `# Auto-generated for "${projectMap.projectName}"`,
    GENERATED_MARKER_PREFIX,
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
  ].join('\n'));
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
