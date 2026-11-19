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

import { WebServer } from '../../adapters/web/index.js';
import { register } from './shared.js';

const DEFAULT_PORT = 4321;

register('web', async (args) => {
  // `--help` 只读说明，不能进服务 —— 不拦住的话 `--help` 会被当成正常启动，
  // 直接占住端口跑起一个前台服务（实测 `zelto web --help` 卡死在这）
  if (args.includes('--help') || args.includes('-h')) {
    console.error(`Usage: zelto web [--port ${DEFAULT_PORT}] [--open]`);
    console.error('');
    console.error('  --port <n>  监听端口（默认 4321，非法则拒绝启动）');
    console.error('  --open      启动后自动打开浏览器');
    return 0;
  }
  const portIdx = args.indexOf('--port');
  let port = DEFAULT_PORT;
  if (portIdx >= 0) {
    const parsed = Number.parseInt(args[portIdx + 1] ?? '', 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
      console.error(`❌ 端口号非法：${args[portIdx + 1] ?? '(空)'}`);
      console.error(`   用法：zelto web [--port ${DEFAULT_PORT}] [--open]`);
      return 1;
    }
    port = parsed;
  }

  const openBrowser = args.includes('--open');

  const server = new WebServer({ port, repoRoot: process.cwd() });

  try {
    await server.start();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`❌ Web 驾驶舱启动失败：${message}`);
    return 1;
  }

  console.log(`🌐 zelto 驾驶舱已启动：${server.url}`);
  console.log(`   （能接管：签字 / 拒签 / 回答 / 拉闸 + 冻结 / 门禁 / 开跑 / 续跑）`);
  console.log(`   （签字不等于合并 —— 合入主干请跑 zelto merge <id>）`);
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
      void server.stop().then(() => resolve());
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });

  return 0;
});
