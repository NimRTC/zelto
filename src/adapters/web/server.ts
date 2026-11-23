// Web 驾驶舱 —— HTTP 服务端（ADR-072）
//
// 形态：`node:http`，零额外运行时依赖（C2 的精神：只用 Node 内置）。
// 绑定：**硬编码** `127.0.0.1`，不可配置 —— ADR-072 §7。
//
// 只服务三样东西：
//   1. 内嵌的 SPA（HTML/CSS/JS 三个字符串，不读任意文件）
//   2. 只读 API
//   3. **唯一**的写操作：签字（带 token + Origin 双因子校验）
//
// 安全要点（ADR-072 §3 / §7）：
//   - 会话 token：启动时生成，写操作必须在 `X-Zelto-Token` 头里带回
//   - Origin 校验：写操作的 Origin 必须为空或等于本服务
//   - 从不发 `Access-Control-Allow-Origin` —— 第三方网页读不到本页内容，
//     所以拿不到 token（CSRF 失效的根本原因在这里）
//   - 路径参数过滤，不把 id 拼进文件路径前先校验

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createWebRouter, type WebContext } from './router.js';
import { WebApi } from './api.js';
import { renderIndexHtml } from './frontend.js';
import type { CockpitCrashGuard } from './crash-guard.js';

export interface WebServerOptions {
  /** 监听端口 */
  port: number;
  /** 仓库根（跑 git、定位 .zelto） */
  repoRoot: string;
  /** 宿主地址 —— 硬编码 127.0.0.1，不对外暴露 */
  host?: string;
  /**
   * 崩溃兜底器（可选）。
   *
   * 由 CLI 层装（`src/cli/commands/web.ts`），因为它要挂的是
   * **进程级**的 `uncaughtException` / `unhandledRejection`。
   *
   * 为什么由外面传进来而不是服务端自己装：服务端不该擅自
   * 改变进程的全局行为 —— 谁装的谁负责撤（`dispose()`）。
   * 传进来还让服务端能**读到**兜底状态并暴露给前端，
   * 于是「服务活着但出过一次错」这件事人看得见。
   */
  crashGuard?: CockpitCrashGuard;
}

/** 只允许本机回环地址。ADR-072 §7：绑定面不可配置。 */
const DEFAULT_HOST = '127.0.0.1';

/** 路径参数允许的字符集 —— 挡住 `..` 与路径分隔符。 */
const ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export class WebServer {
  private readonly port: number;
  private readonly host: string;
  private readonly repoRoot: string;
  private readonly api: WebApi;
  private readonly token: string;
  /** 崩溃兜底器（可选，由 CLI 层装） */
  private readonly crashGuard: CockpitCrashGuard | null;
  private server: Server | null = null;
  /**
   * 运行期的 `'error'` 监听（常驻）。
   *
   * 为什么要有它：启动阶段的 error 监听是**一次性**的（`once`），
   * `listening` 之后就被移除。运行期再来一个 `'error'` 事件时，
   * EventEmitter 找不到监听器 → 抛未捕获异常 → **进程退出**。
   *
   * Node 的 HTTP server 不会自动处理 `'error'`（文档明确要求自己监听），
   * 而 accept 失败 / 端口耗尽这类错误在运行期确实会发生。
   * 结果就是驾驶舱「突然消失」，浏览器里的页面却看着一切正常。
   *
   * 所以这个监听必须**常驻**，且不能退出进程 —— 见 `start()` 里的注释。
   */
  private runtimeErrorHandler: ((err: NodeJS.ErrnoException) => void) | null = null;

  constructor(options: WebServerOptions) {
    this.port = options.port;
    this.host = options.host ?? DEFAULT_HOST;
    this.repoRoot = options.repoRoot;
    this.api = new WebApi(options.repoRoot);
    this.crashGuard = options.crashGuard ?? null;
    // 32 字节随机 token —— 每次启动都换。
    // 「无凭据」才是 CSRF 成立的前提（ADR-072 §3），所以这里必须有凭据。
    this.token = randomBytes(32).toString('hex');
  }

  /** 本次会话的 token —— 注入 HTML 页面用。 */
  get sessionToken(): string {
    return this.token;
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off('listening', onListening);
        // 端口占用要明确报错退出，不静默换端口 ——
        // 静默换端口会让人以为「Web UI 起在 4321」，实际不是。
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`端口 ${this.port} 已被占用。换一个：zelto web --port <其他端口>`));
          return;
        }
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.port, this.host);
    });

    // ── 运行期的 error 监听（关键）────────────────────────────────────
    //
    // 上面那个 `onError` 是**一次性**的（`once`），且在 `listening` 之后
    // 就被移除了。于是运行期再来一个 `'error'` 事件时，
    // EventEmitter 找不到监听器 → **抛未捕获异常 → 进程直接退出**。
    //
    // 运行期的 `'error'` 不是没有的：accept 失败、端口耗尽、
    // socket 层面的错误都会触发。Node 的 HTTP server 文档明确说
    // 「'error' 事件在 server 上**不会**自动处理」。
    //
    // 后果：驾驶舱**突然消失**，而浏览器里的页面看着跟平常一样
    // （只是不再更新）。这是「驾驶舱经常关闭」的一个真实来源 ——
    // 而且比「终端窗口被关了」更让人措手不及，因为终端里只有一行红字。
    //
    // 修法：常驻监听，把错误**记下来并报给人**，但不退出进程。
    // 驾驶舱是观察窗 —— 一次 accept 失败不该让整块仪表盘蒸发。
    this.runtimeErrorHandler = (err: NodeJS.ErrnoException) => {
      const message = err?.message ?? String(err);
      console.error(`⚠️  zelto 驾驶舱运行期出错：${message}`);
      console.error(`    服务仍在运行（端口 ${this.port}）。`);
    };
    server.on('error', this.runtimeErrorHandler);
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    if (this.runtimeErrorHandler) {
      server.off('error', this.runtimeErrorHandler);
      this.runtimeErrorHandler = null;
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    this.server = null;
  }

  /** 服务的实际地址（用于打印给用户）。 */
  get url(): string {
    // 端口 0 = 让系统分配一个 —— 那时 `this.port` 是 0，不是真正绑定的端口。
    //
    // 必须从 server 里读实际值：`server.address().port`。
    // 否则 `zelto web --port 0` 会打印出一个连不上的地址，
    // 而测试里 `fetch(server.url)` 直接 ECONNREFUSED / EADDRNOTAVAIL。
    const actual = this.server?.address();
    const port = actual && typeof actual === 'object' ? actual.port : this.port;
    return `http://${this.host}:${port}`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', this.url);
      const path = url.pathname;

      // ── 静态页面 ──────────────────────────────────────────────────────
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        const html = renderIndexHtml(this.sessionToken);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(html);
        return;
      }

      // ── API ───────────────────────────────────────────────────────────
      if (path.startsWith('/api/')) {
        await this.handleApi(req, res, url);
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      // ── 这里必须自己兜住「响应已经发出去了」的情况 ──────────────────
      //
      // 原来的写法是 `sendJson(res, 500, { error })`，**没有保护**。
      // 而 `sendJson` 内部是 `res.writeHead(...)` —— 如果响应**已经开始**
      // （比如 handler 写了一半才抛错，或管道已被客户端断开），
      // `writeHead` 会抛 `ERR_HTTP_HEADERS_SENT`。
      //
      // 这个抛出发生在 **catch 块内部** → 它逃出 `handle()` →
      // `void this.handle(req, res)` 没人接 → **未处理的 promise rejection**。
      //
      // 在没有崩溃兜底时，Node 对未处理 rejection 的默认行为是
      // **终止进程** —— 于是「一次请求出错」变成了「整个驾驶舱消失」。
      //
      // 所以：先判响应状态，能补就补，不能补就只记一笔。
      // **绝不让错误处理本身再抛一次。**
      const message = err instanceof Error ? err.message : String(err);
      if (res.headersSent) {
        // 响应已经开始 —— 补不了状态码，也发不出新 body。
        // 只能把连接掐掉（客户端会看到一个不完整的响应），
        // 并把原因记下来让人能查。
        console.error(`⚠️  zelto 驾驶舱处理请求时出错（响应已开始发送）：${message}`);
        res.destroy();
        return;
      }
      try {
        sendJson(res, 500, { error: message });
      } catch (sendErr) {
        console.error(
          `⚠️  zelto 驾驶舱回 500 时又出错了：${sendErr instanceof Error ? sendErr.message : String(sendErr)}`,
        );
        try {
          res.destroy();
        } catch {
          // 连销毁都失败 —— 没什么可做的了
        }
      }
    }
  }

  private async handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname;

    // ── 写操作的双因子校验（ADR-072 §3）─────────────────────────────
    //
    // 顺序很重要：**先校验，后分发**。
    // 校验没过就绝不能碰到任何 handler。
    //
    // 三道防线（ADR-084 §5）：
    //   1. Origin —— 浏览器发起的必须同源
    //   2. token  —— 每次启动随机生成，第三方网页拿不到
    //   3. Content-Type —— 必须是 application/json
    //
    // 第 3 道为什么必需：token + Origin 已经挡住跨站了，
    // 但 `fetch(..., {mode:'no-cors'})` 能发 `text/plain` 的 body ——
    // 那种请求的 Content-Type 不是 application/json。
    // 显式要求 JSON，就把它挡在外面。
    //
    // 为什么这道防线是必需的：驾驶舱**持有项目目录的写权限**。
    // 一个恶意网页如果能让它跨站 POST，就等于拿到了
    // 「在你的项目里签字」的权限。
    if (req.method === 'POST') {
      if (!this.checkOrigin(req)) {
        sendJson(res, 403, {
          error: 'Origin 校验失败：写操作只接受来自本服务的请求',
        });
        return;
      }
      if (!this.checkToken(req)) {
        sendJson(res, 403, {
          error: '会话 token 无效或缺失：写操作必须带 X-Zelto-Token',
        });
        return;
      }
      if (!this.checkContentType(req)) {
        sendJson(res, 415, {
          error: 'Content-Type 必须是 application/json',
        });
        return;
      }
    }

    const ctx: WebContext = {
      method: req.method ?? 'GET',
      path,
      query: url.searchParams,
      api: this.api,
      repoRoot: this.repoRoot,
      body: req.method === 'POST' ? await readJsonBody(req) : undefined,
      crashGuard: this.crashGuard,
    };

    const router = createWebRouter();
    await router.dispatch(ctx, res);
  }

  /**
   * Origin 校验：写操作的 `Origin` 必须为空或等于本服务。
   *
   * 空 = 非浏览器发起的（同源导航、`curl`、脚本）—— 那些不是 CSRF 面。
   * 非空 = 浏览器发起的，必须同源。
   */
  private checkOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    return origin === this.url;
  }

  /**
   * token 校验：请求头里的 token 必须等于本次会话的 token。
   *
   * 用 `timingSafeEqual` 比较 —— 定长比较，避免时序侧信道。
   */
  private checkToken(req: IncomingMessage): boolean {
    const provided = req.headers['x-zelto-token'];
    if (typeof provided !== 'string') return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(this.token);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /**
   * Content-Type 校验：写操作必须带 `application/json`（ADR-084 §5）。
   *
   * 为什么不能省：跨站表单提交发的是
   * `application/x-www-form-urlencoded`；`fetch` 的 `no-cors` 模式能发
   * `text/plain` 的 body。两者都能带着一个 JSON 文本打到本服务。
   *
   * 显式要求 JSON，就把「不是从驾驶舱页面发起的写操作」挡在外面 ——
   * 这是 token 与 Origin 之外的第三道防线。
   */
  private checkContentType(req: IncomingMessage): boolean {
    const raw = req.headers['content-type'];
    if (typeof raw !== 'string') return false;
    // 允许带 charset：application/json; charset=utf-8
    const mime = raw.split(';')[0]?.trim().toLowerCase();
    return mime === 'application/json';
  }
}

/**
 * 读 POST 的 JSON 请求体。
 *
 * 上限 1MB —— 不设上限的话，一个巨大的 body 能把内存吃光。
 * 超限直接截断并当作「解析不出来」处理（返回 undefined），
 * 不抛异常 —— 让上层的业务校验去拒绝（缺凭据 → 拒绝签字），
 * 比在传输层抛 500 更合语义。
 *
 * 解析失败返回 undefined 而不是抛错：同上，
 * 「body 不是合法 JSON」应当由签字流程报「缺少确认项凭据」，
 * 那才是人看得懂的话。
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const MAX_BYTES = 1024 * 1024;
  const chunks: Buffer[] = [];
  let size = 0;

  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > MAX_BYTES) return undefined;
      chunks.push(buf);
    }
  } catch {
    return undefined;
  }

  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    return undefined;
  }
}

/** 统一发 JSON。**从不发** `Access-Control-Allow-Origin`（ADR-072 §3）。 */
export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

/**
 * 校验路径参数。
 *
 * 挡住 `..`、路径分隔符、空串 —— 这些是路径穿越的原料。
 * 返回 null 表示非法。
 */
export function validId(id: string | null): string | null {
  if (!id) return null;
  if (!ID_PATTERN.test(id)) return null;
  // `.` 与 `..` 单独拦一道 —— 它们符合上面的字符集但仍是穿越原料
  if (id === '.' || id === '..') return null;
  return id;
}
