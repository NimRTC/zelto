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

export interface WebServerOptions {
  /** 监听端口 */
  port: number;
  /** 仓库根（跑 git、定位 .zelto） */
  repoRoot: string;
  /** 宿主地址 —— 硬编码 127.0.0.1，不对外暴露 */
  host?: string;
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
  private server: Server | null = null;

  constructor(options: WebServerOptions) {
    this.port = options.port;
    this.host = options.host ?? DEFAULT_HOST;
    this.repoRoot = options.repoRoot;
    this.api = new WebApi(options.repoRoot);
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
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
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
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: message });
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
