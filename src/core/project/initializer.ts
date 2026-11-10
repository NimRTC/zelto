// Project initializer — creates .zelto directory, policy, and config
// for an existing project being brought under zelto governance.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  POLICY_LOCK_PATH,
  computePolicyHash,
  readPolicyLock,
  writePolicyLock,
} from '../policy/lock.js';
import type { ProjectMap, ProjectInitOptions, ProjectInitDeps } from './types.js';
import { detectRootBuildFiles } from './scanner.js';
import {
  extractLegacyAnchor,
  isLegacyConfigContent,
  isLegacyPolicyContent,
  legacyConfigIsRebuildable,
  legacyPolicyIsRebuildable,
} from './legacy-migration.js';

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

/** 策略锚点同步的结果 */
export interface PolicyAnchorOutcome {
  /** `anchored` = 已锚定（新建或重建）；`unchanged` = 锚点与策略一致；`mismatch` = 策略被人改过而锚点没动 */
  status: 'anchored' | 'unchanged' | 'mismatch' | 'no-policy';
  /** 锚点记的哈希 */
  locked: string | null;
  /** 当前策略内容的哈希 */
  current: string | null;
}

/**
 * 同步策略锚点（C5）。
 *
 * 锚点存 `policy/lock.json`，独立于策略本身 —— 策略自己声明自己的哈希是
 * 自证，改策略的人顺手把哈希也改掉就看不出「当时按什么标准拦的」被换过。
 *
 * 口径：
 * - 策略是 zelto 生成的 → 锚点跟着重建（策略变了，锚点必须跟着变；
 *   否则每次接管都会被自己判成「策略被人改过」）；
 * - 策略是人手写的、还没有锚点 → 锚上当前值（给人一个可追溯的起点）；
 * - 策略是人手写的、锚点已经在了 → **一个字都不改**。对不上就是失配，
 *   说明策略被改过而没人承认，由人显式 `zelto policy lock --update` 改锚。
 */
export function syncPolicyAnchor(
  rootDir: string,
  source: 'generated' | 'manual',
): PolicyAnchorOutcome {
  const policyPath = join(rootDir, 'policy', 'policy.yaml');
  if (!existsSync(policyPath)) {
    return { status: 'no-policy', locked: null, current: null };
  }

  const current = computePolicyHash(readFileSync(policyPath, 'utf-8'));
  const lock = readPolicyLock(rootDir);

  if (source === 'generated' || !lock) {
    writePolicyLock(rootDir, {
      version: 1,
      policy: current,
      lockedAt: new Date().toISOString(),
      source,
    });
    return { status: 'anchored', locked: current, current };
  }

  if (lock.policy !== current) {
    // 策略被改过、锚点没动 —— 不自动改锚，改锚是人的决定
    return { status: 'mismatch', locked: lock.policy, current };
  }

  return { status: 'unchanged', locked: lock.policy, current };
}

/** 一次迁移的记录（接管时把老版本生成物升级成当前版本） */
export interface PolicyMigration {
  /** 被迁移的文件 */
  file: string;
  /** 迁移前的样子 */
  from: 'legacy' | 'legacy-anchors';
  /** 迁移后的样子 */
  to: 'generated' | 'external';
  /** 人话说明 */
  detail: string;
}

export async function initializeProject(
  projectMap: ProjectMap,
  options: ProjectInitOptions = { autoDetect: true, policyTemplate: 'default' },
  deps: ProjectInitDeps = {},
): Promise<{ zeltoDir: string; created: string[]; updated: string[]; skipped: string[]; migrated: PolicyMigration[]; anchor: PolicyAnchorOutcome }> {
  const rootDir = projectMap.rootDir;
  const created: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];
  const migrated: PolicyMigration[] = [];

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
  //
  // 老版本 zelto 生成的 config 没有标记行（ADR-040 §3.1），既不是「生成的」
  // 也不是「人写的」—— 单独一档 `legacy`：门禁命令还是通用默认值就重建，
  // 是自定义的就一个字都不动。
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
    const previous = readFileSync(configPath, 'utf-8');
    if (isLegacyConfigContent(previous)) {
      // 老版本生成的 → 看门禁命令还是不是通用默认值（ADR-040 §3.2）
      if (legacyConfigIsRebuildable(previous)) {
        const rebuilt = buildConfigYaml(projectMap, options);
        if (previous !== rebuilt) {
          writeFileSync(configPath, rebuilt, 'utf-8');
          updated.push('.zelto/config.yaml');
          migrated.push({
            file: '.zelto/config.yaml',
            from: 'legacy',
            to: 'generated',
            detail: '老版本 zelto 生成的配置，门禁命令还是通用默认值 → 按真实探测结果重建',
          });
        }
      } else {
        skipped.push('.zelto/config.yaml（老版本 zelto 生成，门禁命令是自定义的，未改动 —— 请人工核对）');
      }
    } else {
      // 人手写的 → 不动，但要让人知道「门禁命令可能与项目不符」
      skipped.push('.zelto/config.yaml（人手写的，未改动）');
    }
  }

  // 3. Create policy/policy.yaml
  const policyDir = join(rootDir, 'policy');
  if (!existsSync(policyDir)) {
    mkdirSync(policyDir, { recursive: true });
    created.push('policy/');
  }

  const policyPath = join(policyDir, 'policy.yaml');
  const policyGenerated = isGeneratedFile(policyPath);
  let policySource: 'generated' | 'manual';
  let legacyAnchor: string | null = null;
  if (!existsSync(policyPath)) {
    writeFileSync(policyPath, buildPolicyYaml(projectMap), 'utf-8');
    created.push('policy/policy.yaml');
    policySource = 'generated';
  } else if (policyGenerated) {
    // 同样是 zelto 生成的 → 按实际模块重建写集规则
    const rebuilt = buildPolicyYaml(projectMap);
    const previous = readFileSync(policyPath, 'utf-8');
    if (previous !== rebuilt) {
      writeFileSync(policyPath, rebuilt, 'utf-8');
      updated.push('policy/policy.yaml');
    }
    policySource = 'generated';
  } else {
    const previous = readFileSync(policyPath, 'utf-8');
    if (isLegacyPolicyContent(previous)) {
      // 老版本生成的策略（ADR-040 §3.2）。
      //
      // 老生成器只给「顶层目录」发规则，根级构建清单不在任何规则里 →
      // 落到 default: deny。规格里明写「在顶层 CMakeLists.txt 注册新模块」，
      // agent 一改就被钩子当场拒掉 —— 接管路径整体走不通。
      //
      // 老锚点先取出来：哪怕这次是**我们**迁移动了策略，策略也「变过了」——
      // 失配要被判出来，而不是被迁移顺手洗掉。
      legacyAnchor = extractLegacyAnchor(previous);
      const rebuilt = buildPolicyYaml(projectMap);
      if (legacyPolicyIsRebuildable(previous, rebuilt)) {
        writeFileSync(policyPath, rebuilt, 'utf-8');
        updated.push('policy/policy.yaml');
        policySource = 'generated';
        migrated.push({
          file: 'policy/policy.yaml',
          from: 'legacy',
          to: 'generated',
          detail: '老版本 zelto 生成的策略，无人工规则 → 按真实模块重建（补上根级构建清单）',
        });
      } else {
        // 含人工规则 → 一个字都不动（C5：策略是保护域的真源）
        skipped.push('policy/policy.yaml（老版本 zelto 生成且含人工规则，未改动 —— 请人工核对）');
        policySource = 'manual';
      }
    } else {
      // 人手写的 policy 是保护域的真源（C5）—— 绝不覆盖
      skipped.push('policy/policy.yaml（人手写的，未改动）');
      policySource = 'manual';
      legacyAnchor = extractLegacyAnchor(previous);
    }
  }

  // 3.5 策略锚点（C5）
  //
  // 锚点存 `policy/lock.json`，独立于策略本身。策略被改过而锚点没动，
  // 就是一件可检出的事（哈希失配）—— 由人显式 `zelto policy lock --update` 改锚。
  //
  // 老版本（ADR-039 之前）把锚点写在策略自己体内的 `anchors:` 段里。
  // 那份锚点不能丢：它记的是「当时按什么标准拦的」。哪怕这次是**我们**
  // 迁移动了策略，策略也「变过了」—— 失配应当被判出来，由人确认后改锚，
  // 而不是被迁移顺手洗掉。所以老锚点搬进 lock.json 之后，
  // 这一轮**不再**自动覆盖它。
  if (legacyAnchor && !readPolicyLock(rootDir)) {
    writePolicyLock(rootDir, {
      version: 1,
      policy: legacyAnchor,
      lockedAt: new Date().toISOString(),
      source: 'manual',
    });
    migrated.push({
      file: POLICY_LOCK_PATH,
      from: 'legacy-anchors',
      to: 'external',
      detail: '老策略内嵌的 anchors 锚点已外部化到 policy/lock.json',
    });
  }

  // 有老锚点时按「人工策略」口径同步 —— 锚点已经在了，一个字都不改，
  // 对不上就报失配（ADR-039 §3.2 的第三条）。
  const anchor = syncPolicyAnchor(rootDir, legacyAnchor ? 'manual' : policySource);
  if (anchor.status === 'anchored') {
    created.push(POLICY_LOCK_PATH);
  } else if (anchor.status === 'mismatch') {
    skipped.push(`${POLICY_LOCK_PATH}（策略已被改动，锚点未更新 —— 确认改动是有意的再跑 zelto policy lock --update）`);
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

  // 6. 迁移留痕（C4）
  //
  // 迁移是一个动作：它动了策略 —— 「当时按什么标准拦的」换过了，
  // 这件事必须事后可查。事件落 `project.policy_migrated`。
  if (migrated.length > 0 && deps.events) {
    await deps.events.append('project', 'project.policy_migrated', 'zelto', {
      migrations: migrated,
    });
  }

  return { zeltoDir, created, updated, skipped, migrated, anchor };
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

  // 根级构建清单 —— 单独一组规则。
  //
  // 为什么必须单独一组：上面的目录规则只覆盖「顶层目录/**」，
  // 根级的构建清单（CMakeLists.txt / package.json / Cargo.toml …）
  // 不在任何目录里，于是落到 `default: deny`。而规格里常明写
  // 「在顶层 CMakeLists.txt 注册新模块」—— agent 一改就被钩子当场拒掉。
  //
  // 用**精确路径**而不是通配：`CMakeLists.txt` 只匹配根级那一个，
  // 子目录里的 CMakeLists.txt 由各自的目录规则管（粒度更细的边界不丢）。
  //
  // 这一层是外层粗边界：真正的精确边界是每个切片的写集预约（人批准的），
  // 以及运行后的 git 审计。门禁命令本身存在 `.zelto/config.yaml`（保护域）。
  const rootBuildFiles = detectRootBuildFiles(projectMap.rootDir, projectMap.projectType);
  const rootBuildRules = rootBuildFiles.map((file, i) => [
    `  - id: allow-write-root-${i}`,
    `    match:`,
    `      path: "${file}"`,
    `      operation: "write"`,
    `    action: allow`,
    `    basis: "policy.yaml#allow-write-root-${i}"`,
    `    reason: "Root build manifest — agents may register new modules here"`,
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
    ...rootBuildRules,
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
    '# 策略哈希锚点不在这里 —— 它独立存放在 policy/lock.json（C5）。',
    '# 锚点写在策略文件里是自证：改策略的人顺手把哈希也改掉，事后就看不出',
    '# 「当时按什么标准拦的」被换过。改策略不改锚点 = 可检出的失配。',
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
