// 驾驶舱的「退回重跑 / 退回上游」—— 端到端（ADR-094 §5.1）
//
// 为什么这个文件单独存在：
//
// 「不批准」本来只有一个出口 —— 拒签（`completed -> abandoned`）。
// 但人审出毛病时有**两种**情况，处理方式完全不同：
//
//   - **方向对、代码要改** → 退回重跑（revise）：片回 frozen，
//     规格不动，带着意见重跑一遍。
//   - **方向错** → 退回上游（return）：片回 draft，
//     规格要改，得重新走门禁① + 冻结。
//
// 拒签是**终态**（abandoned）—— 用它来表达「要改」等于把整片作废。
// 只给一个出口的话，人发现「方向不对但代码没错」时只能切回终端，
// 驾驶舱在最该起作用的时候失效（ADR-084 的老毛病）。
//
// **意见是强制的** —— 服务端强制，不只靠前端弹窗：
// 不给意见就让人重跑 = 人自己也不清楚要改什么，重跑必然白跑。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WebServer } from '../src/adapters/web/server.js';

const ROOT = mkdtempSync(join(tmpdir(), 'zelto-web-revise-'));

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
    headers: {
      'X-Zelto-Token': token,
      'Content-Type': 'application/json',
    },
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

/** 读一个切片的状态文件。 */
function readSlice(id: string): Record<string, unknown> {
  const path = join(ROOT, '.zelto', 'slices', `${id}.json`);
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

/** 读一个签字请求。 */
function readSign(id: string): Record<string, unknown> {
  const path = join(ROOT, '.zelto', 'locks', `${id}.json`);
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
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

/** 造一片处于指定状态的切片。 */
function writeSlice(id: string, state: string): void {
  writeFileSync(
    join(ROOT, '.zelto', 'slices', `${id}.json`),
    JSON.stringify({
      id,
      title: `测试切片 ${id}`,
      state,
      type: 'feature',
      writes: ['src/**'],
      trace: { requirements: ['r1'], contracts: [], tests: [] },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      runs: [],
    }),
    'utf-8',
  );
}

/** 造一条 pending 签字请求。 */
function writeSign(id: string, sliceId: string): void {
  writeFileSync(
    join(ROOT, '.zelto', 'locks', `${id}.json`),
    JSON.stringify({
      id,
      sliceId,
      status: 'pending',
      requestedAt: new Date().toISOString(),
    }),
    'utf-8',
  );
}

describe('驾驶舱的退回动作（ADR-094 §5.1）', () => {
  before(async () => {
    mkdirSync(join(ROOT, '.zelto', 'slices'), { recursive: true });
    mkdirSync(join(ROOT, '.zelto', 'events'), { recursive: true });
    mkdirSync(join(ROOT, '.zelto', 'locks'), { recursive: true });

    server = new WebServer({ port: 0, repoRoot: ROOT });
    await server.start();
    baseUrl = server.url;
    token = server.sessionToken;
  });

  after(async () => {
    await server?.stop();
    rmSync(ROOT, { recursive: true, force: true });
  });

  // ── 退回重跑 ──────────────────────────────────────────────────────────

  it('退回重跑：completed → frozen，并带上意见', async () => {
    writeSlice('rev-1', 'completed');
    writeSign('sr-rev', 'rev-1');

    const res = await req('POST', '/api/sign-requests/sr-rev/revise', {
      body: { comment: '边界条件漏了一种情况' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body['ok'], true);

    // 片回到 frozen —— 规格不动，重跑即可
    assert.equal(readSlice('rev-1')['state'], 'frozen');

    // 签字请求记下了意见
    const sign = readSign('sr-rev');
    assert.equal(sign['status'], 'revised');
    assert.equal(sign['comment'], '边界条件漏了一种情况');
  });

  it('退回重跑：意见必须给（不给就拒）', async () => {
    writeSlice('rev-2', 'completed');
    writeSign('sr-rev-2', 'rev-2');

    const res = await req('POST', '/api/sign-requests/sr-rev-2/revise', { body: {} });
    assert.equal(res.status, 409, `不给意见必须被拒，实际 ${res.status}`);
    // 片的状态没被改
    assert.equal(readSlice('rev-2')['state'], 'completed');
  });

  it('退回重跑：空白意见也算没给', async () => {
    writeSlice('rev-3', 'completed');
    writeSign('sr-rev-3', 'rev-3');

    const res = await req('POST', '/api/sign-requests/sr-rev-3/revise', {
      body: { comment: '   ' },
    });
    assert.equal(res.status, 409);
    assert.equal(readSlice('rev-3')['state'], 'completed');
  });

  // ── 退回上游 ──────────────────────────────────────────────────────────

  it('退回上游：completed → draft，并带上意见', async () => {
    writeSlice('ret-1', 'completed');
    writeSign('sr-ret', 'ret-1');

    const res = await req('POST', '/api/sign-requests/sr-ret/return', {
      body: { comment: '方向不对 —— 需求理解错了' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body['ok'], true);

    // 片回到 draft —— 规格要改，得重新走门禁① + 冻结
    assert.equal(readSlice('ret-1')['state'], 'draft');

    const sign = readSign('sr-ret');
    assert.equal(sign['status'], 'returned');
    assert.equal(sign['comment'], '方向不对 —— 需求理解错了');
  });

  it('退回上游：意见必须给（不给就拒）', async () => {
    writeSlice('ret-2', 'completed');
    writeSign('sr-ret-2', 'ret-2');

    const res = await req('POST', '/api/sign-requests/sr-ret-2/return', { body: {} });
    assert.equal(res.status, 409);
    assert.equal(readSlice('ret-2')['state'], 'completed');
  });

  // ── 已批准的签字被退回时，批准要作废 ──────────────────────────────────

  it('退回重跑会作废已有的批准（不留下「已签但要改」的分裂状态）', async () => {
    writeSlice('rev-4', 'completed');
    writeSign('sr-rev-4', 'rev-4');
    // 先把它批了
    writeFileSync(
      join(ROOT, '.zelto', 'locks', 'sr-rev-4.json'),
      JSON.stringify({
        id: 'sr-rev-4',
        sliceId: 'rev-4',
        status: 'approved',
        requestedAt: new Date().toISOString(),
        decidedAt: new Date().toISOString(),
      }),
      'utf-8',
    );

    const res = await req('POST', '/api/sign-requests/sr-rev-4/revise', {
      body: { comment: '还得改' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    // 批准被撤销这件事必须**告诉人** —— 不然他会以为还签着
    assert.equal(res.body['revokedApproval'], true);
    assert.equal(readSlice('rev-4')['state'], 'frozen');
  });

  // ── 事件流（C4）───────────────────────────────────────────────────────

  it('退回动作写了事件流（C4：可追溯）', async () => {
    writeSlice('rev-5', 'completed');
    writeSign('sr-rev-5', 'rev-5');

    await req('POST', '/api/sign-requests/sr-rev-5/revise', {
      body: { comment: '留个记录' },
    });

    const events = readEvents('rev-5');
    const revised = events.find((e) => e['type'] === 'sign.revised');
    assert.ok(revised, '必须有 sign.revised 事件');
    const payload = revised['payload'] as Record<string, unknown>;
    assert.equal(payload['comment'], '留个记录');
    assert.equal(payload['via'], 'web');
  });

  // ── 安全防线 ──────────────────────────────────────────────────────────

  it('退回端点同样过三道防线（缺 token 被拒）', async () => {
    for (const path of [
      '/api/sign-requests/sr-rev/revise',
      '/api/sign-requests/sr-rev/return',
    ]) {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment: 'x' }),
      });
      assert.equal(res.status, 403, `${path} 缺 token 必须被拒，实际 ${res.status}`);
    }
  });

  it('退回端点只认 POST（GET 拿 405）', async () => {
    for (const path of [
      '/api/sign-requests/sr-rev/revise',
      '/api/sign-requests/sr-rev/return',
    ]) {
      const res = await req('GET', path);
      assert.equal(res.status, 405, `${path} 应当只认 POST，实际 ${res.status}`);
    }
  });
});
