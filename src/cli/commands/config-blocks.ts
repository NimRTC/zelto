// YAML 块标量（block scalar）解析 —— 只服务于 `.zelto/config.yaml`
//
// ── 为什么需要它 ────────────────────────────────────────────────────────
// `.zelto/config.yaml` 是 YAML。人写多行门禁命令时，YAML 的惯用写法是折叠标量：
//
//   - name: configure
//     run: >
//       cmake -S . -B build -G "Visual Studio 17 2022" -A x64
//       -DNIMRTC_BUILD_TESTS=ON
//
// 之前的解析器只认单行的 `run: <一行>`。于是 `run: >` 被读成字面量 ">" ——
// 门禁拿到的命令就是 ">"，执行必然失败，而报错完全指不到真正的原因：
//
//   configure  exit 1  stderr: 命令语法不正确
//
// 人看到「cmake 配置失败」，实际上是**配置解析把整条命令吞掉了**。
// 真实案例：nimrtc-zelto（CMake 大工程）上实测，ADR-040 修好了策略侧，
// 门禁却仍然红 —— 红的原因不在策略，在配置解析。
//
// ── 两种标量 ────────────────────────────────────────────────────────────
// `>` 折叠（folded）：换行折成空格，单行内的多行命令连成一条 —— shell 命令用这个。
// `|` 字面（literal）：换行保留 —— 多行文本（如说明性字段）用这个。
//
// ── 边界 ────────────────────────────────────────────────────────────────
// 只处理块标量本身，不做完整 YAML 解析：块内的 `#` 不是注释（YAML 语义如此），
// 一律按内容保留；块内空行保留（折叠时折成换行）。
//
// 结果统一去掉末尾空白 —— 配置里的值是「一条命令 / 一段文本」，
// 末尾换行没有意义，留着反而会让门禁比较命令时对不上。

/** 块标量的风格 */
export type BlockScalarStyle = 'folded' | 'literal';

/** chomping（末尾换行处理） */
export type BlockScalarChomp = 'strip' | 'keep' | 'clip';

/** 块标量的头部信息 */
export interface BlockScalarHeader {
  style: BlockScalarStyle;
  chomp: BlockScalarChomp;
}

/**
 * 判断一个值是不是块标量的头。
 *
 * 认 `>`、`|`、`>-`、`|+`、`>-`、`|-` 这几种写法。
 * 其它值（普通单行、含引号的字符串）返回 null。
 */
export function parseBlockScalarHeader(raw: string): BlockScalarHeader | null {
  const m = raw.trim().match(/^([>|])([+-]?)$/);
  if (!m) return null;
  const style: BlockScalarStyle = m[1] === '>' ? 'folded' : 'literal';
  const chomp: BlockScalarChomp = m[2] === '-' ? 'strip' : m[2] === '+' ? 'keep' : 'clip';
  return { style, chomp };
}

/** 读出来的块标量 */
export interface BlockScalarValue {
  /** 拼好的值（末尾空白已去掉） */
  value: string;
  /** 块之后的下一行下标 —— 调用方要把游标推进到这里 */
  nextIndex: number;
}

/**
 * 读出一个块标量的内容。
 *
 * 块的边界按 YAML 规则定：内容行的缩进必须**深于**所属键的缩进；
 * 遇到第一个缩进不够的非空行就结束。空行算块内内容（折叠时折成换行）。
 *
 * @param lines        全部行
 * @param headerIndex  块标量头所在行（`run: >` 那一行）
 * @param parentIndent 所属键的缩进（块内容必须比它深）
 * @param header       块标量的风格与 chomping
 */
export function readBlockScalar(
  lines: string[],
  headerIndex: number,
  parentIndent: number,
  header: BlockScalarHeader,
): BlockScalarValue | null {
  // 第一遍：确定块的基准缩进（第一行非空内容的缩进）与块的结束位置。
  let blockIndent = -1;
  let end = headerIndex;
  for (let j = headerIndex + 1; j < lines.length; j++) {
    const raw = lines[j];
    if (raw.trim() === '') continue; // 空行：可能属于块，也可能是块后的分隔
    const indent = raw.length - raw.trimStart().length;
    if (indent <= parentIndent) break;
    if (blockIndent < 0) blockIndent = indent;
    end = j;
  }

  // 第二遍：按基准缩进去掉公共前缀，收集内容行。
  const content: string[] = [];
  for (let j = headerIndex + 1; j <= end; j++) {
    const raw = lines[j];
    content.push(raw.trim() === '' ? '' : raw.slice(blockIndent < 0 ? raw.length : blockIndent));
  }

  // 末尾的空行属于 chomping 的管辖范围，先摘掉。
  while (content.length > 0 && content[content.length - 1] === '') content.pop();

  let value: string;
  if (header.style === 'literal') {
    value = content.join('\n');
  } else {
    // 折叠：连续的非空行折成空格；空行折成换行。
    value = '';
    let breaks = 0;
    for (const line of content) {
      if (line.trim() === '') {
        breaks++;
        continue;
      }
      if (value === '') {
        value = line;
      } else if (breaks > 0) {
        value += '\n'.repeat(breaks) + line;
      } else {
        value += ' ' + line;
      }
      breaks = 0;
    }
    if (value !== '' && breaks > 0) value += '\n'.repeat(breaks);
  }

  // 统一去末尾空白：配置里的值是「一条命令 / 一段文本」，
  // 末尾换行没有意义，留着会让门禁比对命令时对不上。
  value = value.trimEnd();

  return { value, nextIndex: end + 1 };
}
