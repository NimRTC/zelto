// ADR-039 的五处收尾 —— 接管既有项目这条主路径上的剩余缺口
//
// 这组用例锁住五件事，每一件都是「人第一次真用 zelto 接管自己的项目」时会撞上的：
//
// 1. **基线切片要落事件（C4）** —— 登记现状是「追溯链的起点」这个动作，
//    动作本身必须留痕。事件流是追溯的唯一证据载体，没事件的登记等于没发生过。
//
// 2. **策略锚点要独立于策略（C5）** —— 锚点写在策略文件里是自证：
//    改策略的人顺手把哈希也改掉，事后看不出「当时按什么标准拦的」被换过。
//    锚点独立存放在 policy/lock.json，改策略不改锚点 = 可检出的失配。
//
// 3. **规格文件不该挡住合并** —— 合并守卫拦的是「人改了代码还没提交」；
//    规格文件不是代码，合并不会碰它。接管既有项目时基线规格是新建文件，
//    人还没来得及提交 —— 把它算成「工作区不干净」，合并就永远过不去。
//
// 4. **两条初始化入口要一致** —— `zelto init` 与 `zelto project init`
//    必须产出同一份基线切片，否则人先跑 init 再跑 project init 会看到
//    两次不同的登记记录，追溯链说不清。
//
// 5. **基线写集用目录通配** —— 基线标的是「这一片涵盖哪些既有代码」；
//    用具体文件的话，模块里此后新增的文件就落在基线范围之外。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

import { initializeProject } from '../src/core/project/initializer.js';
import { scanProject } from '../src/core/project/scanner.js';
import { planBaselineSlices, registerBaselineSlices } from '../src/core/project/baseline.js';
import { isZeltoManagedSpecPath } from '../src/core/project/managed-paths.js';
import { checkPolicyAnchor, computePolicyHash, readPolicyLock } from '../src/core/policy/lock.js';
import { SliceStore } from '../src/core/slice/store.js';
import { EventStream } from '../src/core/events/stream.js';

const TEST_DIR = join(tmpdir(), `zelto-takeover-followups-${Date.now()}`);
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
async function writeDemoProject(dir: string): Promise<void> {
  await mkdir(join(dir, 'src', 'core'), { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    `{ "name": "demo", "version": "1.0.0", "scripts": { "test": "npm test" } }`,
    'utf-8',
  );
  await writeFile(join(dir, 'src', 'core', 'a.ts'), 'export const a = 1;\n', 'utf-8');
  await writeFile(join(dir, 'src', 'core', 'b.ts'), 'export const b = 2;\n', 'utf-8');
}

describe('ADR-039 · 基线切片要落事件（C4）', () => {
  let dir: string;

  before(async () => {
    dir = join(TEST_DIR, 'events');
    await mkdir(dir, { recursive: true });
    await writeDemoProject(dir);
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('登记基线切片时追加 slice.baseline_registered 事件', async () => {
    const store = new SliceStore(join(dir, '.zelto', 'slices'));
    const events = new EventStream(join(dir, '.zelto', 'events'));

    const result = await registerBaselineSlices(scanProject(dir), {
      store,
      events,
      specsDir: join(dir, 'specs', 'slices'),
    });

    assert.ok(result.created.length > 0, '应当登记出基线切片');
    const plan = result.created[0];

    const log = await events.read(plan.id);
    const registered = log.find((e) => e.type === 'slice.baseline_registered');
    assert.ok(registered, `基线切片必须有登记事件，实际事件：${log.map((e) => e.type).join(', ')}`);
    assert.equal(registered!.actor, 'zelto');
    assert.equal(registered!.payload.module, plan.moduleName);
    assert.ok(Array.isArray(registered!.payload.writes), '事件里要带上写集');
  });

  it('CLI：project init 落的事件在事件流文件里', async () => {
    const cliDir = join(TEST_DIR, 'events-cli');
    await mkdir(cliDir, { recursive: true });
    await writeDemoProject(cliDir);

    const { code } = await runCli(cliDir, 'project', 'init');
    assert.equal(code, 0, 'project init 应成功');

    const eventFile = join(cliDir, '.zelto', 'events', 'v0-src-core', 'events.jsonl');
    assert.ok(existsSync(eventFile), `基线切片的事件文件应存在：${eventFile}`);

    const lines = readFileSync(eventFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    const registered = lines.find((l: { type: string }) => l.type === 'slice.baseline_registered');
    assert.ok(registered, '事件流里应有 slice.baseline_registered');
  });
});

describe('ADR-039 · 策略锚点独立于策略（C5）', () => {
  let dir: string;

  before(async () => {
    dir = join(TEST_DIR, 'anchor');
    await mkdir(dir, { recursive: true });
    await writeDemoProject(dir);
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('初始化会写 policy/lock.json，锚点值就是当前策略的哈希', async () => {
    await initializeProject(scanProject(dir), { autoDetect: true, policyTemplate: 'default' });

    const lockPath = join(dir, 'policy', 'lock.json');
    assert.ok(existsSync(lockPath), `锚点文件应存在：${lockPath}`);

    const lock = readPolicyLock(dir);
    assert.ok(lock, '锚点应能读出来');
    const policyHash = computePolicyHash(readFileSync(join(dir, 'policy', 'policy.yaml'), 'utf-8'));
    assert.equal(lock!.policy, policyHash, '锚点记的哈希应等于当前策略内容的哈希');
    assert.equal(lock!.source, 'generated', 'zelto 生成的策略，锚点来源是 generated');
  });

  it('人手写的策略：第一次接管时锚上，改过之后失配且不自动改锚', async () => {
    const manualDir = join(TEST_DIR, 'anchor-manual');
    await mkdir(join(manualDir, 'policy'), { recursive: true });
    await writeFile(
      join(manualDir, 'policy', 'policy.yaml'),
      'rules:\n  - id: allow-src\n    match:\n      path: "src/**"\n    action: allow\n    basis: "policy.yaml#allow-src"\n',
      'utf-8',
    );
    await writeDemoProject(manualDir);

    await initializeProject(scanProject(manualDir), { autoDetect: true, policyTemplate: 'default' });

    const lock = readPolicyLock(manualDir);
    assert.ok(lock, '人手写的策略也要有锚点');
    assert.equal(lock!.source, 'manual', '人手写策略的锚点来源是 manual');

    // 人改策略 → 锚点不动 → 失配
    await writeFile(
      join(manualDir, 'policy', 'policy.yaml'),
      'rules:\n  - id: allow-src\n    match:\n      path: "src/**"\n    action: allow\n    basis: "policy.yaml#allow-src"\n  - id: extra\n    match:\n      path: "lib/**"\n    action: deny\n    basis: "policy.yaml#extra"\n',
      'utf-8',
    );

    const status = checkPolicyAnchor(manualDir);
    assert.equal(status.mismatch, true, '策略被改过而锚点没动 = 失配');

    // 再跑一次接管：失配要被报告出来，但锚点一个字都不改
    const result = await initializeProject(scanProject(manualDir), { autoDetect: true, policyTemplate: 'default' });
    assert.equal(result.anchor.status, 'mismatch', '接管不应自动改锚');
    assert.ok(
      result.skipped.some((s) => s.includes('lock.json')),
      `失配要被明确报告出来，实际：${JSON.stringify(result.skipped)}`,
    );
    assert.equal(readPolicyLock(manualDir)!.policy, lock!.policy, '锚点值不能被接管改掉');
  });

  it('CLI：policy lock 报失配（退出码 1），--update 改锚后一致', async () => {
    const cliDir = join(TEST_DIR, 'anchor-cli');
    await mkdir(cliDir, { recursive: true });
    await writeDemoProject(cliDir);

    await runCli(cliDir, 'init');

    const before = await runCli(cliDir, 'policy', 'lock');
    assert.equal(before.code, 0, `锚点一致时退出码 0，实际输出：${before.stdout}`);

    await writeFile(
      join(cliDir, 'policy', 'policy.yaml'),
      'rules:\n  - id: allow-src\n    match:\n      path: "src/**"\n    action: allow\n    basis: "policy.yaml#allow-src"\n',
      'utf-8',
    );

    const mismatch = await runCli(cliDir, 'policy', 'lock');
    assert.equal(mismatch.code, 1, '失配时退出码应为 1');
    assert.ok(mismatch.stdout.includes('失配'), `应说明失配，实际：${mismatch.stdout}`);

    // validate 只判「策略文件本身是否合法」——失配不改变它的退出码，
    // 但必须把失配说出来（判与报分开，不藏）。
    const validate = await runCli(cliDir, 'policy', 'validate');
    assert.equal(validate.code, 0, 'validate 只判策略本身，锚点失配不该让它失败');
    assert.ok(validate.stdout.includes('失配'), `validate 应报出锚点失配，实际：${validate.stdout}`);

    const validateJson = await runCli(cliDir, 'policy', 'validate', '--json');
    assert.equal(validateJson.code, 0);
    const parsed = JSON.parse(validateJson.stdout) as {
      valid: boolean;
      anchor?: { mismatch: boolean; status: string };
    };
    assert.equal(parsed.valid, true, '策略本身合法');
    assert.equal(parsed.anchor?.mismatch, true, 'JSON 输出要带上锚点失配状态');
    assert.equal(parsed.anchor?.status, 'mismatch');

    const update = await runCli(cliDir, 'policy', 'lock', '--update');
    assert.equal(update.code, 0, '显式改锚应成功');

    const after = await runCli(cliDir, 'policy', 'lock');
    assert.equal(after.code, 0, '改锚后应一致');
    assert.equal(checkPolicyAnchor(cliDir).mismatch, false);
  });
});

describe('ADR-039 · 规格文件不该挡住合并', () => {
  it('只认仓库根下的 specs/ 树', () => {
    assert.equal(isZeltoManagedSpecPath('specs/slices/v0-src-core.md'), true);
    assert.equal(isZeltoManagedSpecPath('./specs/slices/v0-src-core.md'), true);
    assert.equal(isZeltoManagedSpecPath('specs\\slices\\v0-src-core.md'), true);
    // git 会把未跟踪目录折叠成目录本身
    assert.equal(isZeltoManagedSpecPath('specs/'), true);
    assert.equal(isZeltoManagedSpecPath('specs/slices/'), true);
    assert.equal(isZeltoManagedSpecPath('src/specs/slices/x.md'), false);
    assert.equal(isZeltoManagedSpecPath('src/core/a.ts'), false);
    assert.equal(isZeltoManagedSpecPath('specs/other/x.md'), false);
  });
});

describe('ADR-039 · 两条初始化入口产出同一份基线', () => {
  let dir: string;

  before(async () => {
    dir = join(TEST_DIR, 'parity');
    await mkdir(dir, { recursive: true });
    await writeDemoProject(dir);
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('zelto init 也登记基线切片（且与 project init 同源）', async () => {
    const initDir = join(TEST_DIR, 'parity-init');
    await mkdir(initDir, { recursive: true });
    await writeDemoProject(initDir);

    const { code, stdout } = await runCli(initDir, 'init');
    assert.equal(code, 0, `init 应成功，实际输出：${stdout}`);

    const sliceFile = join(initDir, '.zelto', 'slices', 'v0-src-core.json');
    assert.ok(existsSync(sliceFile), `init 也应登记基线切片：${sliceFile}`);

    const slice = JSON.parse(readFileSync(sliceFile, 'utf-8'));
    assert.equal(slice.state, 'completed', '基线切片是既成事实');
    assert.equal(slice.baseline, true);
    assert.ok(
      slice.writes.includes('src/core/**'),
      `写集应是模块目录通配，实际：${JSON.stringify(slice.writes)}`,
    );

    // 与 project init 的判定同源：同一个扫描结果，推出同一份计划
    const plans = planBaselineSlices(scanProject(initDir));
    const plan = plans.find((p) => p.moduleName === 'src/core');
    assert.ok(plan, '扫描结果应推出 src/core 的基线');
    assert.deepEqual(slice.writes, plan!.writes, '两条入口的写集口径必须一致');
  });

  it('两条入口产出的基线切片 id 一致（不会各登一份）', async () => {
    const initDir = join(TEST_DIR, 'parity-init');
    const projectDir = join(TEST_DIR, 'parity-project');
    await mkdir(projectDir, { recursive: true });
    await writeDemoProject(projectDir);

    await runCli(projectDir, 'project', 'init');

    const initSlices = readdirSyncJson(join(initDir, '.zelto', 'slices'));
    const projectSlices = readdirSyncJson(join(projectDir, '.zelto', 'slices'));
    assert.deepEqual(
      initSlices.filter((f) => f.startsWith('v0-')).sort(),
      projectSlices.filter((f) => f.startsWith('v0-')).sort(),
      '两条入口的基线切片 id 必须一致',
    );
  });
});

/** 列目录下的 .json 文件名 */
function readdirSyncJson(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json'));
}
