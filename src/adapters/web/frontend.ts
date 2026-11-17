// Web 驾驶舱的前端（ADR-072）
//
// 纯原生 HTML/CSS/JS，无框架、无构建步骤（ADR-010 §7.1）。
// **内嵌成字符串** —— 服务端不读任意文件（ADR-072 §7 的「路径穿越」防线）。
//
// XSS 防线：**所有来自 API 的数据一律用 `textContent` 写入**，
// 不拼 `innerHTML`。唯一的 `innerHTML` 用在静态标记上（常量，无数据）。
//
// 实时性用 **5 秒轮询**，不用 SSE —— SSE 要在服务端保持连接状态，
// 那是内存状态，而 zelto 的状态只该在文件里（ADR-072 §6）。

import { renderAppJs, renderStyles } from './frontend-assets.js';

/**
 * 渲染 SPA 首页。
 *
 * @param sessionToken 本次会话的 token —— 写操作要带在 `X-Zelto-Token` 头里。
 */
export function renderIndexHtml(sessionToken: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>zelto 驾驶舱</title>
<style>
${renderStyles()}
</style>
</head>
<body>
<div id="app">
  <header>
    <h1><span id="project-name" class="project-name">…</span> <span class="h1-sep">·</span> <span class="h1-sub">zelto 驾驶舱</span> <small id="summary-line">加载中…</small></h1>
    <div class="head-meta">
      <span id="refresh-line" class="muted small">正在连接…</span>
      <span id="project-root" class="muted small"></span>
    </div>
    <nav>
      <button data-view="overview" class="active">总览</button>
      <button data-view="slices">切片</button>
      <button data-view="signs">待签字</button>
      <button data-view="events">事件</button>
      <button data-view="metrics">度量</button>
      <button data-view="stalls">停机</button>
      <button data-view="pipeline">全链</button>
      <button data-view="budget">预算</button>
      <button data-view="policy">策略</button>
    </nav>
  </header>
  <main id="main"><p class="muted">加载中…</p></main>
  <div id="conn" class="banner" style="display:none"></div>
  <div id="banner"></div>
</div>
<script>
window.__ZELTO_TOKEN__ = ${JSON.stringify(sessionToken)};
${renderAppJs()}
</script>
</body>
</html>`;
}
