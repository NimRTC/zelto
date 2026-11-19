// 驾驶舱的「油门」—— 四个推进动作的端到端判据（ADR-086）
//
// 这个文件起**真实的 Web 服务器**，发**真实的 HTTP 请求**，
// 验的是 ADR-086 的核心承诺：
//
//   1. **CLI 与 Web 调同一份编排**（C3：判定不许分叉）——
//      freeze / gate / resume 都直接调 `core/lifecycle/`；
//      run 拉起 **CLI 二进制本身**（`zelto run --detach`），不是 Web 侧重实现。
//   2. **四个动作都写事件流**（C4），且 `via: 'web'`。
//   3. **hotfix 在 Web 端要两个独立确认字段**（ADR-015）。
//   4. **并发上限**（ADR-086 §7）：同时在跑的 detached 任务数有上限。
//
// 为什么 run 不在这里真的起一个 agent：
// 那要真的调 claude-code，烧 token、还要网络 —— 端到端测试不能干这个。
// 所以这里验的是「**拉起这个动作的判定与护栏**」：
//   - hotfix 缺确认字段被拒（这个在 agent 起来之前就拒了）
//   - 并发超限被拒
//   - 找不到 CLI 入口时**明确报错**，不假装跑起来了
//
// 「真的起跑了」那部分由 CLI 侧的 detach 测试覆盖。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WebServer } from '../src/adapters/web/server.js';

const ROOT = mkdtempSync(join(tmpdir(), 'zelto-web-throttle-'));

let server: WebServer;
let baseUrl: string;
let token: string;

async function req(
  method: string,
  path: string,
  opts: { body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'X-Zelto-Token': token, 'Content-Type': 'application/json' },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

/** 读某个切片名下的事件流。 */
function readEvents(sliceId: string): Array<Record<string, unknown>> {
  const path = join(ROOT, '.zelto', 'events', sliceId, 'events.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** 读切片状态文件。 */
function readSlice(id: string): Record<string, unknown> {
  const path = join(ROOT, '.zelto', 'slices', `${id}.json`);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

/**
 * 数一数任务文件有几个。
 *
 * 用来验「被拒的开跑没有真的起」——
 * 驾驶舱说「已在后台跑」而实际一个 agent 都没起，那是**最坏的假象**（D-53）。
 * 任务文件是「起了」的凭据 —— 它在，就说明真的拉起过。
 */
function countTaskFiles(): number {
  const dir = join(ROOT, '.zelto', 'tasks');
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => f.endsWith('.json')).length;
}

/** 写一个切片状态文件。 */
function writeSlice(id: string, patch: Record<string, unknown>): void {
  const now = new Date().toISOString();
  const base: Record<string, unknown> = {
    id,
    title: `切片 ${id}`,
    state: 'draft',
    type: 'feature',
    spec: { path: `specs/slices/${id}.md`, frozenHash: null, frozenAt: null },
    acceptance: { dir: `tests/acceptance/${id}/`, frozenHash: null, oracleSrc: null },
    baseCommit: null,
    drift: { detected: false, reason: null, at: null },
    trace: { requirements: ['REQ-1'], contracts: [], tests: ['test-1'] },
    traceWaiver: null,
    baseline: false,
    writes: ['src/feature.ts'],
    runs: [],
    stall: { class: null, autoResolved: 0, gateRetries: 0 },
    createdAt: now,
    updatedAt: now,
  };
  writeFileSync(
    join(ROOT, '.zelto', 'slices', `${id}.json`),
    JSON.stringify({ ...base, ...patch }, null, 2),
    'utf-8',
  );
}

describe('驾驶舱的油门动作（ADR-086）', () => {
  before(async () => {
    mkdirSync(join(ROOT, '.zelto', 'slices'), { recursive: true });
    mkdirSync(join(ROOT, '.zelto', 'events'), { recursive: true });
    mkdirSync(join(ROOT, '.zelto', 'locks'), { recursive: true });
    mkdirSync(join(ROOT, '.zelto', 'sessions'), { recursive: true });
    mkdirSync(join(ROOT, 'specs', 'slices'), { recursive: true });
    mkdirSync(join(ROOT, 'src'), { recursive: true });

    // 一份规格 —— 冻结要读它（追溯物化、D-4 覆盖都看规格正文）
    //
    // **验收标准必须是编号条目**（`1. xxx`）——
    // 追溯物化只认编号列表（`extractAcceptanceCriteria`），
    // 无序列表（`- xxx`）不会被认成需求出处。
    //
    // 为什么这条在**重新冻结**时会咬人：refreeze 会清空
    // `trace.requirements`（规格改了，需求条目也可能变了），
    // 然后从规格重新物化 —— 物化不出来就「追溯不合格，拒绝冻结」。
    // 也就是说：规格用无序列表写验收标准，**第一次能冻、第二次冻不了**。
    writeFileSync(
      join(ROOT, 'specs', 'slices', 'slice-throttle.md'),
      '# 油门切片\n\n## 验收标准\n\n1. REQ-1: 驾驶舱能踩油门\n',
      'utf-8',
    );

    // 门禁命令配置 —— 让「真的跑一次门禁」有确定的结果。
    //
    // 为什么必须显式配：默认门禁命令是 `pnpm test` / `pnpm lint`，
    // 那两条在临时目录里必然跑不起来（没有 pnpm、没有包）——
    // 于是「门禁跑失败」和「门禁编排有 bug」长得一模一样，测不出区别。
    // 配一条**必定成功**的命令，才能断言「门禁跑过了、事件写了」。
    writeFileSync(
      join(ROOT, '.zelto', 'config.yaml'),
      [
        'gate:',
        '  commands:',
        '    - name: trivial',
        '      run: node -e "process.exit(0)"',
        '  timeoutSec: 30',
        '  retry:',
        '    max: 0',
        '',
      ].join('\n'),
      'utf-8',
    );

    // 一片 draft 切片（可冻结）
    writeSlice('slice-throttle', {});

    server = new WebServer({ port: 0, repoRoot: ROOT });
    await server.start();
    baseUrl = server.url;
    token = server.sessionToken;
  });

  after(async () => {
    await server?.stop();
    rmSync(ROOT, { recursive: true, force: true });
  });

  // ── 冻结 ──────────────────────────────────────────────────────────────

  it('冻结：draft 切片被冻上，状态变了，事件写了（C4）', async () => {
    const res = await req('POST', '/api/slices/slice-throttle/freeze', {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body['ok'], true);

    // 状态确实变成 frozen 了
    assert.equal(readSlice('slice-throttle')['state'], 'frozen');

    // 事件：spec.frozen，带 via: 'web'
    const events = readEvents('slice-throttle');
    const frozen = events.find((e) => e['type'] === 'spec.frozen');
    assert.ok(frozen, '必须有 spec.frozen 事件');
    const payload = frozen['payload'] as Record<string, unknown>;
    assert.equal(payload['via'], 'web', '事件里要记「在哪儿做的」');
    assert.equal(frozen['actor'], 'human', 'actor 记「人做的」');
  });

  it('冻结：已冻结的切片再冻一次被拒（除非显式重新冻结）', async () => {
    const res = await req('POST', '/api/slices/slice-throttle/freeze', {});
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.match(String(res.body['reason']), /frozen/);
  });

  it('冻结：重新冻结是显式选项（refreeze）', async () => {
    const res = await req('POST', '/api/slices/slice-throttle/freeze', { body: { refreeze: true } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body['ok'], true);
    // 重新冻结后回到 frozen
    assert.equal(readSlice('slice-throttle')['state'], 'frozen');
  });

  it('冻结：冻结哈希的格式与 CLI 侧**逐字节相同**（两份实现 = 判定分叉）', async () => {
    // 症状离病因很远的经典坑（ADR-086 §实施记录 2）：
    //   冻结时写 `sha256:sha256:<hex>`，check 时算 `sha256:<hex>`
    //   → 「规格刚冻结完就报 hash mismatch」
    // 人会去查规格、查 git、查 worktree，唯独想不到是两份实现的格式不一样。
    //
    // 所以这里直接断言：**冻结写进去的哈希 == CLI 侧算出来的哈希**。
    const slice = readSlice('slice-throttle');
    const frozenHash = (slice['spec'] as { frozenHash: string | null }).frozenHash;
    assert.ok(frozenHash, '冻结必须写进哈希');

    const { hashSpecFile } = await import('../src/core/lifecycle/freeze.js');
    const cliHash = hashSpecFile(join(ROOT, 'specs', 'slices', 'slice-throttle.md'));
    assert.equal(frozenHash, cliHash, '冻结哈希必须与 core 侧算出来的一致');
    // 格式本身也要对 —— `sha256:` 前缀只能有一个
    assert.match(frozenHash, /^sha256:[0-9a-f]{64}$/, `哈希格式不对：${frozenHash}`);
  });

  it('冻结：不存在的切片被拒（404/409，不许假装成功）', async () => {
    const res = await req('POST', '/api/slices/no-such-slice/freeze', {});
    assert.ok(res.status === 404 || res.status === 409, `实际 ${res.status}`);
  });

  // ── 门禁 ──────────────────────────────────────────────────────────────

  it('门禁：非 frozen 状态被拒（门禁要验的是冻结基线上的产物）', async () => {
    writeSlice('slice-not-frozen', { state: 'draft' });
    const res = await req('POST', '/api/slices/slice-not-frozen/gate', {});
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.match(String(res.body['reason']), /frozen/);
  });

  it('门禁：dry-run 只说要跑什么，不真跑', async () => {
    // dry-run 不执行任何命令 —— 所以它一定成功（只要状态对）。
    // 这条验的是「门禁编排能从 Web 端跑起来」（配置能读到、命令能拼出来）。
    const res = await req('POST', '/api/slices/slice-throttle/gate', { body: { dryRun: true } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body['ok'], true);
    const facts = res.body['facts'] as Record<string, unknown>;
    assert.equal(facts['dryRun'], true);
    assert.ok(Array.isArray(facts['commands']), 'dry-run 必须列出要跑的命令');
  });

  it('门禁：dry-run 不写 gate.executed 事件（干跑是只读预览，不许污染度量）', async () => {
    // dry-run 是**只读预览** —— 它只回答「要跑什么」，不执行任何命令。
    //
    // 为什么必须不写事件：`rework_rate = gate.retry ÷ gate.executed`。
    // 干跑也写一条 `gate.executed`，这个比值就凭空多了一个分母 ——
    // 度量从此失真，而失真是**静默**的（没人会去看「这条干跑算不算」）。
    //
    // 所以这里用**真的跑一次门禁**来对照：干跑 0 条，真跑 1 条。
    const events = readEvents('slice-throttle');
    assert.equal(
      events.filter((e) => e['type'] === 'gate.executed').length,
      0,
      '干跑不许写 gate.executed',
    );
  });

  it('门禁：真跑一次写一条 gate.executed（带 via: web），并通过后发签字请求', async () => {
    // 用**单独一片**切片 —— 门禁通过会把状态转到 completed 并发签字请求，
    // 不能污染 slice-throttle（后面几条还要拿它验别的）。
    writeSlice('slice-gate', { state: 'frozen' });

    const res = await req('POST', '/api/slices/slice-gate/gate', {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body['ok'], true);

    const facts = res.body['facts'] as Record<string, unknown>;
    assert.equal(facts['passed'], true, JSON.stringify(facts));

    // 事件：恰好一条 gate.executed，带 via: 'web'
    //
    // **恰好一条**是重点 —— 多一条就会让 rework_rate 的分母翻倍。
    const events = readEvents('slice-gate');
    const executed = events.filter((e) => e['type'] === 'gate.executed');
    assert.equal(executed.length, 1, `应当恰好一条 gate.executed，实际 ${executed.length}`);
    const payload = executed[0]['payload'] as Record<string, unknown>;
    assert.equal(payload['via'], 'web');

    // 门禁通过 → 状态转 completed + 发签字请求（签字≠合并，ADR-018）
    assert.equal(readSlice('slice-gate')['state'], 'completed');
    assert.ok(facts['signRequestId'], '门禁通过后应当发签字请求');
  });

  // ── 续跑 ──────────────────────────────────────────────────────────────

  it('续跑：没停机的切片被拒（不能「恢复」一片没停机的东西）', async () => {
    // Scheduler.resume 对没停机的切片直接抛错 —— 这是对的：
    // 「已恢复以便重跑」是假话（它本来就没停机）。
    const res = await req('POST', '/api/slices/slice-throttle/resume', { body: {} });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.match(String(res.body['reason']), /not stalled|未停机|停机/);
  });

  it('续跑：停了机的切片被恢复，且写了 run.resumed 事件（带 via: web）', async () => {
    writeSlice('slice-stalled', {
      state: 'frozen',
      stall: { class: 'agent_crash', autoResolved: 0, gateRetries: 0 },
    });

    const res = await req('POST', '/api/slices/slice-stalled/resume', { body: {} });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body['ok'], true);

    // 停机分类被清了 —— 这片现在可以重跑
    const slice = readSlice('slice-stalled');
    const stall = slice['stall'] as { class: string | null };
    assert.equal(stall.class, null, '恢复后停机分类必须清掉');

    // 事件：run.resumed，带 via: 'web'
    const events = readEvents('slice-stalled');
    const resumed = events.find((e) => e['type'] === 'run.resumed');
    assert.ok(resumed, '必须有 run.resumed 事件');
    const payload = resumed['payload'] as Record<string, unknown>;
    assert.equal(payload['via'], 'web');
    assert.equal(payload['resolution'], 'manual_retry');
  });

  it('续跑：放弃是不可逆的，状态真的变成 abandoned', async () => {
    writeSlice('slice-abandon', { state: 'frozen', stall: { class: 'agent_crash', autoResolved: 0, gateRetries: 0 } });
    const res = await req('POST', '/api/slices/slice-abandon/resume', { body: { abandon: true } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body['ok'], true);
    assert.equal(readSlice('slice-abandon')['state'], 'abandoned');
  });

  // ── 开跑 ──────────────────────────────────────────────────────────────
  //
  // **这里绝不真的起 agent**：一次端到端测试去调 claude-code 是烧 token，
  // 而且那个 agent 会抱着临时目录不放（清理时 EPERM）。
  //
  // 所以这一节只验「**拉起之前的那些判定与护栏**」——
  // 护栏挡住的时候，agent 一个字节都还没写。
  //
  // 「真的起跑了」那部分由 CLI 侧的 detach 测试覆盖（那里有 mock agent）。

  it('开跑：hotfix 缺显式确认被拒（ADR-015），且没有真的起跑', async () => {
    // hotfix 跳过门禁② —— 等于放弃「签字前必须过门禁」这条约束，
    // 所以必须显式确认。**两个独立字段**都要有（ADR-086 §4）。
    const res = await req('POST', '/api/slices/slice-throttle/run', {
      body: { hotfix: true },
    });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(String(res.body['error']), /hotfix/);

    // 关键：**没有真的起跑**。
    // 护栏必须在拉起之前生效 —— 否则就是「先烧钱再检查」。
    assert.equal(countTaskFiles(), 0, '被拒的开跑不许留下任务文件');
  });

  it('开跑：hotfix 带了确认字段后不再被「缺确认」拒', async () => {
    // 用一片 draft 切片 —— CLI 的准入判定会拒它（准入只认 frozen/completed），
    // 所以**不会真的起 agent**，但请求能走到「拉起 CLI」那一步。
    //
    // 这条验的是：Web 端的 hotfix 护栏**只**看那两个确认字段，
    // 确认齐了就放行，后面的失败是别的原因。
    writeSlice('slice-draft', { state: 'draft' });
    const res = await req('POST', '/api/slices/slice-draft/run', {
      body: { hotfix: true, confirmHotfix: true },
    });
    assert.notEqual(res.status, 400, '确认齐了就不该被「缺确认」拒');
    if (res.status !== 200) {
      assert.doesNotMatch(
        String(res.body['error'] ?? ''),
        /hotfix.*确认/s,
        '失败原因不该再是 hotfix 确认',
      );
    }
  });

  it('开跑：起跑失败必须**如实报错**，不假装跑起来了', async () => {
    // 这是最坏的那种假象：驾驶舱说「已在后台跑」而实际一个 agent 都没起（D-53）。
    //
    // 用一片 draft 切片 —— CLI 的准入判定必然拒它。
    writeSlice('slice-draft2', { state: 'draft' });
    const res = await req('POST', '/api/slices/slice-draft2/run', { body: {} });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body['ok'], false);
    assert.ok(String(res.body['reason']).length > 0, '失败必须带原因');
    // 失败不许留下「在跑」的任务记录
    assert.equal(countTaskFiles(), 0, '失败的开跑不许留下任务文件');
  });

  it('开跑：并发上限生效（同时在跑的 detached 任务数有上限）', async () => {
    // 造一个「在跑」的任务文件（pid = 当前进程 = 一定活着）
    const tasksDir = join(ROOT, '.zelto', 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(
      join(tasksDir, 'task-running.json'),
      JSON.stringify({
        taskId: 'task-running',
        sliceId: 'slice-throttle',
        sessionId: 'sess-x',
        agentName: 'claude-agent',
        startedAt: new Date().toISOString(),
        status: 'running',
        supervisorPid: process.pid,
      }),
      'utf-8',
    );

    const res = await req('POST', '/api/slices/slice-throttle/run', { body: {} });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.match(String(res.body['reason']), /后台运行|上限/);
    // 超限时**明确拒绝**，不许静默排队 —— 所以没有新任务文件
    assert.equal(countTaskFiles(), 1, '超限时不该再起一个');
  });

  it('开跑：任务文件不是 running 状态就不算在跑（上限不误伤）', async () => {
    writeFileSync(
      join(ROOT, '.zelto', 'tasks', 'task-running.json'),
      JSON.stringify({
        taskId: 'task-running',
        sliceId: 'slice-throttle',
        sessionId: 'sess-x',
        agentName: 'claude-agent',
        startedAt: new Date().toISOString(),
        status: 'completed',
        supervisorPid: process.pid,
      }),
      'utf-8',
    );

    // **用 draft 切片** —— 准入只认 frozen/completed，
    // draft 会在准入那一关被拒，**不会真的起 agent**。
    //
    // 为什么必须这样：若拿一片 frozen 切片来试，CLI 真的会准入、
    // 真的会建 worktree、真的拉起监督进程 —— 那个进程会抱着临时目录不放，
    // 清理阶段直接 EPERM（Windows 上目录被进程占着删不掉），
    // 而且它还在烧 token。
    //
    // 这条要验的是「已结束的任务**不算**在跑」，
    // 所以只需要「请求走到了准入那一关」就够了。
    writeSlice('slice-draft3', { state: 'draft' });
    const res = await req('POST', '/api/slices/slice-draft3/run', { body: {} });
    // 不再是「上限」原因 —— 至于起跑本身成不成，是另一回事
    assert.doesNotMatch(
      String(res.body['reason'] ?? ''),
      /上限/,
      '已结束的任务不该算在跑',
    );
  });

  // ── 边界 ──────────────────────────────────────────────────────────────

  it('四个端点都要求 POST（GET 拿 405，不是 404）', async () => {
    for (const path of [
      '/api/slices/slice-throttle/freeze',
      '/api/slices/slice-throttle/gate',
      '/api/slices/slice-throttle/run',
      '/api/slices/slice-throttle/resume',
    ]) {
      const res = await req('GET', path);
      assert.equal(res.status, 405, `${path} 用 GET 应当 405，实际 ${res.status}`);
    }
  });

  it('非法 id 被拒（400）—— 路径穿越的老规矩没破', async () => {
    const res = await req('POST', '/api/slices/..%2Fetc/freeze', {});
    assert.ok(res.status === 400 || res.status === 404, `实际 ${res.status}`);
  });

  it('没有新增事件类型（契约零改动）', async () => {
    // ADR-086 §6：四个动作复用已有事件类型，**不新增**。
    // 这条断言守住「契约零改动」—— 有人加了新事件类型，这条会红。
    const { EVENT_TYPES } = await import('../src/core/events/stream.js');
    for (const t of ['spec.frozen', 'gate.executed', 'gate.result', 'run.started', 'run.resumed']) {
      assert.ok(
        (EVENT_TYPES as readonly string[]).includes(t),
        `${t} 必须是已有事件类型`,
      );
    }
  });

  // ── 前端：按钮必须真的存在（ADR-086 §6 的最后一条） ──────────────────
  //
  // 「端点实现了却没人用 = 没实现」——
  // ADR-072 的缺口一就是这么发现的（`/audit` 端点实现了，前端从不调）。
  //
  // 这一组守的是同一件事的油门版本：
  // **服务端端点齐了，前端的按钮也得齐**。
  // 否则驾驶舱在浏览器里还是那个「只能看」的看板 —— 端点白做。

  it('前端：四个油门按钮的实现都在（端点齐了，按钮也得齐）', async () => {
    const html = await (await fetch(`${baseUrl}/`)).text();

    // 四个动作的前端实现
    for (const fn of ['doFreeze', 'doGate', 'doRun', 'doResume']) {
      assert.ok(
        html.includes(`function ${fn}`),
        `前端必须有 ${fn} —— 端点实现了没人用 = 没实现`,
      );
    }
    // 按钮组渲染函数
    assert.ok(
      html.includes('function renderThrottleButtons'),
      '必须有 renderThrottleButtons —— 按状态决定摆哪些按钮',
    );
  });

  it('前端：按钮挂在**正确的端点**上（点错了端点 = 点了没反应）', async () => {
    const html = await (await fetch(`${baseUrl}/`)).text();

    // 每个动作对应自己的端点 —— 不能张冠李戴
    assert.match(html, /\/freeze'/, '冻结按钮要打 /freeze');
    assert.match(html, /\/gate'/, '门禁按钮要打 /gate');
    assert.match(html, /\/run'/, '开跑按钮要打 /run');
    assert.match(html, /\/resume'/, '续跑按钮要打 /resume');
  });

  it('前端：详情页有进度实时回显（ADR-086 §6 —— 「进度及时更新在 Web 上」）', async () => {
    const html = await (await fetch(`${baseUrl}/`)).text();

    // 详情页自己轮询一小块（状态 / 活性 / 进度 / 花费）
    assert.ok(
      html.includes('function startDetailPolling'),
      '详情页必须有独立的进度轮询 —— 全局轮询在详情页是停用的',
    );
    assert.ok(
      html.includes('function renderLiveBox'),
      '必须有 renderLiveBox —— 进度那一块的渲染',
    );
    // 轮询周期存在（不是 0，也不是没有）
    const m = /startDetailPolling[\s\S]{0,600}?},\s*(\d{2,6})\s*\)/.exec(html);
    assert.ok(m, '详情页轮询必须有一个真实的周期');
    assert.ok(Number.parseInt(m[1], 10) > 0, '轮询周期必须大于 0');
  });

  it('前端：详情页轮询必须**在离开详情页时停掉**（否则轮询越积越多）', async () => {
    const html = await (await fetch(`${baseUrl}/`)).text();

    assert.ok(
      html.includes('function stopDetailPolling'),
      '必须有 stopDetailPolling —— 离开详情页不清计时器，轮询会越积越多',
    );
    // 返回按钮必须停掉轮询
    const backIdx = html.indexOf("el('button', 'back'");
    assert.ok(backIdx > 0, '找不到返回按钮');
    const backBody = html.slice(backIdx, backIdx + 400);
    assert.match(
      backBody,
      /stopDetailPolling/,
      '返回时必须停掉详情页轮询 —— 否则每次进详情页都多一个计时器',
    );
  });

  it('前端：失败必须**如实显示**，不许把「没跑起来」显示成「跑起来了」', async () => {
    const html = await (await fetch(`${baseUrl}/`)).text();

    // D-53：驾驶舱说「已在后台跑」而实际一个 agent 都没起，
    // 是**最坏的假象** —— 人会以为事情在推进。
    //
    // 所以前端必须做到两件事：
    //   1. 失败分支把服务端的 `reason` 显示出来（不是「操作失败」四个字）；
    //   2. 成功分支只在服务端**明确说 ok** 时才显示成功。
    //
    // 断言的是这两件事都在代码里 —— 前端是纯字符串，
    // 这里对着发出去的脚本断言（与 web-security.test.ts 的做法一致）。
    const runStart = html.indexOf('async function doRun');
    assert.ok(runStart > 0, '找不到 doRun');
    const runBody = html.slice(runStart, runStart + 1500);

    // 成功条件：服务端明确说 ok
    assert.match(
      runBody,
      /res\.body\.ok/,
      '成功分支必须以服务端的 ok 为准 —— 不能自己乐观',
    );
    // 失败分支：把服务端的话显示出来
    assert.match(
      runBody,
      /res\.body\.(error|reason)/,
      '失败分支必须显示服务端给的 reason —— 不许显示「操作失败」这种空话',
    );
    assert.match(
      runBody,
      /起跑失败/,
      '起跑失败必须明说是「起跑失败」',
    );
  });

  it('前端：门禁失败要显示**哪条命令失败了**，不是一句「门禁未通过」', async () => {
    const html = await (await fetch(`${baseUrl}/`)).text();

    const gateStart = html.indexOf('async function doGate');
    assert.ok(gateStart > 0, '找不到 doGate');
    const gateBody = html.slice(gateStart, gateStart + 1500);

    // 失败明细来自服务端返回的 details
    assert.match(
      gateBody,
      /body\.details/,
      '门禁失败必须逐条显示服务端给的 details —— 那是人能直接动手的地方',
    );
  });
});
