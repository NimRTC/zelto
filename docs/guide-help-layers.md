# 分层帮助用户指南（help）

帮助分三层（L1 → L2 → L3），层层可达，不丢既有信息。

## 各层帮助如何获取

- 顶层帮助（L1）：`zelto help`（默认仅“核心切片 + 项目管理”两组），
  全量用 `zelto help --all`（全部 7 组，每条命令带 L3 参数清单）。
  `zelto --help` 与 `zelto help` 等价，都回顶层概览。
- 命令帮助（L2）：`zelto help <command>`（如 `zelto help run`），
  输出命令名 + 用途 + 用法行 + 选项列表。
  `zelto <command> --help`（如 `zelto run --help`）与之等价，显示同一命令说明。
- 子命令/参数帮助（L3）：`zelto help <command> <param>`
  （如 `zelto help run --dry-run`），也支持
  `zelto help <group>/<command>/<param>` 直达
  （如 `zelto help 治理与运行时/why/--operation`），
  输出参数名 + 描述 + 约束/默认值。

## 层级导航

- `..` 返回上层，`top` 返回顶层（如 `zelto help ..`、`zelto help top`）。
- `--help` / `-h` 与当前层级自适应：在 L1 传 `--help` 显示顶层概览的帮助提示，
  在 L2 显示当前命令的说明，在 L3 显示当前参数的详解（传 `-h` 同理）。

## 示例

```sh
zelto help                          # L1：顶层概览（两组）
zelto help --all                    # L1 全量：七组 + 每条命令的参数清单
zelto help run                      # L2：run 的用法行 + 选项列表
zelto help run --dry-run            # L3：--dry-run 的描述 + 约束/默认值
zelto help 治理与运行时/why/--operation  # L3 直达：why 的 --operation 参数
```

未知组/命令/参数不崩溃：给可识别提示 + 用法，退出码 0。
