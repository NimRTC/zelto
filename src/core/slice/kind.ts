// 切片分类 —— 与门禁无关的「这个切片是什么类型」的判定词汇
//
// 为什么单独一个文件：
//
//   SliceType 同时被切片自己（core/slice/store.ts 的 SliceData.type）
//   和门禁（core/gate 按类型挑 profile）使用。
//   它若住在 core/slice/types.ts，而 types.ts 又需要 store.ts 的
//   SliceSpec / SliceData，store.ts 又要回头引 types.ts 的 SliceType，
//   就形成文件级的环（类型级互引也是环）。
//
//   放在这里：零 import，谁要用引谁，两边都不成环。
//
// 归属：这是**切片的分类**，语义上属 slice 域；gate 只是消费者。
// 见 docs/adr-031-slice-type-ownership.md。
//
// C3: 纯类型声明，不调模型、不触网
// C6: core/ 内，不依赖 adapters/

/**
 * 切片类型分类 —— 决定该切片跑哪一套门禁 profile。
 *
 * - `code`：包含代码改动
 * - `docs`：纯文档改动
 * - `config`：配置改动
 * - `refactor`：不改变行为的重构
 */
export type SliceType = 'code' | 'docs' | 'config' | 'refactor';
