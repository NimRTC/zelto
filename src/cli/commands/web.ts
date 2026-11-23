// `zelto web` —— 浏览器驾驶舱（ADR-072）
//
// 形态：**可接管的驾驶舱** —— 刹车（ADR-084：拒签 / 回答 / 拉闸）
//       + 油门（ADR-086：冻结 / 门禁 / 开跑 / 续跑）。
// 绑定：硬编码 `127.0.0.1`，不可配置（ADR-072 §7）。
//
// **纪律不变**：Web 侧**不重写判定**，只调 CLI 与 Web 共用的那一份 ——
//   - freeze / gate / resume → 直接调 `core/lifecycle/` 的编排
//   - run                  → 拉起 CLI 进程本身（`zelto run --detach`）
// 这样「浏览器里点的」与「终端里跑的」结论永远一致（C3）。
//
// 仍然没有 admit / abandon ——
// 那两个动作在 CLI 侧有完整实现，Web 侧再实现一份会分叉判定。
// 理由见 ADR-072 §4。

import { WebServer, installCockpitCrashGuard } from '../../adapters/web/index.js';
import { register } from './shared.js';

const DEFAULT_PORT = 4321;

/**
 * 端口参数解析。
 *
 * ── `--port 0` 是「让系统分配一个空闲端口」────────────────────────────
 *
 * 为什么需要它：**多开驾驶舱**。
 *
 * 同一台机器上常同时开多个项目的驾驶舱（zelto 自身 + nimrtc-v14 + …）。
 * 每个都得自己记一个不冲突的端口 —— 忘了就会撞，撞了就会得到
 * 「端口 4321 已被占用」的报错，第二块仪表盘起不来。
 *
 * `--port 0` 把这件事交给操作系统：**系统给一个当前没人占的端口**。
 * 人不需要记端口，也不需要试。
 *
 * 实际端口从 `server.address().port` 读（不是从 `--port` 的值读）——
 * 这一点 `WebServer.url` 已经做对了（见那里的注释）。
 *
 * ── 为什么不能「自动换端口」而不是报错退出 ────────────────────────────
 *
 * 这正是 ADR-072 §7 的硬要求：**端口占用要明确报错退出，不静默换端口**。
 *
 * 理由很实在：静默换端口会让人以为「驾驶舱起在 4321」，实际不是。
 * 人拿着 4321 的 URL 访问，访问到的是**另一个项目的驾驶舱**——
 * 这比「起不来」危险得多（对着错的看板签字）。
 *
 * 所以这两件事**必须分开**：
 *   - **端口被占** → 明确报错退出（不许偷偷换）
 *   - **显式要系统分配**（`--port 0`）→ 系统给一个空闲端口，并**打印出来**
 *
 * 后者是**人明说要的**，端口从一开始就是「随便一个空闲的」，
 * 不存在「以为它在 4321」的误解 —— 因为启动时就把实际端口打出来了。
 */
function parsePort(raw: string | undefined): { ok: true; port: number } | { ok: false; message: string } {
  const parsed = Number.parseInt(raw ?? '', 10);
  // `Number.parseInt('4321abc')` → 4321 —— 不认。
  // 必须整个字符串都是数字（0 允许，负数与小数不认）。
  if (raw === undefined || raw === '' || !/^\d+$/.test(raw.trim())) {
    return { ok: false, message: `端口号非法：${raw ?? '(空)'}` };
  }
  const n = Number.parseInt(raw.trim(), 10);
  // 0 = 让系统分配（见函数头）
  if (!Number.isFinite(n) || n < 0 || n > 65535) {
    return { ok: false, message: `端口号非法：${raw}` };
  }
  return { ok: true, port: n };
}

register('web', async (args) => {
  // `--help` 只读说明，不能进服务 —— 不拦住的话 `--help` 会被当成正常启动，
  // 直接占住端口跑起一个前台服务（实测 `zelto web --help` 卡死在这）
  if (args.includes('--help') || args.includes('-h')) {
    console.error(`Usage: zelto web [--port ${DEFAULT_PORT}] [--open]`);
    console.error('');
    console.error(`  --port <n>  监听端口（默认 ${DEFAULT_PORT}，非法则拒绝启动）`);
    console.error('             --port 0 = 让系统分配一个空闲端口（多开驾驶舱时用）');
    console.error('  --open      启动后自动打开浏览器');
    return 0;
  }
  const portIdx = args.indexOf('--port');
  let port = DEFAULT_PORT;
  if (portIdx >= 0) {
    const result = parsePort(args[portIdx + 1]);
    if (!result.ok) {
      console.error(`❌ ${result.message}`);
      console.error(`   用法：zelto web [--port ${DEFAULT_PORT}] [--open]`);
      console.error('   （--port 0 = 让系统分配一个空闲端口）');
      return 1;
    }
    port = result.port;
  }

  const openBrowser = args.includes('--open');

  // ── 崩溃兜底（先装，再构造服务）────────────────────────────────────
  //
  // 为什么必须在服务**启动之前**装：
  // 服务的整个生命周期里都可能抛出未捕获异常（事件流写入、
  // 文件读抖了、某个 handler 边界外的异步炸了）。
  // 没有兜底时，Node 的默认行为是「打印栈 → 退出进程」——
  // 驾驶舱**瞬间消失**，而浏览器里的页面看着一切正常（只是不再更新）。
  //
  // 兜底之后：出错 → 记一笔 + 报给人 + **服务继续跑**。
  // 页面还在、还在刷新，`/api/health` 会说清「出过错没有」。
  //
  // 兜底器要作为 option 传给 WebServer（服务端据此把它暴露给前端），
  // 所以顺序是「先装兜底 → 再构造服务 → 再启动」。
  //
  // 详见 `adapters/web/crash-guard.ts` 的文件头。
  const guard = installCockpitCrashGuard();

  const server = new WebServer({ port, repoRoot: process.cwd(), crashGuard: guard });

  try {
    await server.start();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`❌ Web 驾驶舱启动失败：${message}`);
    guard.dispose();
    return 1;
  }

  // `--port 0` 时把「端口由系统分配」**并进同一行** ——
  // 分成两行的话，脚本在读到 URL 那一刻还没看到下一行，
  // 人也要扫两遍才知道端口不是自己指定的。
  // 合并成一行：实际端口与它的来源同时到位。
  if (port === 0) {
    console.log(`🌐 zelto 驾驶舱已启动：${server.url}（端口由系统分配）`);
  } else {
    console.log(`🌐 zelto 驾驶舱已启动：${server.url}`);
  }
  console.log(`   （能接管：签字 / 拒签 / 回答 / 拉闸 + 冻结 / 门禁 / 开跑 / 续跑）`);
  console.log(`   （签字不等于合并 —— 合入主干请跑 zelto merge <id>）`);
  // 打出 pid —— 人判断「服务还在不在」的第一手依据。
  // 之前只有一个 URL：URL 在服务死后依然能复制粘贴，
  // 于是人拿旧 URL 反复试，得到的全是「连不上」。
  console.log(`   （pid ${process.pid} —— 服务停了的话这个进程就没了）`);
  console.log('   Ctrl+C 停止');

  if (openBrowser) {
    try {
      const { execSync } = await import('node:child_process');
      const p = process.platform;
      if (p === 'win32') execSync(`start "" "${server.url}"`, { timeout: 5000 });
      else if (p === 'darwin') execSync(`open "${server.url}"`, { timeout: 5000 });
      else execSync(`xdg-open "${server.url}"`, { timeout: 5000 });
    } catch {
      console.log(`   手动打开：${server.url}`);
    }
  }

  // 保持进程运行 —— 显式的前台进程，不是常驻 daemon（ADR-072 §10）
  await new Promise<void>((resolve) => {
    const stop = () => {
      guard.dispose();
      void server.stop().then(() => resolve());
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });

  return 0;
});
