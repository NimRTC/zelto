# ADR-082：所有「写文件后报告成功」的路径必须经过可核对的写入原语

**状态**：实施
**日期**：2026-11-18
**相关**：ADR-070（policy 编辑路径的静默失败防线）、D-31、C1（状态只在文件里）、C3（确定性判定）

## 背景

实战演练（`docs/zelto-实战演练记录-20261116.md`）暴露出一个会**持续产生新病灶**的形状：

> 工具调用了写文件的 API，随后返回 `success: true`；但文件可能没变、可能写失败、可能只写了一半。

ADR-070 只给 `policy.yaml` 的分段编辑路径补了「先确认段/条目在，再动手」的防线。
其它写路径没有同构防线，于是同一个形状会以不同面貌复发：

- `removeSectionEntry()` 找不到条目时原样返回，调用方照样报「✓ 已删除」；
- `zelto config set` 只看「有没有在文本里找到 key」，找到但内容未变也报成功；
- 任何直接 `writeFileSync()` 的路径都无法证明「文件现在的内容就是我要写的内容」。

更危险的是「报告成功」这句话本身：

> **「报告成功」必须能被独立证据复核 —— 读回文件比对内容，而不是「我调用了 writeFileSync 所以成功了」。**

## 决策

### ① 提取统一写入原语

新增 `src/core/io/atomic-write.ts`（仅用 Node 内置，零第三方依赖）：

```ts
export interface WriteReceipt {
  path: string;
  bytes: number;
  hash: string;      // sha256:<hex>
  changed: boolean;  // 与写前内容是否不同
}

export async function atomicWriteFile(path, content): Promise<WriteReceipt>;
export async function atomicWriteText(path, content): Promise<WriteReceipt>;
```

原语的保证：

1. **原子替换**：先写同目录临时文件，再 `rename` 覆盖；临时文件与目标在同一文件系统内。
2. **写完必验**：读回目标文件，逐字节比对预期内容；不一致直接抛错。
3. **失败必抛**：不吞异常，不返回「看起来成功」的结果。
4. **成功有凭据**：返回值带字节数、SHA-256 哈希、是否发生变化。

### ② 调用方必须复核「内容是否真的变了」

对于「修改既有状态文件」的命令，**内容没变就是失败**，不能报成功。
原语返回 `changed: false` 时，调用方必须：

- 返回非 0 退出码；
- 打印明确的原因（目标条目/键不存在、内容已是期望值等）；
- 不写「成功」类事件。

### ③ 接入范围

第一批接入所有**用户可见、修改状态文件**的路径：

- `zelto set`（切片字段）
- `zelto config set`
- `zelto spec draft` / `zelto spec confirm`
- `zelto design patch`
- `zelto plan patch`
- `zelto patch-content`
- `zelto policy add/edit/remove` 与 `zelto policy arch add/edit/remove`
- `zelto slice create`

其余 `core/` 状态 store（切片、设计、版本计划、签字、预约等）改用同一原语保存，
保证「状态只落在文件里」这条链路上，写失败不会静默。

## 不变量核查

- **C1**：无影响。状态仍只在文件里；原语只是把写文件这件事做得更可靠。
- **C2**：满足。`core/io/atomic-write.ts` 只用 `node:fs` / `node:path` / `node:crypto`。
- **C3**：满足。只做文件读写与哈希计算，不调模型、不触网。
- **C4**：强化。写失败不再被当成成功动作，后续事件流不会记录一个没发生的变更。
- **C5**：无影响。
- **C9**：无影响。写入范围仍由既有写集预约机制控制。

## 验收标准

1. 统一原语存在，且写完读回比对；不一致必抛错。
2. 写失败时命令退出码非 0，不打印成功提示，不写成功事件。
3. `zelto config set`、`zelto set`、`zelto spec confirm`、`zelto design patch`、`zelto plan patch`、
   `zelto policy *`、`zelto patch-content`、`zelto slice create` 全部接入。
4. 每条接入路径至少一条回归测试：「内容没被改动时，命令必须报错退出码 ≠ 0」。
5. `npm test`、`npm run lint`、`npm run check:encoding` 全绿。

## 关联缺陷

- D-31：policy 编辑路径的静默失败（ADR-070 的直接前身）。
- §11.33：「查不到」比「算错」更难发现 —— 同形状。
- §11.35：「绿灯」本身也是需要被复核的断言。
