// 前端静态资源 —— 从独立源文件读入并嵌入首页（ADR-093）
//
// ── 为什么是「读文件」而不是「模板字符串」────────────────────────────
//
// 2026-11-19 这层原本是一个外层模板字符串。它让整个驾驶舱不可用了一次
// （修复见 `e8e2f26`）：模板字符串会**先求值一次**，于是「源码里写下的字符」
// 与「浏览器收到的字符」不是同一串。内层的 `'\n'` 被外层吃掉变成真换行，
// 字符串字面量跨行 → 45KB 脚本整段被浏览器拒绝，页面永远停在「加载中…」，
// 而且**没有任何错误提示**。
//
// 根因不是谁手滑，是结构：两层转义叠在同一个位置，规则还不一样，
// 「该写一个还是两个反斜杠」只能靠猜。ADR-093 把它改成独立 `.js` 文件 ——
// **让前端代码作为代码被解析，而不是作为字符串被拼接**。
//
// ── 与 ADR-072 §7「服务端不读任意文件」的关系 ─────────────────────────
//
// 读的是**包内写死的相对路径**，不接受配置 / 请求 / 环境变量的任何输入。
// 等价于以前读一个常量字符串；路径穿越防线不变（C5 同一思路：
// 配置不能越权）。
//
// ── 读不到就抛错，不许静默返回空串 ────────────────────────────────────
//
// 空脚本会让页面白屏且毫无提示 —— 那正是本次故障的另一种形态。
// 与其让「文件没复制进 dist/」变成一个人看不出原因的空白页面，
// 不如在这里直接崩掉并说清楚缺哪个文件。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 读一份随包发布的静态资源。
 *
 * 资源与编译产物同目录（`dist/adapters/web/frontend/`），由 `build-dist.mjs`
 * 从 `src/` 复制过来。`src/` 下直接跑（单元测试）时读到的也是同一路径。
 */
function readAsset(name: string): string {
  const path = join(here, 'frontend', name);
  try {
    return readFileSync(path, 'utf-8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `前端资源缺失：${path}\n` +
        `这不是运行时问题，是构建问题 —— 构建时要把 src/adapters/web/frontend/ ` +
        `复制到 dist/ 旁边。原始错误：${reason}`,
    );
  }
}

/** 样式表 —— 深色终端风，与 `zelto dashboard` 的 HTML 看板同一套视觉语言。 */
export function renderStyles(): string {
  return readAsset('styles.css');
}

/**
 * 浏览器端脚本。
 *
 * 纪律（与以前一致，只是代码搬家了）：
 *   1. API 数据一律 `textContent` 写入（不拼 innerHTML）—— XSS 防线
 *   2. 写操作带 `X-Zelto-Token` 头 —— CSRF 防线（ADR-072 §3）
 *   3. 签字按钮的启用条件由**服务端返回的判定**决定 —— 前端只是呈现
 */
export function renderAppJs(): string {
  return readAsset('app.js');
}
