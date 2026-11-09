// 接管既有项目这条主路径的三道闸门
//
// 这组用例锁住三件事，都是「接管既有项目」这条路真正走不通时暴露出来的：
//
// 1. **`project init` 要能接管，而不是静默失败**（事项一）。
//    人先跑 `zelto init`（建目录）再跑 `project init`（接管）时，
//    门禁命令与写集规则必须按**真实探测结果**更新 —— 通用的 `pnpm test`
//    在一个 npm 项目上是错的。但人手写的文件一个字都不改。
//    判据是「zelto 生成的、且此后没被改过」，靠生成内容哈希比对
//    （`# zelto:generated:<hash>` 标记行），不靠「文件存在与否」。
//
// 2. **基线切片是追溯链的起点**（事项一续）。
//    接管既有项目的第一步不是「写新代码」，而是「把现有代码登记进来」——
//    否则追溯链没有起点，后续切片无从对齐写集。这一步刻意不依赖 LLM：
//    它表达的是「这个模块现在有哪些文件」，扫描已经拿到了这个事实。
//    同时：zelto 自己的治理目录（`policy/`、`specs/`）**不能**被当成
//    业务模块 —— 那会把保护域登记成可写模块，与 C5 直接冲突。
//
// 3. **`spec confirm` 不确认注定不能用的规格**（事项二）。
//    草稿里若没有可物化的需求条目，确认之后冻结必然被追溯闸门拒掉 ——
//    人被引导确认了一份废规格，然后卡在下一步，还不知道问题出在哪。
//    拦在「确认」这一道：那是人批准规格的瞬间，也是最后能改内容的瞬间。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

import { initializeProject } from '../src/core/project/initializer.js';
import { scanProject } from '../src/core/project/scanner.js';
import { planBaselineSlices, baselineSliceId } from '../src/core/project/baseline.js';

const TEST_DIR = join(tmpdir(), `zelto-takeover-test-${Date.now()}`);
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');

function runCli(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI_SCRIPT, ...args], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ZELTO_SKIP_LLM: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    child.on('error', reject);
    setTimeout(() => { child.kill(); reject(new Error('timeout')); }, 20000).unref();
  });
}

/** 写一个最小可用的 node 项目 */
async function writeDemoProject(dir: string, testScript = 'npm test'): Promise<void> {
  await mkdir(join(dir, 'src', 'core'), { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    `{ "name": "demo", "version": "1.0.0", "scripts": { "test": ${JSON.stringify(testScript)} } }`,
    'utf-8',
  );
  await writeFile(join(dir, 'src', 'core', 'a.ts'), 'export const a = 1;\n', 'utf-8');
  await writeFile(join(dir, 'src', 'core', 'b.ts'), 'export const b = 2;\n', 'utf-8');
}

describe('接管既有项目 · 初始化能接管而不是静默失败', () => {
  let dir: string;

  before(async () => {
    dir = join(TEST_DIR, 'init');
    await mkdir(dir, { recursive: true });
    await writeDemoProject(dir);
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('生成的 config.yaml 带哈希标记行（判据是内容，不是「文件存在」）', async () => {
    const map = scanProject(dir);
    initializeProject(map, { autoDetect: true, policyTemplate: 'default' });

    const config = await readFile(join(dir, '.zelto', 'config.yaml'), 'utf-8');
    assert.ok(
      config.includes('# zelto:generated:'),
      '生成的 config.yaml 必须留标记行，否则接管时无法区分「zelto 生成的」与「人手写的」',
    );
  });

  it('zelto 生成的文件被接管重建：门禁命令按真实探测结果更新', async () => {
    const map = scanProject(dir);
    initializeProject(map, { autoDetect: true, policyTemplate: 'default' });

    // 第一次生成用的是探测结果 —— 这里必须是 npm test 而不是通用的 pnpm test
    let config = await readFile(join(dir, '.zelto', 'config.yaml'), 'utf-8');
    assert.ok(config.includes('run: npm test'), `门禁命令应是探测到的 npm test，实际：\n${config}`);

    // 改项目实际情况（换测试命令）→ 重新接管 → config 必须跟着更新
    await writeDemoProject(dir, 'vitest run');
    const map2 = scanProject(dir);
    const result = initializeProject(map2, { autoDetect: true, policyTemplate: 'default' });

    assert.ok(result.updated.includes('.zelto/config.yaml'), 'zelto 生成的 config 应被更新');
    config = await readFile(join(dir, '.zelto', 'config.yaml'), 'utf-8');
    assert.ok(config.includes('run: vitest run'), `门禁命令应更新为 vitest run，实际：\n${config}`);
  });

  it('人改过的 config.yaml 一个字都不动（接管不能覆盖人的意图）', async () => {
    const map = scanProject(dir);
    initializeProject(map, { autoDetect: true, policyTemplate: 'default' });

    const configPath = join(dir, '.zelto', 'config.yaml');
    const original = (await readFile(configPath, 'utf-8')).replace('run: vitest run', 'run: my-own-test');
    await writeFile(configPath, original, 'utf-8');

    const result = initializeProject(scanProject(dir), { autoDetect: true, policyTemplate: 'default' });

    assert.ok(!result.updated.includes('.zelto/config.yaml'), '人改过的 config 不能被更新');
    assert.ok(
      result.skipped.some((s) => s.includes('config.yaml')),
      '跳过时要明说，否则人以为接管成了',
    );
    const after = await readFile(configPath, 'utf-8');
    assert.equal(after, original, '人改过的 config 必须逐字不变');
  });

  it('人改过的 policy.yaml 一个字都不动（策略真源不可被接管覆盖）', async () => {
    const policyPath = join(dir, 'policy', 'policy.yaml');
    const original = `# 我手写的策略\nrules: []\n`;
    await writeFile(policyPath, original, 'utf-8');

    const result = initializeProject(scanProject(dir), { autoDetect: true, policyTemplate: 'default' });

    assert.ok(!result.updated.includes('policy/policy.yaml'), '人手写的 policy 不可被更新');
    const after = await readFile(policyPath, 'utf-8');
    assert.equal(after, original, '人手写的 policy 必须逐字不变');
  });

  it('.gitignore 补上 .zelto/（否则工作区永远不干净，合并永远被守卫拦下）', async () => {
    const dir2 = join(TEST_DIR, 'gitignore');
    await mkdir(dir2, { recursive: true });
    await writeDemoProject(dir2);

    initializeProject(scanProject(dir2), { autoDetect: true, policyTemplate: 'default' });

    const gitignore = await readFile(join(dir2, '.gitignore'), 'utf-8');
    assert.ok(gitignore.includes('.zelto/'), '.gitignore 必须包含 .zelto/');
  });
});

describe('接管既有项目 · 基线切片是追溯链的起点', () => {
  let dir: string;

  before(async () => {
    dir = join(TEST_DIR, 'baseline');
    await mkdir(dir, { recursive: true });
    await writeDemoProject(dir);
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('扫描结果推出基线切片计划（每个叶子模块一片）', () => {
    const map = scanProject(dir);
    const plans = planBaselineSlices(map);

    assert.ok(plans.length > 0, '接管既有项目必须能推出基线切片，否则追溯链没有起点');
    const srcCore = plans.find((p) => p.moduleName === 'src/core');
    assert.ok(srcCore, 'src/core 应成为一片基线切片');
    // 写集口径是**目录通配**（ADR-039 §4）：基线标的是「这一片涵盖哪些既有代码」，
    // 用具体文件的话，模块里此后新增的文件就落在基线范围之外。
    assert.ok(
      srcCore!.writes.includes('src/core/**'),
      `基线切片的写集应覆盖该模块目录，实际：${JSON.stringify(srcCore!.writes)}`,
    );
    // 登记时点的文件清单单独留在 plan 里，供人核对
    assert.ok(
      srcCore!.files.some((f) => f.endsWith('a.ts')) && srcCore!.files.some((f) => f.endsWith('b.ts')),
      `基线切片应记下该模块现有文件，实际：${JSON.stringify(srcCore!.files)}`,
    );
  });

  it('zelto 自己的治理目录不进基线切片（否则保护域被登记成可写模块）', async () => {
    // 先建出 zelto 自己的目录，模拟「人先跑过一次 init」
    await mkdir(join(dir, 'policy'), { recursive: true });
    await writeFile(join(dir, 'policy', 'policy.yaml'), 'rules: []\n', 'utf-8');
    await mkdir(join(dir, 'specs', 'slices'), { recursive: true });
    await writeFile(join(dir, 'specs', 'slices', 'x.md'), '# spec\n', 'utf-8');

    const map = scanProject(dir);
    const plans = planBaselineSlices(map);

    const moduleNames = plans.map((p) => p.moduleName);
    assert.ok(!moduleNames.includes('policy'), `policy/ 是 zelto 治理目录，不该成为模块：${moduleNames}`);
    assert.ok(!moduleNames.includes('specs'), `specs/ 是 zelto 治理目录，不该成为模块：${moduleNames}`);

    // 写集里更不能出现保护域路径
    for (const p of plans) {
      for (const w of p.writes) {
        assert.ok(!w.startsWith('policy/'), `基线切片写集不能含保护域路径：${w}`);
      }
    }
  });

  it('基线切片 id 合法且不重名', () => {
    assert.equal(baselineSliceId('src/core'), 'v0-src-core');
    assert.equal(baselineSliceId('.'), 'v0-root');
    assert.ok(!baselineSliceId('src/core').includes('/'), 'id 里不能有路径分隔符');
  });

  it('CLI：project init 生成基线切片，状态直接是 completed（既成事实，不是待办的活）', async () => {
    const dir2 = join(TEST_DIR, 'cli-baseline');
    await mkdir(dir2, { recursive: true });
    await writeDemoProject(dir2);

    const { stdout, code } = await runCli(dir2, 'project', 'init');
    assert.equal(code, 0, `project init 应成功：\n${stdout}`);

    const slicesDir = join(dir2, '.zelto', 'slices');
    const files = (await readFile(slicesDir + '/v0-src-core.json', 'utf-8'));
    const slice = JSON.parse(files);
    assert.equal(slice.state, 'completed');
    assert.equal(slice.baseline, true);
    assert.ok(slice.trace.requirements.length > 0, '基线切片的追溯起点是「现状」');
    assert.ok(slice.traceWaiver, '基线切片要写明为何不需要契约追踪');
    assert.ok(existsSync(join(dir2, 'specs', 'slices', 'v0-src-core.md')), '基线切片的规格文件要落盘');
  });
});

describe('接管既有项目 · spec confirm 不确认注定不能用的规格', () => {
  let dir: string;

  before(async () => {
    dir = join(TEST_DIR, 'confirm');
    await mkdir(dir, { recursive: true });
    await writeDemoProject(dir);
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('没有需求条目时 confirm 被拒，正式规格不落盘', async () => {
    await runCli(dir, 'init');
    await runCli(dir, 'create', 'no-req');

    await runCli(dir, 'spec', 'draft', 'no-req');
    const { code, stdout } = await runCli(dir, 'spec', 'confirm', 'no-req');

    assert.equal(code, 1, '没有可物化的需求追溯时 confirm 必须拒绝');
    assert.ok(stdout.includes('TRACE') || stdout.includes('需求'), `要明说为什么被拒：\n${stdout}`);
    assert.ok(
      !existsSync(join(dir, 'specs', 'slices', 'no-req.md')),
      '被拒的确认不能写进正式规格 —— 那份规格是「人批准的出处」',
    );
  });

  it('有需求条目时 confirm 通过，规格逐字落盘', async () => {
    await runCli(dir, 'create', 'with-req', '--requirement', 'REQ-1');

    await runCli(dir, 'spec', 'draft', 'with-req');
    const { code } = await runCli(dir, 'spec', 'confirm', 'with-req');
    assert.equal(code, 0, '有需求时 confirm 应通过');

    const specPath = join(dir, 'specs', 'slices', 'with-req.md');
    assert.ok(existsSync(specPath), '确认后规格要落到正式路径');
    const draft = await readFile(join(dir, '.zelto', 'drafts', 'specs', 'with-req.md'), 'utf-8');
    const formal = await readFile(specPath, 'utf-8');
    assert.equal(formal, draft, '正式规格应与草稿逐字一致');
  });

  it('确认的判据与冻结准入同源（不会出现「confirm 说行、freeze 说不行」）', async () => {
    await runCli(dir, 'create', 'no-req2');
    await runCli(dir, 'spec', 'draft', 'no-req2');

    // 人工在草稿里补一条编号验收标准 → 它就是可物化的需求出处
    const draftPath = join(dir, '.zelto', 'drafts', 'specs', 'no-req2.md');
    let draft = readFileSync(draftPath, 'utf-8');
    draft = draft.replace(
      '## 验收标准\n（待人确认：本片尚无已批准的需求条目，验收标准需人补齐后再确认规格）',
      '## 验收标准\n1. 用户能登录\n2. 密码错误时返回 401',
    );
    await writeFile(draftPath, draft, 'utf-8');

    const { code } = await runCli(dir, 'spec', 'confirm', 'no-req2');
    assert.equal(code, 0, '草稿里补了编号验收标准后应能确认');

    // 冻结也要过 —— 两处判据同源
    const frozen = await runCli(dir, 'freeze', 'no-req2');
    assert.equal(frozen.code, 0, `冻结也应通过：\n${frozen.stdout}\n${frozen.stderr}`);
  });
});
