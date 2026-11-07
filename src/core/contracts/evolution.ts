// 契约演进检查 —— 「这次改动有没有把契约改坏」
//
// 背景（项目目标 §6.1 G-4 剩余项）：
// `contracts/schemas/` 只在 zelto 内部用。管理第三方项目时，接口改坏了
// 没有东西会发现 —— ContractRegistry 能校验「一份数据符不符合当前 schema」，
// 但它回答不了「上一版的 schema 放到这一版还成不成立」。
//
// 这里补的就是后半句：**给定旧契约与新契约，算出变化里哪些是破坏性的**。
//
// ── 方向语义 ─────────────────────────────────────────────────────────────
// 契约描述的是「会被写进磁盘、会被别的程序读」的东西（比如切片状态文件）。
// 所以破坏性有两个方向，方向不同，后果不同：
//
//   writer 破坏：新契约不再接受旧数据 —— 旧版本写出来的文件读不进来了
//   reader 破坏：新契约产出的数据旧程序读不懂 —— 升级后下游炸了
//
// 两个方向都要报。只报一个方向，等于只检查了一半。
//
// ── 判定口径（每条规则都归到下面两类之一）─────────────────────────────
//
//   收窄（新契约比旧契约更严）：writer 破坏
//     新增必填 / type 收窄 / enum 删取值 / enum 约束新增 /
//     additionalProperties 收紧为 false / 新增或抬高下界（minimum、minLength）/
//     新增或收紧上界（maximum、maxLength）/ 新增或改 pattern /
//     新增 items 约束 / 删除 property 声明且新契约 additionalProperties===false
//
//   放宽（新契约比旧契约更松）：reader 破坏
//     取消必填 / type 放宽 / enum 新增取值 / enum 约束移除 /
//     additionalProperties 放宽 / 降低或移除下界 / 抬高或移除上界 /
//     移除 pattern / 移除 items 约束 /
//     新增可选 property 且旧契约 additionalProperties===false
//
// 两侧都判不了兼容的（例如 type 一改一增、pattern 换了内容），
// 按「writer 破坏」处理 —— 宁可误报，不许漏报。
//
// ── 边界 ─────────────────────────────────────────────────────────────────
// 这是**纯函数**：给定两份 schema 对象，算出变化集合。不读文件、不触网、
// 不调模型（C3）。文件读取、基线存取都在 CLI 层。
//
// JSON Schema 只覆盖本项目实际用到的子集（type / properties / required /
// enum / items / 数值与字符串边界 / pattern / additionalProperties）。
// 遇到不认识的关键字（如 anyOf）不做猜测，按「未变更」处理。

/** 破坏的方向 */
export type BreakingDirection = 'writer' | 'reader';

/** 契约变化的一条结论 */
export interface SchemaChange {
  /** 变化类别，如 'required_added' / 'enum_narrowed' */
  kind: string;
  /** 变化位置的路径，如 '$.properties.state.enum' */
  path: string;
  /** 破坏方向；非破坏性变化为 null */
  direction: BreakingDirection | null;
  /** 是否破坏性 */
  breaking: boolean;
  /** 给人看的一句话说明（中文） */
  message: string;
}

type Schema = Record<string, unknown>;

/** 把 type 字段统一成字符串数组（`'string'` 与 `['string','null']` 同形） */
function typeList(schema: Schema): string[] {
  const t = schema.type;
  if (typeof t === 'string') return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string');
  return [];
}

/** 从 schema 里取 required 列表 */
function requiredList(schema: Schema): string[] {
  const r = schema.required;
  return Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string') : [];
}

/** 从 schema 里取 properties */
function propertiesOf(schema: Schema): Record<string, Schema> {
  const p = schema.properties;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return {};
  const out: Record<string, Schema> = {};
  for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = v as Schema;
  }
  return out;
}

/** 从 schema 里取 enum 列表（按 JSON 文本比较，保证数字与字符串不混淆） */
function enumList(schema: Schema): string[] {
  const e = schema.enum;
  return Array.isArray(e) ? e.map((x) => JSON.stringify(x)) : [];
}

/** 是否是「不允许额外字段」的封闭契约 */
function isClosed(schema: Schema): boolean {
  return schema.additionalProperties === false;
}

function isArraySchema(schema: Schema): boolean {
  return typeList(schema).includes('array');
}

function num(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

/**
 * 比较「数值下界」。
 *
 * 下界抬高 = 收窄 = writer 破坏；下界降低或移除 = 放宽 = reader 破坏。
 */
function compareLowerBound(
  oldValue: number | null,
  newValue: number | null,
  path: string,
  kindBase: string,
  label: string,
  out: SchemaChange[],
): void {
  if (oldValue === null && newValue !== null) {
    out.push({
      kind: `${kindBase}_added`, path, direction: 'writer', breaking: true,
      message: `新增${label} ${newValue} —— 旧数据可能不满足`,
    });
    return;
  }
  if (oldValue === null || newValue === null) return;
  if (newValue > oldValue) {
    out.push({
      kind: `${kindBase}_raised`, path, direction: 'writer', breaking: true,
      message: `${label}抬高 ${oldValue} → ${newValue} —— 旧数据不再满足`,
    });
  } else if (newValue < oldValue) {
    out.push({
      kind: `${kindBase}_lowered`, path, direction: 'reader', breaking: true,
      message: `${label}放宽 ${oldValue} → ${newValue} —— 新数据旧程序可能不认`,
    });
  }
}

/**
 * 比较「数值上界」。
 *
 * 上界收紧 = 收窄 = writer 破坏；上界抬高或移除 = 放宽 = reader 破坏。
 */
function compareUpperBound(
  oldValue: number | null,
  newValue: number | null,
  path: string,
  kindBase: string,
  label: string,
  out: SchemaChange[],
): void {
  if (oldValue === null && newValue !== null) {
    out.push({
      kind: `${kindBase}_added`, path, direction: 'writer', breaking: true,
      message: `新增${label} ${newValue} —— 旧数据可能不满足`,
    });
    return;
  }
  if (oldValue === null || newValue === null) return;
  if (newValue < oldValue) {
    out.push({
      kind: `${kindBase}_lowered`, path, direction: 'writer', breaking: true,
      message: `${label}收紧 ${oldValue} → ${newValue} —— 旧数据不再满足`,
    });
  } else if (newValue > oldValue) {
    out.push({
      kind: `${kindBase}_raised`, path, direction: 'reader', breaking: true,
      message: `${label}放宽 ${oldValue} → ${newValue} —— 新数据旧程序可能不认`,
    });
  }
}

/**
 * 比较两份对象型 schema 的边界约束。
 *
 * 「收窄」对 writer 破坏（旧数据不合法了），「放宽」对 reader 破坏
 * （新数据旧程序读不懂）。
 */
function compareBounds(oldS: Schema, newS: Schema, path: string, out: SchemaChange[]): void {
  // 数值下界：minimum / minLength 同理
  compareLowerBound(num(oldS.minimum), num(newS.minimum), `${path}.minimum`, 'minimum', '下界', out);
  compareLowerBound(num(oldS.minLength), num(newS.minLength), `${path}.minLength`, 'min_length', '最小长度', out);

  // 数值上界：maximum / maxLength 同理
  compareUpperBound(num(oldS.maximum), num(newS.maximum), `${path}.maximum`, 'maximum', '上界', out);
  compareUpperBound(num(oldS.maxLength), num(newS.maxLength), `${path}.maxLength`, 'max_length', '最大长度', out);

  // 下界移除 = 放宽 = reader 破坏；上界移除同理
  if (num(oldS.minimum) !== null && num(newS.minimum) === null) {
    out.push({
      kind: 'minimum_removed', path: `${path}.minimum`, direction: 'reader', breaking: true,
      message: '移除下界 —— 新数据可能超出旧程序预期',
    });
  }
  if (num(oldS.maximum) !== null && num(newS.maximum) === null) {
    out.push({
      kind: 'maximum_removed', path: `${path}.maximum`, direction: 'reader', breaking: true,
      message: '移除上界 —— 新数据可能超出旧程序预期',
    });
  }
  if (num(oldS.minLength) !== null && num(newS.minLength) === null) {
    out.push({
      kind: 'min_length_removed', path: `${path}.minLength`, direction: 'reader', breaking: true,
      message: '移除最小长度 —— 新数据可能超出旧程序预期',
    });
  }
  if (num(oldS.maxLength) !== null && num(newS.maxLength) === null) {
    out.push({
      kind: 'max_length_removed', path: `${path}.maxLength`, direction: 'reader', breaking: true,
      message: '移除最大长度 —— 新数据可能超出旧程序预期',
    });
  }

  // pattern
  const oldPattern = typeof oldS.pattern === 'string' ? oldS.pattern : null;
  const newPattern = typeof newS.pattern === 'string' ? newS.pattern : null;
  if (oldPattern === null && newPattern !== null) {
    out.push({
      kind: 'pattern_added', path: `${path}.pattern`, direction: 'writer', breaking: true,
      message: `新增 pattern（${newPattern}）—— 旧数据可能不满足`,
    });
  } else if (oldPattern !== null && newPattern === null) {
    out.push({
      kind: 'pattern_removed', path: `${path}.pattern`, direction: 'reader', breaking: true,
      message: '移除 pattern —— 新数据可能超出旧程序预期',
    });
  } else if (oldPattern !== null && newPattern !== null && oldPattern !== newPattern) {
    out.push({
      kind: 'pattern_changed', path: `${path}.pattern`, direction: 'writer', breaking: true,
      message: `pattern 改变（${oldPattern} → ${newPattern}）—— 无法确定新旧兼容`,
    });
  }
}

/**
 * 比较两份 schema，返回变化集合。
 *
 * @param baseline 上一版契约（没有基线时传 null，等价于「全部新增」）
 * @param current  当前契约
 */
export function diffSchemas(baseline: Schema | null, current: Schema): SchemaChange[] {
  return diffAt(baseline, current, '$');
}

/**
 * 比较两份 schema（内部递归入口，带上当前节点路径）。
 */
function diffAt(baseline: Schema | null, current: Schema, path: string): SchemaChange[] {
  const out: SchemaChange[] = [];

  if (!baseline) {
    out.push({
      kind: 'schema_added', path: '$', direction: null, breaking: false,
      message: '新增契约（此前没有基线）',
    });
    return out;
  }

  const oldReq = requiredList(baseline);
  const newReq = requiredList(current);
  const oldProps = propertiesOf(baseline);
  const newProps = propertiesOf(current);

  // ── required 列表 ───────────────────────────────────────────────────
  for (const field of newReq) {
    if (!oldReq.includes(field)) {
      out.push({
        kind: 'required_added', path: `$.required.${field}`, direction: 'writer', breaking: true,
        message: `新增必填字段「${field}」—— 旧数据缺这个字段，不再满足契约`,
      });
    }
  }
  for (const field of oldReq) {
    if (!newReq.includes(field)) {
      out.push({
        kind: 'required_removed', path: `$.required.${field}`, direction: 'reader', breaking: true,
        message: `必填字段「${field}」被取消必填 —— 旧程序仍要求它存在`,
      });
    }
  }

  // ── properties ──────────────────────────────────────────────────────
  for (const [name, oldProp] of Object.entries(oldProps)) {
    if (!(name in newProps)) {
      // 删除 property 声明本身是「放宽」—— 除非新契约封闭（additionalProperties===false），
      // 那时旧数据里多出来的这个字段就不再合法，变成 writer 破坏。
      const nowClosed = isClosed(current);
      out.push({
        kind: 'property_removed',
        path: `$.properties.${name}`,
        direction: nowClosed ? 'writer' : null,
        breaking: nowClosed,
        message: nowClosed
          ? `删除字段「${name}」的 schema —— 新契约禁止额外字段，旧数据带着它不再合法`
          : `删除字段「${name}」的 schema —— 旧数据里带着它（新契约仍允许额外字段，不破坏）`,
      });
      continue;
    }
    out.push(...diffAt(oldProp, newProps[name], `${path}.properties.${name}`));
  }

  for (const name of Object.keys(newProps)) {
    if (!(name in oldProps)) {
      const nowRequired = newReq.includes(name);
      const oldClosed = isClosed(baseline);
      if (nowRequired) {
        out.push({
          kind: 'required_property_added', path: `$.properties.${name}`,
          direction: 'writer', breaking: true,
          message: `新增必填字段「${name}」—— 旧数据缺这个字段`,
        });
      } else if (oldClosed) {
        out.push({
          kind: 'property_added', path: `$.properties.${name}`,
          direction: 'reader', breaking: true,
          message: `新增可选字段「${name}」—— 旧契约禁止额外字段，旧程序读不懂新数据`,
        });
      }
      // 旧契约允许额外字段 + 新字段可选 → 新旧数据互相都合法，不破坏
    }
  }

  // ── type ────────────────────────────────────────────────────────────
  // 收窄 = 新类型集合是旧类型的子集 → 旧数据可能不再是这个类型（writer 破坏）
  // 放宽 = 旧类型集合是新类型的子集 → 新数据旧程序可能不认（reader 破坏）
  const oldTypes = typeList(baseline);
  const newTypes = typeList(current);
  if (oldTypes.length > 0 && newTypes.length > 0) {
    const added = newTypes.filter((t) => !oldTypes.includes(t));
    const removed = oldTypes.filter((t) => !newTypes.includes(t));
    if (removed.length > 0 && added.length === 0) {
      out.push({
        kind: 'type_narrowed', path: `${path}.type`, direction: 'writer', breaking: true,
        message: `type 收窄（${oldTypes.join('|')} → ${newTypes.join('|')}）—— 旧数据可能不再是这个类型`,
      });
    } else if (added.length > 0 && removed.length === 0) {
      out.push({
        kind: 'type_widened', path: `${path}.type`, direction: 'reader', breaking: true,
        message: `type 放宽（${oldTypes.join('|')} → ${newTypes.join('|')}）—— 新数据旧程序可能不认`,
      });
    } else if (added.length > 0 && removed.length > 0) {
      out.push({
        kind: 'type_changed', path: `${path}.type`, direction: 'writer', breaking: true,
        message: `type 改变（${oldTypes.join('|')} → ${newTypes.join('|')}）—— 兼容性无法确定`,
      });
    }
  }

  // ── enum ────────────────────────────────────────────────────────────
  const oldEnum = enumList(baseline);
  const newEnum = enumList(current);
  if (oldEnum.length > 0 && newEnum.length > 0) {
    for (const v of oldEnum.filter((v) => !newEnum.includes(v))) {
      out.push({
        kind: 'enum_value_removed', path: `${path}.enum`, direction: 'writer', breaking: true,
        message: `enum 删除取值 ${v} —— 旧数据可能是这个值`,
      });
    }
    for (const v of newEnum.filter((v) => !oldEnum.includes(v))) {
      out.push({
        kind: 'enum_value_added', path: `${path}.enum`, direction: 'reader', breaking: true,
        message: `enum 新增取值 ${v} —— 旧程序不认识它`,
      });
    }
  } else if (oldEnum.length === 0 && newEnum.length > 0) {
    out.push({
      kind: 'enum_added', path: `${path}.enum`, direction: 'writer', breaking: true,
      message: '新增 enum 约束 —— 旧数据的取值不再都被接受',
    });
  } else if (oldEnum.length > 0 && newEnum.length === 0) {
    out.push({
      kind: 'enum_removed', path: `${path}.enum`, direction: 'reader', breaking: true,
      message: '移除 enum 约束 —— 新数据的取值可能超出旧程序预期',
    });
  }

  // ── additionalProperties ────────────────────────────────────────────
  const oldClosed = isClosed(baseline);
  const newClosed = isClosed(current);
  if (!oldClosed && newClosed) {
    out.push({
      kind: 'additional_properties_closed', path: `${path}.additionalProperties`,
      direction: 'writer', breaking: true,
      message: 'additionalProperties 收紧为 false —— 旧数据里的额外字段不再合法',
    });
  } else if (oldClosed && !newClosed) {
    out.push({
      kind: 'additional_properties_opened', path: `${path}.additionalProperties`,
      direction: 'reader', breaking: true,
      message: 'additionalProperties 放宽 —— 新数据可能带旧程序不认的额外字段',
    });
  }

  // ── 边界约束 ────────────────────────────────────────────────────────
  compareBounds(baseline, current, path, out);

  // ── 递归 ────────────────────────────────────────────────────────────
  if (isArraySchema(baseline) && isArraySchema(current)) {
    const oldItems = baseline.items;
    const newItems = current.items;
    const oldIsObj = oldItems && typeof oldItems === 'object' && !Array.isArray(oldItems);
    const newIsObj = newItems && typeof newItems === 'object' && !Array.isArray(newItems);
    if (oldIsObj && newIsObj) {
      out.push(...diffAt(oldItems as Schema, newItems as Schema, `${path}.items`));
    } else if (!oldItems && newItems) {
      out.push({
        kind: 'items_added', path: `${path}.items`, direction: 'writer', breaking: true,
        message: '新增 items 约束 —— 旧数据的数组元素可能不满足',
      });
    } else if (oldItems && !newItems) {
      out.push({
        kind: 'items_removed', path: `${path}.items`, direction: 'reader', breaking: true,
        message: '删除 items 约束 —— 新数据的数组元素可能超出旧程序预期',
      });
    }
  }

  return out;
}

/** 变化集合里破坏性变化的条数 */
export function countBreaking(changes: SchemaChange[]): number {
  return changes.filter((c) => c.breaking).length;
}

/** 变化集合里是否存在破坏性变化 */
export function hasBreaking(changes: SchemaChange[]): boolean {
  return changes.some((c) => c.breaking);
}

/**
 * 把变化集合渲染成给人看的多行文本（中文）。
 */
export function renderChanges(changes: SchemaChange[]): string {
  if (changes.length === 0) return '  （无变化）';
  const lines: string[] = [];
  for (const c of changes) {
    const mark = c.breaking ? '✗' : '·';
    const dir = c.direction === 'writer' ? '写入方破坏' : c.direction === 'reader' ? '读取方破坏' : '非破坏';
    lines.push(`  ${mark} ${c.path}  [${dir}]  ${c.message}`);
  }
  return lines.join('\n');
}
