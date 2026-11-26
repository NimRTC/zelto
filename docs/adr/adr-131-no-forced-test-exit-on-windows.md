# ADR-131：测试进程不许硬退 —— `--test-force-exit` 在 Windows + Node≥23 上会崩

- **状态**：已采纳
- **日期**：2026-11-27
- **关联**：ZD-063、nodejs/node#56645、nodejs/node#61999

## 背景

`scripts/filter-tests.mjs` 恒定给 `node --test` 传 `--test-force-exit`。
原始理由（写在脚本注释里）：

> 没有凭据时 agent 适配器会留下打开的句柄，测试进程永远不退出。

在 Windows + Node ≥ 23 上，这个 flag 的代价大于它的收益。

## 病灶

`npm run test:unit` 偶发红 2~3 个测试文件，但**没有一个断言不通过**：

```
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
```

崩溃发生在**进程退出时**（测试用例全绿之后）。
表现是「测试红了，但你找不到哪条断言错了」—— 这比红更坏：
红会告诉你「有问题」，这里告诉你的是「有鬼」。

## 根因

`--test-force-exit` 让 `node --test` 在测试跑完后**立刻 `process.exit()`**。

Node 内置 `fetch` 走 **undici 的全局连接池**。跑过 **2 次及以上** fetch 后，
池里就有一个 keep-alive 的 socket 还没被关。`process.exit()` 时：
Node 调 `uv_async_send` 去通知一个已被 `uv_close` 标记 `UV_HANDLE_CLOSING`
的句柄 → libuv 断言崩溃 → 进程以 `0xC0000409` 退出。

这是 **Node 自身的 bug**，不是 zelto 的：

- [nodejs/node#56645](https://github.com/nodejs/node/issues/56645) —— Windows + Node 23.x 起必现
- [nodejs/node#61999](https://github.com/nodejs/node/pull/61999) —— 已修（2026-07-24 合入 main），**但还没进任何已发布版本**

### 实测的判据矩阵（本机 Node 24.16.0 / Windows）

| 条件 | 结果 |
|---|---|
| 1 次 `fetch` + `process.exit()` | 不崩 |
| **2 次** `fetch` + `process.exit()` | **崩** |
| 2 次 `fetch` + `process.exit()` + `server.close()` | **仍崩** |
| 2 次 `fetch` + 自然退出（不 `process.exit()`） | 不崩 |

几个曾被怀疑、但**已被排除**的因素（避免后来人重走弯路）：

- 与 git 子进程无关（git 探针单独跑不崩）
- 与 server 收没收停无关（`server.close()` 救不了 —— 崩的是**客户端**连接池里的 socket）
- 与并发无关（两个**顺序** fetch 一样崩）
- 与 zelto 的代码无关 —— 纯 `node:http` + 纯 `fetch` 就能复现

### 最小复现

```js
const { createServer } = require('node:http');
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{}');
});
server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  await (await fetch('http://127.0.0.1:' + port + '/a')).json();
  await (await fetch('http://127.0.0.1:' + port + '/b')).json();
  process.exit(0);   // ← 这一行是触发器
});
```

## 决策

**去掉 `--test-force-exit`，让事件循环自然排空。**

替代兜底：`--test-timeout=600000`（单个用例 10 分钟上限）。
原来「硬退」的职责是「别让测试进程吊死」，现在由「超时即失败」承担 ——
而且这个信号**更明确**：挂住的用例会报「超时」，而不是让整个进程无声地断掉。

### 为什么不做版本分支

理论上可以「Node ≥ 23 才去掉 force-exit」。但那会让本地和 CI 走**两条不同的测试语义**，
而 Node 什么时候发新版、CI 什么时候升级，我们控制不了。
判据统一成一条更省心：**永远不硬退**。

CI 现在 pin Node 22（那个 bug 从 Node 23 才开始有），所以 CI 本来就不受影响 ——
但我们不靠「CI 绿了」来证明本地也该绿。

## 后果

- 本机（Node 24.16.0）`npm run test:unit`：**3274 pass / 0 fail**，不再有 libuv 崩溃
- `node scripts/filter-tests.mjs --all`（全量 3415 个）：**0 fail**，且不会吊死
- 测试进程不再有「强制退出」语义 —— 若有测试真的漏了清理，会表现为**超时失败**而不是「进程莫名消失」

## 回归防线

`tests/zd063-no-force-exit-on-windows.test.ts` 钉住三件事：

1. **最小复现还在** —— 纯脚本 + 2 次 fetch + `process.exit()` 仍然崩。
   Node 修好的那天这条会红 —— 那正是撤掉绕行方案的信号。
   没有它，绕行会永远留着，没人知道为什么。
2. **`filter-tests.mjs` 里没有 `--test-force-exit`** —— 判据读**源码**，
   因为「跑一遍绿不绿」是概率，「源码里没有那个 flag」才是事实。
3. **`--test-timeout` 在位** —— 兜底不能跟着绕行方案一起被删掉。

## 边界

本 ADR 只改**测试运行方式**，不动任何判定、契约或不变量。
`core/` 依旧零第三方依赖、判定依旧确定性（C1–C9 不变）。
