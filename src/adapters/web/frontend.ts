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
      <!-- 崩溃提示的**独立**容器 ——
           它与「连接断开」是两件事：
             - 连接断开 = 服务**没了**（该重新跑 zelto web）
             - 出过错   = 服务**还在**（别重启，页面可能不新鲜而已）
           混一个容器会互相覆盖：先断连后出错会把「该重启」的提示顶掉，
           反之亦然 —— 人看到的永远不是当下最要紧的那件事。 -->
      <span id="crash-line" class="muted small"></span>
      <span id="project-root" class="muted small"></span>
    </div>
    <nav id="nav">
      <!-- ADR-109 决策四补充（2026-11-28）：窄屏导航折叠。
           9 个视图按钮 + 拉闸在 390px 宽的屏幕上要占 **3 行**（实测截图），
           把首屏内容挤到屏幕外。改成「当前视图 + ☰ 菜单」：
           窄屏只显示当前视图名与菜单按钮，点 ☰ 展开全部。
           桌面端 nav 完全不变（#nav-toggle 在 >=721px 时 display:none）。
           注意：这里不能写反引号 —— 本段在模板字符串里，反引号会终止它。

           2026-11-28 修正：#nav-current 原来是个 button，
           还带 aria-expanded / aria-controls —— 但它**不是**展开/收起控件，
           只是个「我在哪个视图」的文字指示器。三个问题叠在一起：
             ① aria-expanded 挂在非折叠控件上，读屏软件会播报「已折叠」，
                但按回车毫无反应（实测：点击它菜单不动）。
             ② 它进了 Tab 序列 —— 键盘用户 Tab 到一个按了没反应的按钮。
             ③ aria-label="当前视图" 会**盖掉**「总览」这个真正的名字，
                读屏只念「当前视图」，反而不知道人在哪。
           所以改成 span（aria-live="polite"）：
           它是**状态播报**（切视图时念出新的视图名），
           不是控件 —— 不该进 Tab 序列，不该有折叠语义。
           折叠语义归 #nav-toggle 独占。 -->
      <span id="nav-current" aria-live="polite">总览</span>
      <button id="nav-toggle" type="button" aria-expanded="false" aria-controls="nav-list" aria-label="展开视图菜单">☰ 视图</button>
      <div id="nav-list">
      <button data-view="overview" class="active">总览</button>
      <button data-view="slices">切片</button>
      <button data-view="signs">待签字</button>
      <button data-view="events">事件</button>
      <button data-view="metrics">度量</button>
      <button data-view="stalls">停机</button>
      <button data-view="pipeline">全链</button>
      <button data-view="budget">预算</button>
      <button data-view="policy">策略</button>
      </div>
      <!-- ADR-084：拉闸按钮放在导航末尾 ——
           「交回控制权」是一个**随时可能需要**的动作，
           不该藏在某个视图里让人先找到那个视图。

           2026-11-28：窄屏折叠后它**留在 #nav-list 之外** ——
           折叠态下菜单是收起的，而拉闸是「刹车」：
           真出事时人要能**一眼看到、一键点到**，不能先展开菜单再找。 -->
      <button id="halt-btn" class="danger" title="暂停批次并交回控制权">⏸ 拉闸</button>
    </nav>
  </header>
  <main id="main"><p class="muted">加载中…</p></main>
  <!-- 连接状态条与动作横幅 —— 都是「会自己更新的状态」，
       所以挂 aria-live（2026-11-28 补）。
       读屏软件只在**内容变化时**播报，不会打断用户当前的朗读。
       优先级：
         conn   = alert  —— 「服务没了」是最要紧的事，要立刻说
         banner = polite —— 动作结果（签字成功/失败）等一下再说也行
       没有 aria-live 的话，读屏用户**完全不知道**这两个框里出了事
       （实测：aria-live 区域数为 0）。 -->
  <div id="conn" class="banner" role="alert" aria-live="assertive" style="display:none"></div>
  <div id="banner" role="status" aria-live="polite"></div>
</div>
<script>
window.__ZELTO_TOKEN__ = ${JSON.stringify(sessionToken)};
${renderAppJs()}
</script>
</body>
</html>`;
}
