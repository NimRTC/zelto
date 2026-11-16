// Web 驾驶舱的路由（ADR-072 §6）
//
// 手动路由，零依赖。端点少，路由表一眼能看完 ——
// 这正是 ADR-010 §7.1 选 `node:http` 的理由。
//
// 端点清单（ADR-072 §6）—— 除签字外全是只读：
//   GET  /api/slices
//   GET  /api/slices/:id
//   GET  /api/slices/:id/events
//   GET  /api/slices/:id/audit
//   GET  /api/events
//   GET  /api/sign-requests
//   GET  /api/summary
//   POST /api/sign-requests/:id/approve
//
// **没有** run / gate / freeze / admit / abandon / resume ——
// 理由见 ADR-072 §4：那些动作在 CLI 侧有完整实现，
// Web 侧再实现一份会分叉判定（C3 的隐患）。

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

  // ── GET /api/summary ────────────────────────────────────────────────
  if (method === 'GET' && path === '/api/summary') {
    sendJson(res, 200, await api.summary());
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
