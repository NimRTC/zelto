/**
 * section-editor.ts — policy.yaml 的**分段文本编辑**
 *
 * 为什么要单独一套（ADR-068 D-30）：
 *
 * `policy.yaml` 不只有 `rules:` 一段。真实项目（nimrtc-zelto）的结构是：
 *
 * ```yaml
 * rules:
 *   - id: ...
 *
 * # ── 架构护栏（zelto ADR-027）────
 * # 这段注释解释了下面那条 cycle 例外为什么存在
 * arch:
 *   - kind: cycle
 *     action: ask
 *
 * anchors:
 *   policy: "sha256:init"
 * ```
 *
 * **全量反序列化会把这些全弄丢**：
 *   - `arch:` 段（架构护栏的判定依据 —— D-30 的正主）
 *   - `anchors:` 段（已废弃但仍认，ADR-040 §3.3）
 *   - 段之间的**注释块**（人写下的「为什么」）
 *
 * 所以策略编辑必须**只动目标那一段**，其余部分**逐字节保留**。
 *
 * 这不是「更精致的实现」，是「不毁数据」的基本要求 ——
 * 注释里写着的是人的设计决策，工具没有资格替人删掉。
 *
 * C3: 纯字符串处理，不调模型、不触网。
 * C6: core/ 内，不依赖 adapters/。
 */

/** 一段的标题（如 `rules`、`arch`） */
export type SectionName = string;

/** 段内一条目的行范围（0 基，左闭右开） */
export interface EntryRange {
  /** 条目的标识（`- id: x` 里的 x，或 `- kind: y` 里的 y） */
  id: string;
  /** 条目起始行（含 `- id:` 那一行） */
  start: number;
  /** 条目结束行（不含） */
  end: number;
}

/**
 * 这一行是不是某段的标题行。
 *
 * 判定：「去掉 BOM 后的整行 == 标题」。
 *
 * 为什么不直接用 `line.trim() === header`（ADR-068 D-31）：
 * 那会把**缩进过的 `rules:`** 也当成顶层段标题 —— 它其实是上一段某条目里的
 * 一个键（`match:` 块下面不该有 `rules:`，但现实里什么都有）。
 *
 * 为什么不沿用「trim 后相等 **且** 长度相等」（原实现）：
 * 长度相等这个判据会被 BOM 打穿：
 *
 * ```yaml
 * \uFEFFrules:
 *   - id: x
 * ```
 *
 * JS 的 `trim()` 会把 BOM（U+FEFF）当空白去掉（它属于 WhiteSpace），
 * 所以 `trim() === 'rules:'` 成立；但 `lines[i].length` 比标题多 1 →
 * 长度判据不成立 → **整段找不到**。
 *
 * 后果是「静默失败」：`policy edit` / `policy remove` / `policy arch *`
 * 全部找不到 `rules:` / `arch:` 段，命令却报告成功 —— 人以为改完了，
 * 文件一个字节没变。这正是 D-30 那类缺陷的同一族：
 * **工具报告成功、实际什么都没做**。
 *
 * BOM 在 Windows 上很常见（PowerShell 5.1 的 `Set-Content -Encoding UTF8`、
 * 记事本、部分编辑器）。仓库里已有同类处理（core/design/store.ts、
 * core/version/branch.ts 都是 `replace(/^\uFEFF/, '')`）。
 *
 * 行尾空白容错：YAML 允许 `rules:   `，原实现（长度相等）会漏掉它，
 * 这里一并放过。
 */
function isSectionHeaderLine(line: string, header: string): boolean {
  const stripped = line.replace(/^\uFEFF/, '').replace(/\s+$/, '');
  return stripped === header;
}

/**
 * 某一段在 YAML 里存不存在。
 *
 * 存在的意义不是「查询」——是**让编辑路径能区分两件事**：
 *
 *   - 段真的不在 → 这是「新增」场景，追加即可
 *   - 段在但**没找到** → 这不正常，命令必须报错而不是报告成功
 *
 * D-31 的教训：段找不到时，`removeSectionEntry` / `updateSectionEntryFields`
 * 会**原样返回**（`if (!entry) return yaml`）—— 文件没变，但调用方
 * 照样返回 `success: true`。人看到「✓ Rule removed」，
 * 实际上文件一个字节没动。
 *
 * 所以编辑路径必须**先确认段在**，再动手。
 */
export function hasSection(yaml: string, section: SectionName): boolean {
  return findSection(yaml, section) !== null;
}

/**
 * 找出某一段在 YAML 里的起止行号（0 基，左闭右开）。
 *
 * @returns `{ start, end }`：`start` 是 `rules:` 那一行本身，
 *          `end` 是这一段的正文结束位置（下一段标题行，或紧贴它的注释块起点）。
 *          段不存在时返回 null。
 */
export function findSection(yaml: string, section: SectionName): { start: number; end: number } | null {
  const lines = yaml.split('\n');
  const header = `${section}:`;

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isSectionHeaderLine(lines[i], header)) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  // 找下一个顶层键（顶格、非空、非注释的行）
  let nextKey = -1;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) continue;
    if (line[0] === ' ' || line[0] === '\t') continue;
    if (line.trimStart().startsWith('#')) continue;
    nextKey = i;
    break;
  }

  if (nextKey === -1) {
    // 没有下一段 → 这一段到文件末尾
    return { start, end: lines.length };
  }

  // **向后回退**：紧贴下一个顶层键之前的注释块属于**下一段**，
  // 不属于本段（真实项目里 `arch:` 上面就有一段解释性注释）。
  let end = nextKey;
  while (end > start + 1) {
    const prev = lines[end - 1];
    const isBlank = prev.length === 0;
    const isComment = prev.trimStart().startsWith('#');
    if (!isBlank && !isComment) break;
    end -= 1;
  }

  return { start, end };
}

/**
 * 列出某一段里的所有条目。
 *
 * @param yaml - YAML 全文
 * @param section - 段名
 * @param keyName - 条目标识的键名（`rules:` 段是 `id`，`arch:` 段是 `kind`）
 */
export function listSectionEntries(
  yaml: string,
  section: SectionName,
  keyName: string,
): EntryRange[] {
  const lines = yaml.split('\n');
  const range = findSection(yaml, section);
  if (!range) return [];

  const entries: EntryRange[] = [];
  const prefix = `- ${keyName}:`;

  for (let i = range.start + 1; i < range.end; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith(prefix)) continue;

    const id = unquote(trimmed.slice(prefix.length).trim());

    // 条目结束于：下一个 `- key:` 行，或本段末尾
    let end = range.end;
    for (let j = i + 1; j < range.end; j++) {
      if (lines[j].trim().startsWith(prefix)) {
        end = j;
        break;
      }
    }

    // **条目不吞掉尾部的空行**（ADR-082）。
    //
    // 段在文件末尾时，`range.end` = `lines.length`，
    // 而 `split('\n')` 会在文件末尾的换行符之后多出一个空串。
    // 不裁掉的话，`replaceSectionEntry` 把条目块换回去时
    // 会把那个空串**一起吃掉** —— 文件末尾的换行没了，
    // 于是「内容其实没变」也会被判定成「变了」。
    //
    // 这是 D-31 / ADR-082 那族「静默失败」的变种：
    // 工具报告成功，文件却被悄悄改了一个字节。
    while (end > i + 1 && lines[end - 1].trim() === '') {
      end -= 1;
    }

    entries.push({ id, start: i, end });
    i = end - 1;
  }

  return entries;
}

/**
 * 找出某一段里指定标识的条目。
 */
export function findSectionEntry(
  yaml: string,
  section: SectionName,
  keyName: string,
  id: string,
): EntryRange | null {
  return listSectionEntries(yaml, section, keyName).find((e) => e.id === id) ?? null;
}

/**
 * 替换某一段的正文，**其余部分逐字节保留**。
 *
 * @param yaml - 原 YAML 全文
 * @param section - 段名（如 `arch`）
 * @param body - 新的正文行（**不含** `section:` 那一行）
 * @returns 新的 YAML 全文；段不存在时原样返回
 */
export function replaceSectionBody(
  yaml: string,
  section: SectionName,
  body: string[],
): string {
  const lines = yaml.split('\n');
  const range = findSection(yaml, section);
  if (!range) return yaml;

  const replacement = [...body];
  // 段正文与下一段之间要有一个空行（否则 YAML 会把它们粘在一起）
  if (replacement.length > 0 && replacement[replacement.length - 1].trim() !== '') {
    replacement.push('');
  }

  const next = [...lines.slice(0, range.start + 1), ...replacement, ...lines.slice(range.end)];
  return next.join('\n');
}

/**
 * 追加到某一段的正文末尾（段不存在时创建它）。
 *
 * @param yaml - 原 YAML 全文
 * @param section - 段名
 * @param body - 要追加的行
 * @returns 新的 YAML 全文
 */
export function appendToSection(
  yaml: string,
  section: SectionName,
  body: string[],
): string {
  const range = findSection(yaml, section);
  if (!range) {
    // 段不存在 → 在文件末尾创建
    const lines = yaml.split('\n');
    // 去掉末尾的空行
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push('', `${section}:`);
    for (const line of body) lines.push(line);
    lines.push('');
    return lines.join('\n');
  }

  // 段存在 → 插到正文末尾（段末尾的注释块要留在原位）
  const lines = yaml.split('\n');
  const bodyEnd = range.end;
  const insertion = body.length > 0 && body[body.length - 1].trim() !== '' ? [...body, ''] : body;

  const next = [...lines.slice(0, bodyEnd), ...insertion, ...lines.slice(bodyEnd)];
  return next.join('\n');
}

/**
 * 某一段的正文行（不含 `section:` 那一行）。
 */
export function readSectionBody(yaml: string, section: SectionName): string[] {
  const range = findSection(yaml, section);
  if (!range) return [];
  const lines = yaml.split('\n');
  return lines.slice(range.start + 1, range.end);
}

/**
 * 删掉某一段里的一个条目（连同它的正文行）。
 *
 * **只删那一块** —— 同段的其他条目、注释、别的段一律保留。
 */
export function removeSectionEntry(
  yaml: string,
  section: SectionName,
  keyName: string,
  id: string,
): string {
  const entry = findSectionEntry(yaml, section, keyName, id);
  if (!entry) return yaml;

  const lines = yaml.split('\n');
  const next = [...lines.slice(0, entry.start), ...lines.slice(entry.end)];
  return next.join('\n');
}

/**
 * 替换某一段里的一个条目（保留它自己的位置与其它内容）。
 *
 * @param block - 新条目的行（第一行应是 `- <key>: <id>`）
 */
export function replaceSectionEntry(
  yaml: string,
  section: SectionName,
  keyName: string,
  id: string,
  block: string[],
): string {
  const entry = findSectionEntry(yaml, section, keyName, id);
  if (!entry) return yaml;

  const lines = yaml.split('\n');
  const next = [...lines.slice(0, entry.start), ...block, ...lines.slice(entry.end)];
  return next.join('\n');
}

/**
 * **字段级**修改某一段里的一个条目。
 *
 * 只改指定的字段行，条目里的**其它字段原样保留** ——
 * 包括解析器不认识的字段（比如真实项目里的 `reason:`）。
 *
 * 为什么不能整条重建（ADR-068 D-30 的延伸）：
 * `parsePolicyYaml` 只认 `id` / `match` / `action` / `basis` / `guidance` /
 * `priority`。真实项目的 policy.yaml 里还有 `reason:` 这种字段 ——
 * 整条重建会把它**悄悄丢掉**。
 * 「工具没有资格替人删掉它不认识的字段。」
 *
 * @param fields - 要改的字段（`key` → 新的值；`null` 表示删掉该字段）
 * @param matchFields - `match:` 里的字段（`path` / `operation`）
 */
export function updateSectionEntryFields(
  yaml: string,
  section: SectionName,
  keyName: string,
  id: string,
  fields: Record<string, string | null>,
  matchFields: Record<string, string | null> = {},
): string {
  const entry = findSectionEntry(yaml, section, keyName, id);
  if (!entry) return yaml;

  const lines = yaml.split('\n');
  const block = lines.slice(entry.start, entry.end);
  const updated = applyFieldEdits(block, fields, matchFields);

  const next = [...lines.slice(0, entry.start), ...updated, ...lines.slice(entry.end)];
  return next.join('\n');
}

/**
 * 在一个条目块里做字段级修改。
 *
 * 处理两种 `match:` 写法：
 *   - 行内：`match: { path: "src/**", operation: "write" }`
 *   - 分行：`match:` 下面缩进写 `path:` / `operation:`
 *
 * 行内写法里只替换指定的键，其余键**保留**。
 */
export function applyFieldEdits(
  block: string[],
  fields: Record<string, string | null>,
  matchFields: Record<string, string | null> = {},
): string[] {
  const result: string[] = [];
  const hasMatchFields = Object.keys(matchFields).length > 0;

  for (let i = 0; i < block.length; i++) {
    const line = block[i];
    const trimmed = line.trim();

    // ── 行内 match ──────────────────────────────────────────────
    if (hasMatchFields && trimmed.startsWith('match:') && trimmed.includes('{')) {
      const inline = parseInlineMatchBody(trimmed.slice(6));
      for (const [k, v] of Object.entries(matchFields)) {
        if (v === null) delete inline[k];
        else inline[k] = v;
      }
      const parts = Object.entries(inline).map(([k, v]) => `${k}: "${escapeYamlString(v)}"`);
      result.push(`${line.slice(0, line.length - line.trimStart().length)}match: { ${parts.join(', ')} }`);
      continue;
    }

    // ── 分行 match：找到 `match:` 之后的缩进字段行 ────────────────
    if (hasMatchFields && trimmed === 'match:') {
      result.push(line);
      // 消费后续属于 match 的缩进字段行
      while (i + 1 < block.length) {
        const nextLine = block[i + 1];
        const nextTrimmed = nextLine.trim();
        const isIndented = nextLine.length > 0 && (nextLine[0] === ' ' || nextLine[0] === '\t');
        if (!isIndented || nextTrimmed === '' || nextTrimmed.startsWith('#')) break;

        const m = nextTrimmed.match(/^([A-Za-z_][\w-]*):/);
        if (!m) break;
        const fieldKey = m[1];
        if (!(fieldKey in matchFields)) {
          result.push(nextLine);
          i++;
          continue;
        }
        const newValue = matchFields[fieldKey];
        if (newValue === null) {
          i++; // 删掉这一行
          continue;
        }
        result.push(`${nextLine.slice(0, nextLine.length - nextTrimmed.length)}${fieldKey}: "${escapeYamlString(newValue)}"`);
        i++;
      }
      continue;
    }

    // ── 普通字段 ────────────────────────────────────────────────
    const m = trimmed.match(/^([A-Za-z_][\w-]*):/);
    if (m && m[1] in fields) {
      const fieldKey = m[1];
      const newValue = fields[fieldKey];
      if (newValue === null) {
        continue; // 删掉这一行
      }
      const indent = line.slice(0, line.length - line.trimStart().length);
      result.push(`${indent}${fieldKey}: ${needsQuotes(newValue) ? `"${escapeYamlString(newValue)}"` : newValue}`);
      continue;
    }

    result.push(line);
  }

  // ── 新增字段（原本没有的）────────────────────────────────────
  for (const [k, v] of Object.entries(fields)) {
    if (v === null) continue;
    if (result.some((l) => l.trim().startsWith(`${k}:`))) continue;
    result.push(`    ${k}: ${needsQuotes(v) ? `"${escapeYamlString(v)}"` : v}`);
  }

  return result;
}

/** 解析行内 `match: { k: "v", k2: "v2" }` 的内容部分 */
function parseInlineMatchBody(body: string): Record<string, string> {
  const result: Record<string, string> = {};
  const inner = body.trim().replace(/^\{/, '').replace(/\}$/, '').trim();
  if (!inner) return result;

  for (const part of inner.split(',')) {
    const idx = part.indexOf(':');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    let value = part.slice(idx + 1).trim();
    if (value.length >= 2 && ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

/** 这个值要不要加引号 */
function needsQuotes(value: string): boolean {
  if (value === '') return true;
  if (/^-?\d+(\.\d+)?$/.test(value)) return false;
  if (value === 'true' || value === 'false' || value === 'null') return false;
  return !/^[A-Za-z_][\w.-]*$/.test(value);
}

/** 转义 YAML 双引号字符串里的引号与反斜杠 */
function escapeYamlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** 去掉一层引号 */
function unquote(value: string): string {
  if (value.length >= 2 && ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}
