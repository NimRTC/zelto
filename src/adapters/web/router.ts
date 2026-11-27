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
//   GET  /api/pending-actions（「眼下该做什么」—— 与 CLI 同一份判定）
//   GET  /api/project      （工程名 / 根目录 —— 驾驶舱标题用）
//   GET  /api/metrics      （全项目度量）
//   GET  /api/stalls       （停机列表）
//   GET  /api/policy       （策略规则）
//   GET  /api/budget       （预算概览）
//   GET  /api/pipeline     （需求→设计→版本→切片 全链状态）
//   GET  /api/plan-coverage（ADR-114：计划 vs 盘上 vs 分支）
//   GET  /api/worktrees    （执行目录脉络：仓库根 / 版本目录 / 执行目录 / 额外工作区）
//   POST /api/sign-requests/:id/approve
//
// ADR-084 把驾驶舱从「只读 + 一个签字动作」扩成「可接管」，
// 新增三个**接管**动作：
//   POST /api/sign-requests/:id/reject   拒签
//   POST /api/slices/:id/answer          回答 agent 的提问（只记录，不续跑）
//   POST /api/halt                      拉闸
//
// ADR-086 再补上**四个油门**动作：
//   POST /api/slices/:id/freeze          冻结规格
//   POST /api/slices/:id/gate            跑门禁②
//   POST /api/slices/:id/run             开跑（后台 agent）
//   POST /api/slices/:id/resume          续跑停机切片
//
// **仍然没有** admit / abandon ——
// 理由见 ADR-072 §4：那两个动作在 CLI 侧有完整实现，
// Web 侧再实现一份会分叉判定（C3 的隐患）。
//
// 四个新动作的共同纪律（ADR-086 §1）：
// **Web 侧不重写判定，只调 core** —— freeze / gate / resume 直接调
// `core/lifecycle/` 里那份编排（CLI 与 Web 调同一个函数）；
// `run` 拉起 CLI 进程本身（`zelto run <id> --detach`），
// 因为 run 必须用 executor adapter，而 `core/` 不许 import `adapters/`（C2）。
//
// 三个新动作的共同纪律（ADR-084 §2）：
// **Web 侧不重写判定，只调 core** —— 每一件都复用 CLI 侧同一个实现。

import type { ServerResponse } from 'node:http';
import { sendJson, validId } from './server.js';
import type { WebApi } from './api.js';
import type { CockpitCrashGuard } from './crash-guard.js';
import type { CockpitScope } from '../../core/project/cockpit-roots.js';

/**
 * 从请求里解析「根」定位（ADR-112）—— `scope` + `label`。
 *
 * POST 优先看 body，GET 看 query。缺省时不带 scope：api 层按
 * 「仓库根优先、再按合并归属」解析（与改造前一致）。
 *
 * `scope` 只认两个值；`label` 只收字符串。非法值**忽略**而不是报错 ——
 * 非法 scope 与「没传」等价（落回默认解析），比一个 400 更好：
 * 前端漏传字段时旧行为照常工作。
 */
function parseLocation(
  scope: unknown,
  label: unknown,
): { scope?: CockpitScope; label?: string | null } {
  const s = typeof scope === 'string' ? scope.trim() : '';
  if (s !== 'root' && s !== 'version') return {};
  return {
    scope: s,
    label: typeof label === 'string' && label.trim() ? label.trim() : null,
  };
}

export interface WebContext {
  method: string;
  path: string;
  query: URLSearchParams;
  api: WebApi;
  repoRoot: string;
  /** POST 的 JSON 请求体（已解析；非 POST 时为 undefined） */
  body?: unknown;
  /**
   * 崩溃兜底器（可选）。
   *
   * 用来回答一个问题：「服务还活着吗？它有没有出过错？」
   * —— 人对着一个不再更新的页面时，最想知道的正是这个。
   */
  crashGuard?: CockpitCrashGuard | null;
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

  // ── GET /api/health ────────────────────────────────────────────────
  //
  // 回答一个问题：**「驾驶舱还活着吗？它有没有出过错？」**
  //
  // 为什么需要这个端点：
  //
  //   驾驶舱是**前台进程**（ADR-072 §10，不是常驻 daemon）。
  //   进程一没，浏览器里那个页面就停在最后一次轮询的画面上，
  //   看着像「卡住」，实际上早就没人应答了。
  //
  //   而**崩溃兜底**兜住的是另一类消失：一次未捕获异常。
  //   兜底之后服务还在跑，但人如果只看到「页面不动了」，
  //   仍然会以为服务死了 —— 于是关标签页、重新跑 zelto web，
  //   而实际上原来的服务好好的。
  //
  //   这个端点把两件事说清楚：
  //     - 服务确实还在应答（能返回 200 就说明它活着）
  //     - 它出过错没有、出了几次、最后一次是什么
  //
  // **只读**，不暴露栈（栈里有路径，对本机服务不算风险，
  // 但没必要给人看 —— 人要的是「出没出错」，不是栈）。
  if (method === 'GET' && path === '/api/health') {
    const guard = ctx.crashGuard ?? null;
    sendJson(res, 200, {
      ok: true,
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      crashes: guard?.count ?? 0,
      lastCrash: guard?.last
        ? {
            at: guard.last.at,
            kind: guard.last.kind,
            message: guard.last.message,
          }
        : null,
    });
    return;
  }

  // ── GET /api/pending-actions ─────────────────────────────────────────
  // 「眼下该做什么」—— 与 CLI 的 `zelto next` / `suggest` / `dashboard`
  // **同一份判定与排序**（`core/pending/`）。
  //
  // 为什么单开一个端点而不是塞进 `/api/summary`：
  // 驾驶舱首屏的价值是「一眼看出该干什么」，而 `/api/summary` 给的是
  // **状态**（在跑几片、待签几片、成本多少）—— 看到「3 片待签」，
  // 人还得自己回想该敲哪条命令。
  //
  // 现在首屏第一块就是这份清单，且它与终端里看到的排序**完全一致**。
  if (method === 'GET' && path === '/api/pending-actions') {
    sendJson(res, 200, await api.pendingActions());
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
    // ADR-112：可选的 scope/label 收窄到某个根；不带则跨根合并
    sendJson(res, 200, await api.listSignRequests(status, parseLocation(
      ctx.query.get('scope') ?? undefined,
      ctx.query.get('label') ?? undefined,
    )));
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
    const body = ctx.body as { checks?: unknown; scope?: unknown; label?: unknown } | undefined;
    const result = await api.approveSign(signId, body?.checks, parseLocation(body?.scope, body?.label));
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

  // ── GET /api/worktrees ───────────────────────────────────────────
  // 执行目录脉络：仓库根 / 版本集成目录 / 切片执行目录 / git 额外工作区
  if (method === 'GET' && path === '/api/worktrees') {
    sendJson(res, 200, await api.worktreeMap());
    return;
  }

  // ── GET /api/plan-coverage ─────────────────────────────────────────
  // ADR-114：计划 vs 盘上 vs 版本分支 —— 三个口径并排，只呈现差异
  if (method === 'GET' && path === '/api/plan-coverage') {
    sendJson(res, 200, await api.planCoverage());
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
    const body = ctx.body as { comment?: unknown; scope?: unknown; label?: unknown } | undefined;
    const comment = typeof body?.comment === 'string' ? body.comment : null;
    const result = await api.rejectSign(signId, comment, parseLocation(body?.scope, body?.label));
    if (!result.ok) {
      sendJson(res, 409, { error: result.reason, reason: result.reason });
      return;
    }
    sendJson(res, 200, { ok: true, request: result.request });
    return;
  }

  // ── POST /api/sign-requests/:id/revise ──────────────────────────────
  // ADR-094 §5.1：退回重跑 —— 与 CLI 侧 `zelto sign <id> --revise` 同一套实现。
  //
  // 人审出毛病但**方向是对的** —— 让片回 frozen 带着意见重跑。
  //
  // **意见是强制的**（服务端也强制，不只靠前端）：不给意见就让人重跑
  // = 人自己也不清楚要改什么，重跑必然白跑。
  const reviseMatch = path.match(/^\/api\/sign-requests\/([^/]+)\/revise$/);
  if (reviseMatch) {
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }
    const signId = validId(reviseMatch[1]);
    if (!signId) {
      sendJson(res, 400, { error: '签字请求 id 非法' });
      return;
    }
    const body = ctx.body as { comment?: unknown; scope?: unknown; label?: unknown } | undefined;
    const comment = typeof body?.comment === 'string' ? body.comment : null;
    const result = await api.reviseSign(signId, comment, parseLocation(body?.scope, body?.label));
    if (!result.ok) {
      sendJson(res, 409, { error: result.reason, reason: result.reason });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      request: result.request,
      revokedApproval: result.revokedApproval,
      nextStep: result.nextStep,
    });
    return;
  }

  // ── POST /api/sign-requests/:id/return ─────────────────────────────
  // ADR-094 §5.1：退回上游 —— 与 CLI 侧 `zelto spec revise <id>` 同一套实现。
  //
  // 人审出**方向**不对 —— 规格要改。片回 draft，重新走门禁① + 冻结。
  //
  // 与「退回重跑」的区别在**回哪个状态**：
  //   - revise → frozen（规格不动，重跑即可）
  //   - return → draft（规格要改，得重新冻结；跳过门禁①是不行的）
  const returnMatch = path.match(/^\/api\/sign-requests\/([^/]+)\/return$/);
  if (returnMatch) {
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }
    const signId = validId(returnMatch[1]);
    if (!signId) {
      sendJson(res, 400, { error: '签字请求 id 非法' });
      return;
    }
    const body = ctx.body as { comment?: unknown; scope?: unknown; label?: unknown } | undefined;
    const comment = typeof body?.comment === 'string' ? body.comment : null;
    const result = await api.returnSign(signId, comment, parseLocation(body?.scope, body?.label));
    if (!result.ok) {
      sendJson(res, 409, { error: result.reason, reason: result.reason });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      request: result.request,
      revokedApproval: result.revokedApproval,
      nextStep: result.nextStep,
    });
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
    const body = ctx.body as { answer?: unknown; scope?: unknown; label?: unknown } | undefined;
    if (typeof body?.answer !== 'string' || !body.answer.trim()) {
      sendJson(res, 400, { error: '答案为空' });
      return;
    }
    const result = await api.answerQuestion(id, body.answer, parseLocation(body.scope, body.label));
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

  // ── POST /api/slices/:id/freeze ─────────────────────────────────────
  // ADR-086：冻结 —— 与 CLI `zelto freeze` 同一份编排（core/lifecycle/freeze.ts）。
  //
  // 驾驶舱与 CLI 调**同一份**编排 —— 判定不分叉（C3）。
  const freezeMatch = path.match(/^\/api\/slices\/([^/]+)\/freeze$/);
  if (freezeMatch) {
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }
    const id = validId(freezeMatch[1]);
    if (!id) {
      sendJson(res, 400, { error: '切片 id 非法' });
      return;
    }
    const body = ctx.body as { refreeze?: unknown; scope?: unknown; label?: unknown } | undefined;
    const result = await api.freezeSlice(id, {
      ...(body?.refreeze === true ? { refreeze: true } : {}),
    }, parseLocation(body?.scope, body?.label));
    if (!result.ok) {
      sendLifecycleFailure(res, result);
      return;
    }
    sendJson(res, 200, { ...result, ok: true });
    return;
  }

  // ── POST /api/slices/:id/gate ───────────────────────────────────────
  // ADR-086：门禁② —— 与 CLI `zelto gate` 同一份编排（core/lifecycle/gate.ts）。
  const gateMatch = path.match(/^\/api\/slices\/([^/]+)\/gate$/);
  if (gateMatch) {
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }
    const id = validId(gateMatch[1]);
    if (!id) {
      sendJson(res, 400, { error: '切片 id 非法' });
      return;
    }
    const body = ctx.body as {
      only?: unknown; retry?: unknown; dryRun?: unknown; full?: unknown;
      scope?: unknown; label?: unknown;
    } | undefined;
    const only = typeof body?.only === 'string' ? body.only : undefined;
    const retry = typeof body?.retry === 'number' && Number.isFinite(body.retry)
      ? Math.max(0, Math.floor(body.retry))
      : undefined;
    const result = await api.runGate(id, {
      ...(only ? { only } : {}),
      ...(retry !== undefined ? { retry } : {}),
      ...(body?.dryRun === true ? { dryRun: true } : {}),
      ...(body?.full === true ? { full: true } : {}),
    }, parseLocation(body?.scope, body?.label));
    if (!result.ok) {
      sendLifecycleFailure(res, result);
      return;
    }
    sendJson(res, 200, { ...result, ok: true });
    return;
  }

  // ── POST /api/slices/:id/run ────────────────────────────────────────
  // ADR-086 §3：开跑 —— **拉起 CLI 进程**（`zelto run <id> --detach`），
  // 不是 Web 侧重实现 run。
  //
  // fire-and-forget：HTTP 请求**不挂着** agent 会话 ——
  // agent 跑在独立的监督进程里（ADR-084 §1.1 要的就是这个）。
  const runMatch = path.match(/^\/api\/slices\/([^/]+)\/run$/);
  if (runMatch) {
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }
    const id = validId(runMatch[1]);
    if (!id) {
      sendJson(res, 400, { error: '切片 id 非法' });
      return;
    }
    const body = ctx.body as {
      hotfix?: unknown; confirmHotfix?: unknown; scope?: unknown; label?: unknown;
    } | undefined;
    const hotfix = body?.hotfix === true;
    // ADR-015 §3.1：hotfix 跳过门禁② —— 必须显式确认。
    // Web 端要**两个独立字段**（hotfix + confirmHotfix），比 CLI 的两个词更严。
    if (hotfix && body?.confirmHotfix !== true) {
      sendJson(res, 400, {
        error:
          'hotfix 会跳过门禁②（验收测试），等于放弃「签字前必须过门禁」这条约束，' +
          '所以必须显式确认。请同时提交 hotfix 与 confirmHotfix。',
      });
      return;
    }
    const result = await api.runSlice(id, {
      hotfix,
      confirmHotfix: body?.confirmHotfix === true,
    }, parseLocation(body?.scope, body?.label));
    if (!result.ok) {
      sendJson(res, 409, { ok: false, error: result.reason, reason: result.reason });
      return;
    }
    sendJson(res, 200, { ...result, ok: true });
    return;
  }

  // ── POST /api/slices/:id/resume ─────────────────────────────────────
  // ADR-086：续跑停机切片 —— 与 CLI `zelto resume` 同一份编排。
  const resumeMatch = path.match(/^\/api\/slices\/([^/]+)\/resume$/);
  if (resumeMatch) {
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }
    const id = validId(resumeMatch[1]);
    if (!id) {
      sendJson(res, 400, { error: '切片 id 非法' });
      return;
    }
    const body = ctx.body as {
      skip?: unknown;
      abandon?: unknown;
      resetRetry?: unknown;
      scope?: unknown;
      label?: unknown;
    } | undefined;
    const result = await api.resumeSlice(id, {
      ...(body?.skip === true ? { skip: true } : {}),
      ...(body?.abandon === true ? { abandon: true } : {}),
      ...(body?.resetRetry === true ? { resetRetry: true } : {}),
    }, parseLocation(body?.scope, body?.label));
    if (!result.ok) {
      sendLifecycleFailure(res, result);
      return;
    }
    sendJson(res, 200, { ...result, ok: true });
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
      const detail = await api.getSlice(id, parseLocation(
        ctx.query.get('scope') ?? undefined,
        ctx.query.get('label') ?? undefined,
      ));
      if (!detail) {
        sendJson(res, 404, { error: `切片不存在：${id}` });
        return;
      }
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
    sendJson(res, 200, await api.sliceEvents(id, limit, parseLocation(
      ctx.query.get('scope') ?? undefined,
      ctx.query.get('label') ?? undefined,
    )));
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
    sendJson(res, 200, await api.sliceAudit(id, parseLocation(
      ctx.query.get('scope') ?? undefined,
      ctx.query.get('label') ?? undefined,
    )));
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

/**
 * 编排类动作的失败响应（ADR-086 的 freeze / gate / resume 共用）。
 *
 * **404 与 409 是两回事**：
 *   - 404 —— 切片根本不存在。人的动作是错的（点了不存在的东西）。
 *   - 409 —— 切片在，但**状态不允许**这个动作（还没冻结、门禁没过……）。
 *
 * 为什么要分开：都返回 409 的话，人看到「冲突」会去猜「跟谁冲突」，
 * 而真相只是「你点的那个 id 不存在」。反过来都返回 404 的话，
 * 状态冲突会被误报成「页面丢了」—— 那更糟，因为**人会刷新重试**，
 * 而重试不会改变状态，只会让人更困惑。
 *
 * 409 是**可恢复**的（改状态再来），404 是**不可恢复**的（换个 id）。
 * 这条区别决定了前端该提示「改状态」还是「刷新列表」。
 */
function sendLifecycleFailure(
  res: ServerResponse,
  result: {
    ok: boolean;
    reason: string;
    details?: string[];
    advisories?: string[];
    facts?: Record<string, unknown>;
    notFound?: boolean;
  },
): void {
  if (result.notFound) {
    sendJson(res, 404, {
      ok: false,
      error: result.reason,
      reason: result.reason,
      ...(result.details && result.details.length > 0 ? { details: result.details } : {}),
    });
    return;
  }
  sendJson(res, 409, {
    ok: false,
    error: result.reason,
    reason: result.reason,
    ...(result.details && result.details.length > 0 ? { details: result.details } : {}),
    ...(result.advisories && result.advisories.length > 0 ? { advisories: result.advisories } : {}),
  });
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
