// 命令目录 —— 所有 CLI 命令的「有哪些、怎么用、分在哪组」的唯一真源。
//
// 为什么要它：`zelto help` 的输出、`zelto help <cmd>` 的用法说明、
// shell 补全脚本的命令列表，三者以前各写一份，改一个漏一个——
// 13 个已注册的命令没进 help，`help run` 直接崩，补全列表也少一半。
//
// 现在三者都从这里出。新增命令只要在 COMMAND_CATALOG 里加一行，
// help 与补全自动跟上；`tests/cli-catalog.test.ts` 守着「注册了的命令
// 必须在目录里、目录里不能有没实现的命令」这条不变式。

/** 一个命令的元信息 */
export interface CommandInfo {
  /** 命令名（不含 `zelto ` 前缀） */
  name: string;
  /** 参数部分，用于列表里的对齐列——保持短，旗标放 detail 里 */
  args: string;
  /** 一句话说明 */
  summary: string;
  /** 补充的旗标/子命令说明（可选） */
  detail?: string;
  /** 分组名——help 输出按它分节 */
  group: string;
}

/** 分组顺序（help 输出按这个顺序排） */
export const COMMAND_GROUPS: string[] = [
  '核心切片',
  '项目管理',
  '治理与运行时',
  'AI 流水线',
  '项目接管',
  '全景与依赖',
  '其他',
];

/** 全部命令的目录 */
export const COMMAND_CATALOG: CommandInfo[] = [
  // ─── 核心切片 ──────────────────────────────────────────────────────────
  { name: 'create', group: '核心切片', args: '<id>', summary: '创建一个新切片（不带参数时进入交互式）', detail: '--title, --writes, --json' },
  { name: 'slices', group: '核心切片', args: '', summary: '列出所有切片', detail: '--active, --json, --prune' },
  { name: 'slice', group: '核心切片', args: '<id>', summary: '查看切片详情', detail: '--json' },
  { name: 'check', group: '核心切片', args: '<id>', summary: '门禁① 冻结前的确定性检查', detail: '--json' },
  { name: 'clarify', group: '核心切片', args: '<id>', summary: '澄清切片规格', detail: '--auto, --dry-run' },
  { name: 'freeze', group: '核心切片', args: '<id>', summary: '冻结切片基线', detail: '--json' },
  { name: 'run', group: '核心切片', args: '<id>', summary: '执行切片', detail: '--dry-run, --agent, --adapter, --hotfix --yes, --json' },
  { name: 'start', group: '核心切片', args: '<id>', summary: '一条命令走完 create → check → freeze → run', detail: '--yes, --agent, --adapter' },
  { name: 'admit', group: '核心切片', args: '<id>', summary: '检查切片准入', detail: '--json' },
  { name: 'gate', group: '核心切片', args: '<id>', summary: '门禁② 跑验收测试', detail: '--dry-run, --retry, --spec-md, --json' },
  { name: 'sign', group: '核心切片', args: '<id>', summary: '批准、拒绝或撤销已完成的切片', detail: '--approve | --reject | --revoke, --comment' },
  { name: 'inbox', group: '核心切片', args: '', summary: '查看待签字队列' },
  { name: 'abandon', group: '核心切片', args: '<id>', summary: '废弃一个切片' },
  { name: 'next', group: '核心切片', args: '', summary: '推荐该切片的下一步动作' },
  { name: 'suggest', group: '核心切片', args: '', summary: '项目全貌与建议动作' },
  { name: 'stall', group: '核心切片', args: '[id]', summary: '列出停机切片或查看其中一个', detail: '--auto-resolved' },
  { name: 'resume', group: '核心切片', args: '<id>', summary: '恢复停机切片', detail: '--skip, --abandon' },
  { name: 'ask', group: '核心切片', args: '', summary: '列出待回答的 agent 提问', detail: '--slice, --json' },
  { name: 'answer', group: '核心切片', args: '<qid> "<text>"', summary: '回答 agent 提问并恢复切片', detail: '--list' },
  { name: 'status', group: '核心切片', args: '', summary: '查看活跃 agent 会话', detail: '--watch, --json' },
  { name: 'events', group: '核心切片', args: '<id>', summary: '查看切片事件流', detail: '--json, --tail' },
  { name: 'diff', group: '核心切片', args: '<id>', summary: '查看切片产生的改动', detail: '--stat, --json' },
  { name: 'diff-highlight', group: '核心切片', args: '< diff.patch', summary: '读 stdin 的 unified diff，输出带 ANSI 高亮的版本' },

  // ─── 项目管理 ──────────────────────────────────────────────────────────
  { name: 'init', group: '项目管理', args: '', summary: '初始化 .zelto/ 目录', detail: '--with-examples, --force' },
  { name: 'summary', group: '项目管理', args: '', summary: '项目概况' },
  { name: 'report', group: '项目管理', args: '', summary: '生成状态报告', detail: '--format markdown|json' },
  { name: 'config', group: '项目管理', args: '[get|set] [key] [value]', summary: '查看或修改配置' },
  { name: 'set', group: '项目管理', args: '<id>', summary: '设置切片的可写字段', detail: '--field, --value' },
  { name: 'slice-status', group: '项目管理', args: '[id]', summary: '查看切片运行状态详情', detail: '--json' },
  { name: 'ss', group: '项目管理', args: '[id]', summary: 'slice-status 的别名', detail: '--json' },
  { name: 'tasks', group: '项目管理', args: '', summary: '列出后台任务' },
  { name: 'task-status', group: '项目管理', args: '[task-id]', summary: '查看后台任务状态' },
  { name: 'wait', group: '项目管理', args: '<task-id>', summary: '等待后台任务结束' },

  // ─── 治理与运行时 ──────────────────────────────────────────────────────
  { name: 'policy', group: '治理与运行时', args: '<subcommand>', summary: '策略规则的增删查改与校验', detail: 'list, show, check, validate, add, remove, edit' },
  { name: 'reservation', group: '治理与运行时', args: '<subcommand> [slice-id]', summary: '写集预约的查看与释放', detail: 'list, active, show, release, reap' },
  { name: 'drift', group: '治理与运行时', args: '<slice-id>', summary: '检查切片与冻结基线之间的漂移', detail: '--json' },
  { name: 'merge', group: '治理与运行时', args: '[id ...]', summary: '合并已签字的切片（不带 id 则合并全部待合切片；子命令 plan 只出计划）', detail: '--strategy, --dry-run, --push, --json' },
  { name: 'audit', group: '治理与运行时', args: '<slice-id>', summary: '查看切片的审计追踪', detail: '--json' },
  { name: 'hook', group: '治理与运行时', args: '', summary: '安装 / 卸载 git hooks', detail: '--install, --uninstall, --status' },
  { name: 'halt', group: '治理与运行时', args: '', summary: '拉闸：暂停正在跑的批次，交回控制权', detail: '--scope, --reason, --rollback, --clear, --list, --json' },
  { name: 'arch', group: '治理与运行时', args: 'check', summary: '架构偏离检查：设计模块图 vs 实际 import 图（只读报告）', detail: '--design, --root, --strict, --json' },

  // ─── AI 流水线 ─────────────────────────────────────────────────────────
  { name: 'require', group: 'AI 流水线', args: '<text>', summary: '用自然语言创建与细化需求文档', detail: 'list, show <id>, confirm <id>, refine <id> <text>' },
  { name: 'design', group: 'AI 流水线', args: '<req-id>', summary: '从需求生成与细化设计', detail: 'list, show <id>, confirm <id>, refine <id> <text>' },
  { name: 'plan', group: 'AI 流水线', args: '<design-id>', summary: '从设计生成版本计划并创建切片规格', detail: 'list, show <id>, confirm <id>, add-version <id> <d>' },
  { name: 'version', group: 'AI 流水线', args: '<subcommand>', summary: '查看与推进版本计划', detail: 'status, start <ver>, deliver <ver>' },
  { name: 'spec', group: 'AI 流水线', args: '<subcommand> <slice-id>', summary: '切片规格的草稿与确认：生成草稿 → 人确认后写进正式规格', detail: 'draft, show, confirm' },
  { name: 'pipeline', group: 'AI 流水线', args: 'status', summary: '需求→设计→计划→版本→切片 全链一览' },

  // ─── 项目接管 ──────────────────────────────────────────────────────────
  { name: 'project', group: '项目接管', args: '<subcommand>', summary: '接管既有项目：扫描、初始化治理、生成设计与基线切片', detail: 'scan, init, design, slice, status' },

  // ─── 全景与依赖 ────────────────────────────────────────────────────────
  { name: 'trace', group: '全景与依赖', args: '<req-id>', summary: '追溯需求到下游全链路', detail: '--json, --graph, --timeline' },
  { name: 'impact', group: '全景与依赖', args: '<req-id>', summary: '变更影响分析' },
  { name: 'snapshot', group: '全景与依赖', args: '[list|show <id>]', summary: '捕获 / 列出 / 查看项目状态快照', detail: '--json' },
  { name: 'depgraph', group: '全景与依赖', args: '<id> [id ...]', summary: '查看切片之间的依赖图', detail: '--depends-on, --json' },
  { name: 'artifact', group: '全景与依赖', args: 'check <id> <id> ...', summary: '检测切片之间的工件级冲突', detail: '--json' },
  { name: 'batch', group: '全景与依赖', args: '<id> [id ...]', summary: '审核这批切片能否一起开工，并排出执行阶段', detail: '--depends-on, --json' },
  { name: 'dashboard', group: '全景与依赖', args: '', summary: '生成项目看板 HTML', detail: '--watch, --open, --output, --tty, --json' },

  // ─── 其他 ──────────────────────────────────────────────────────────────
  { name: 'spec-md', group: '其他', args: '<validate|run> <slice-id>', summary: '校验切片规格文件结构 / 执行规格 checklist' },
  { name: 'patch-content', group: '其他', args: '', summary: '交互式按切片拆分补丁内容' },
  { name: 'completion', group: '其他', args: '[bash|zsh|fish]', summary: '生成 shell 补全脚本' },
  { name: 'help', group: '其他', args: '[<cmd>]', summary: '显示帮助 / 查看某个命令的用法' },
];

/** 按名字查命令 */
export function findCommand(name: string): CommandInfo | undefined {
  return COMMAND_CATALOG.find((c) => c.name === name);
}

/** 命令的完整用法行 */
export function usageOf(command: CommandInfo): string {
  return `zelto ${command.name}${command.args ? ` ${command.args}` : ''}`;
}

/** 按分组归拢，保持 COMMAND_GROUPS 的顺序 */
export function commandsByGroup(): Array<{ group: string; commands: CommandInfo[] }> {
  return COMMAND_GROUPS.map((group) => ({
    group,
    commands: COMMAND_CATALOG.filter((c) => c.group === group),
  })).filter((g) => g.commands.length > 0);
}
