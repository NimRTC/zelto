// Web 驾驶舱的路由（ADR-072 §6）
//
// 手动路由，零依赖。端点少，路由表一眼能看完 ——
// 这正是 ADR-010 §7.1 选 `node:http` 的理由。
//
// 端点清单（ADR-072 §6 + ADR-010 §5.3 里 ADR-072 未砍掉的只读端点）——
// 除签字外全是只读：
//   GET  /api/slices
//   GET  /api/slices/:id
//   GET  /api/slices/:id/events
//   GET  /api/slices/:id/audit
//   GET  /api/events
//   GET  /api/sign-requests
//   GET  /api/summary
//   GET  /api/project      （工程名 / 根目录 —— 驾驶舱标题用）
//   GET  /api/metrics      （全项目度量）
//   GET  /api/stalls       （停机列表）
//   GET  /api/policy       （策略规则）
//   GET  /api/budget       （预算概览）
//   GET  /api/pipeline     （需求→设计→版本→切片 全链状态）
//   POST /api/sign-requests/:id/approve
//
// ADR-084 把驾驶舱从「只读 + 一个签字动作」扩成「可接管」，
// 新增三个**接管**动作：
//   POST /api/sign-requests/:id/reject   拒签
//   POST /api/slices/:id/answer          回答 agent 的提问（只记录，不续跑）
//   POST /api/halt                      拉闸
//
// **仍然没有** run / gate / freeze / admit / abandon / resume ——
// 理由见 ADR-072 §4：那些动作在 CLI 侧有完整实现，
// Web 侧再实现一份会分叉判定（C3 的隐患）。
//
// 三个新动作的共同纪律（ADR-084 §2）：
// **Web 侧不重写判定，只调 core** —— 每一件都复用 CLI 侧同一个实现。

import type { ServerResponse } from 'node:http';
import { sendJson, validId } from './server.js';
import type { WebApi } from './api.js';

export interface WebContext {
  method: string;
  path: string;
  query: URLSearchParams;
  api: WebApi;
  repoRoot: string;
  /** POST 的 JSON 请求体（已解析；非 POST 时为 undefined） */
  body?: unknown;
}

export interface WebRouter {
  dispatch(ctx: WebContext, res: ServerResponse): Promise<void>;
}

export function createWebRouter(): WebRouter {
  return { dispatch };
}

async function dispatch(ctx: WebContext, res: ServerResponse): Promise<void> {
  const { method, path, api } = ctx;

  // ── GET /api/project ────────────────────────────────────────────────
  // 工程信息（名称 / 根目录）—— 驾驶舱标题用
  if (method === 'GET' && path === '/api/project') {
    sendJson(res, 200, await api.projectInfo());
    return;
  }

  // ── GET /api/summary ────────────────────────────────────────────────
  if (method === 'GET' && path === '/api/summary') {
    sendJson(res, 200, await api.summary());
    return;
  }

  // ── GET /api/metrics ────────────────────────────────────────────────
  // 全项目度量报告（ADR-010 §5.3）
  if (method === 'GET' && path === '/api/metrics') {
    sendJson(res, 200, await api.metrics());
    return;
  }

  // ── GET /api/stalls ─────────────────────────────────────────────────
  // 停机列表（ADR-010 §5.3）
  if (method === 'GET' && path === '/api/stalls') {
    sendJson(res, 200, await api.stalls());
    return;
  }

  // ── GET /api/policy ─────────────────────────────────────────────────
  // 策略规则列表（ADR-010 §5.3）—— 只读
  if (method === 'GET' && path === '/api/policy') {
    sendJson(res, 200, await api.policy());
    return;
  }

  // ── GET /api/budget ─────────────────────────────────────────────────
  // 预算概览（ADR-010 §5.3）—— 只读
  if (method === 'GET' && path === '/api/budget') {
    sendJson(res, 200, await api.budget());
    return;
  }

  // ── GET /api/pipeline ───────────────────────────────────────────────
  // AI pipeline 全链状态（ADR-010 §5.3）—— 只读
  if (method === 'GET' && path === '/api/pipeline') {
    sendJson(res, 200, await api.pipeline());
    return;
  }

  // ── GET /api/slices ─────────────────────────────────────────────────
  if (method === 'GET' && path === '/api/slices') {
    sendJson(res, 200, await api.listSlices());
    return;
  }

  // ── GET /api/events ─────────────────────────────────────────────────
  if (method === 'GET' && path === '/api/events') {
    const limit = parseLimit(ctx.query.get('limit'), 100);
    sendJson(res, 200, await api.recentEvents(limit));
    return;
  }

  // ── GET /api/sign-requests ──────────────────────────────────────────
  if (method === 'GET' && path === '/api/sign-requests') {
    const status = ctx.query.get('status') ?? undefined;
    sendJson(res, 200, await api.listSignRequests(status));
    return;
  }

  // ── POST /api/sign-requests/:id/approve ─────────────────────────────
  const approveMatch = path.match(/^\/api\/sign-requests\/([^/]+)\/approve$/);
  if (approveMatch) {
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }
    const signId = validId(approveMatch[1]);
    if (!signId) {
      sendJson(res, 400, { error: '签字请求 id 非法' });
      return;
    }
    // 把前端传来的「人确认过了这四项」凭据传给 api 层。
    // 内容不作数（服务端自己重算），但「有没有带」是信号 —— 见 api.ts。
    const body = ctx.body as { checks?: unknown } | undefined;
    const result = await api.approveSign(signId, body?.checks);
    if (!result.ok) {
      // 409 —— 请求本身合法，但**前置条件不满足**（确认项没过 / 状态不对）
      //
      // 同时给 error 与 reason 两个字段：
      // - error 是 HTTP 语义（前端 `res.body.error || res.body.reason`）
      // - reason 是 api 层的结果字段（保持契约一致）
      // 两个都给，是为了让前端与测试都不必猜该读哪个。
      sendJson(res, 409, { error: result.reason, reason: result.reason, checks: result.checks });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      request: result.request,
      checks: result.checks,
      // ADR-018：签字不等于合并。这句必须回到前端 ——
      // 浏览器里签完字，人很容易以为「完事了」。
      nextStep: `签字不等于合并：合入主干需另跑 zelto merge ${(result.request as { sliceId: string }).sliceId}`,
    });
    return;
  }

  // ── GET /api/questions ───────────────────────────────────────────────
  // ADR-084：agent 的待答提问 —— 驾驶舱要能「就地回答」
  //
  // 之前没有这个端点，于是 agent 一提问，人就得切回终端去 `zelto ask` 看。
  // 驾驶舱在最该起作用的时候把人赶走了（ADR-084 背景）。
  if (method === 'GET' && path === '/api/questions') {
    const sliceId = ctx.query.get('slice') ?? undefined;
    const status = ctx.query.get('status') ?? undefined;
    sendJson(res, 200, await api.listQuestions(sliceId, status));
    return;
  }

  // ── POST /api/sign-requests/:id/reject ──────────────────────────────
  // ADR-084：拒签 —— 与 CLI 侧 `zelto sign <id> --reject` 同一套实现。
  //
  // 为什么驾驶舱要能拒签：签字队列是「人在被交还控制权的那一刻」看的页面。
  // 只能签不能拒，就等于把人赶回终端 —— 驾驶舱在最该起作用的时候失效。
  const rejectMatch = path.match(/^\/api\/sign-requests\/([^/]+)\/reject$/);
  if (rejectMatch) {
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }
    const signId = validId(rejectMatch[1]);
    if (!signId) {
      sendJson(res, 400, { error: '签字请求 id 非法' });
      return;
    }
    const body = ctx.body as { comment?: unknown } | undefined;
    const comment = typeof body?.comment === 'string' ? body.comment : null;
    const result = await api.rejectSign(signId, comment);
    if (!result.ok) {
      sendJson(res, 409, { error: result.reason, reason: result.reason });
      return;
    }
    sendJson(res, 200, { ok: true, request: result.request });
    return;
  }

  // ── POST /api/slices/:id/answer ─────────────────────────────────────
  // ADR-084 §1.1：回答 agent 的提问 —— **只记录答案，不续跑**。
  //
  // 续跑要调 adapter.resume() 拉起 agent 会话，会让 HTTP 请求长时间挂着，
  // 还可能留下孤儿进程。CLI 侧本来就有完整实现 —— Web 侧再写一份就分叉了（C3）。
  // 分工：驾驶舱负责「把答案记下来」，CLI 负责「让 agent 接着跑」。
  const answerMatch = path.match(/^\/api\/slices\/([^/]+)\/answer$/);
  if (answerMatch) {
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }
    const id = validId(answerMatch[1]);
    if (!id) {
      sendJson(res, 400, { error: '切片 id 非法' });
      return;
    }
    const body = ctx.body as { answer?: unknown } | undefined;
    if (typeof body?.answer !== 'string' || !body.answer.trim()) {
      sendJson(res, 400, { error: '答案为空' });
      return;
    }
    const result = await api.answerQuestion(id, body.answer);
    if (!result.ok) {
      sendJson(res, 409, { error: result.reason, reason: result.reason });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      questionId: result.questionId,
      nextStep: result.nextStep,
    });
    return;
  }

  // ── POST /api/halt ──────────────────────────────────────────────────
  // ADR-084：拉闸 —— 与 CLI 侧 `zelto halt` 同一套实现（ADR-020）。
  //
  // 驾驶舱只提供「刹车」，不提供「油门」——
  // resume 会改切片状态机、走重试预算、可能触发 gate，
  // 那是「推进」动作，不是「接管」动作。
  if (method === 'POST' && path === '/api/halt') {
    const body = ctx.body as { scope?: unknown; reason?: unknown } | undefined;
    const scope = typeof body?.scope === 'string' ? body.scope : 'all';
    const reason = typeof body?.reason === 'string' ? body.reason : '人工拉闸';
    const result = await api.haltBatch(scope, reason);
    if (!result.ok) {
      sendJson(res, 409, { error: result.reason, reason: result.reason });
      return;
    }
    sendJson(res, 200, { ok: true, halt: result.halt });
    return;
  }

  // ── GET /api/slices/:id ─────────────────────────────────────────────
  const detailMatch = path.match(/^\/api\/slices\/([^/]+)$/);
  if (detailMatch) {
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }
    const id = validId(detailMatch[1]);
    if (!id) {
      sendJson(res, 400, { error: '切片 id 非法' });
      return;
    }
    try {
      const detail = await api.getSlice(id);
      sendJson(res, 200, detail);
    } catch {
      sendJson(res, 404, { error: `切片不存在：${id}` });
    }
    return;
  }

  // ── GET /api/slices/:id/events ──────────────────────────────────────
  const eventsMatch = path.match(/^\/api\/slices\/([^/]+)\/events$/);
  if (eventsMatch) {
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }
    const id = validId(eventsMatch[1]);
    if (!id) {
      sendJson(res, 400, { error: '切片 id 非法' });
      return;
    }
    const limit = parseLimit(ctx.query.get('limit'), 200);
    sendJson(res, 200, await api.sliceEvents(id, limit));
    return;
  }

  // ── GET /api/slices/:id/audit ───────────────────────────────────────
  const auditMatch = path.match(/^\/api\/slices\/([^/]+)\/audit$/);
  if (auditMatch) {
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }
    const id = validId(auditMatch[1]);
    if (!id) {
      sendJson(res, 400, { error: '切片 id 非法' });
      return;
    }
    sendJson(res, 200, await api.sliceAudit(id));
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

/**
 * 解析 limit 参数。
 *
 * 非法值退回默认 —— 不让一个 `?limit=999999999` 把内存撑爆。
 */
function parseLimit(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, 1000);
}
