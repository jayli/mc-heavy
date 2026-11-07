// tools/molang-eval.mjs — Molang 子集求值器（v2.55 焰魔烘焙期用）
//
// **为什么在 `tools/` 而不是 `src/`**：只在**烘焙期**用（node 侧），运行期不消费表达式
// （运行时读的是烘焙好的帧序列）。放 tools/ 与 `bake-*.mjs` 同居，符合本仓
// 「node 侧模块不进 src/」的口径（同 `dragon-fingerprint.mjs` 的注释）。
//
// ⚠️ 但测试（`src/tests/test-molang.js`）要 import 它 —— 浏览器单测能直接 import
// `../../tools/*.mjs`（`src/tests/` 已被 dev server 服务），与 `test-dragon-bake.js`
// 读产物同口径。本文件**不依赖 node:fs / node:path**，所以浏览器能解析。
//
// ## 为什么需要它（spec `2026-11-05-ignis-boss-design.md` §4.1）
//
// 焰魔素材的**待机动画**（`generala` / `generalb`）不是数值关键帧，而是 Molang 表达式：
//
//     left_arm.rotation.z  = "Math.sin(q.life_time * 128) * -2.5"
//     left_hand.rotation.z = "2.5 + Math.sin(q.life_time * 128) * 2.5"
//     root.position.y      = "Math.sin(q.life_time * 128 + (-96)) * 0.75"
//     root.rotation.y      = "q.target_y_rotation"
//     head.rotation.x      = "q.target_x_rotation"
//
// 飞龙的烘焙器只吃数值关键帧，所以这里实现一个够用的子集。
//
// ## 两条载荷性约定
//
// 1. **只支持素材里实际出现的标识符**：`q.life_time`、`q.target_y_rotation`、
//    `q.target_x_rotation`、`Math.sin`。**未知标识符一律抛 `MolangError`，不静默回 0。**
//    静默回 0 的形态是「巨兽站着不动」—— 格数、指纹、单测全绿，只有实玩能发现。
//    抛错则会在烘焙与 `check:data` 里当场红。
//
// 2. **`Math.cos` 刻意不支持**：素材只用了 `sin`。加上 `cos` 会让「素材悄悄换了函数」
//    不被发现（两者在 t=0 附近数值接近，肉眼与断言都可能放过）。真要用时
//    `MolangError` 会明确指出是哪条表达式 —— 那时再加，成本一分钟。
//
// ## 为什么是递归下降
//
// 表达式文法只有三层（加减 → 乘除 → 一元/原子），嵌套深度实际不超过 3。
// 递归下降比正则替换安全（正则版会被 `(-96)` 这类嵌套负号骗过），
// 也比引入完整解析器库轻（本仓 devDependency 只有 3 个）。
//
// 设计文档 `docs/superpowers/specs/2026-11-05-ignis-boss-design.md` §4.1。

/** Molang 子集求值失败（不支持的标识符 / 语法错误 / 非字符串输入） */
export class MolangError extends Error {
  /**
   * @param {string} message 具体原因
   * @param {string} source 原表达式（**必须带**，否则烘焙时看不出是哪条）
   */
  constructor(message, source) {
    super(`[Molang] ${message} — 表达式: ${JSON.stringify(source)}`);
    this.name = 'MolangError';
    this.source = source;
  }
}

/**
 * 支持的查询标识符 → scope 字段名。
 *
 * ⚠️ **加新标识符时只改这张表**（红线 1：支持的集合只有一份权威）。
 * 改这里必须同步 `bake-ignis.mjs` 的 scope 构造。
 */
const QUERY_FIELDS = Object.freeze({
  'q.life_time': 'lifeTime',
  'q.target_y_rotation': 'targetYaw',
  'q.target_x_rotation': 'targetPitch',
});

/** 支持的 `Math.*` 函数 */
/**
 * 支持的 `Math.*` 函数。
 *
 * ⚠️⚠️ **三角函数的参数是「度」不是「弧度」** —— 这是 Bedrock Molang 的口径，
 * 不是 JS `Math.sin` 的口径。2026-11-05 实测踩到这个坑：素材的待机动画写的是
 * `Math.sin(q.life_time * 128) * -2.5`，原意是 **128°/秒**（周期 360/128 = 2.81 秒的缓慢
 * 呼吸），按弧度求值就变成 **128 rad/秒 = 20.4 Hz** 的剧烈抖动 —— 用户实玩报告
 * 「焰魔移动的过程中，身体是抖动的」。
 *
 * 权威：Microsoft Molang 文档与 bedrock.dev 的 Math Functions 表都明写
 * 「math.cos(value) — Cosine (in degrees) of value」。
 *
 * 修复方式：入参先乘 π/180 再交给 JS 的 Math.*。
 */
const DEG_TO_RAD = Math.PI / 180;
const MATH_FNS = Object.freeze({
  sin: (deg) => Math.sin(deg * DEG_TO_RAD),
  cos: (deg) => Math.cos(deg * DEG_TO_RAD),
});

/** 词法单元类型 */
const T_NUM = 'num';
const T_IDENT = 'ident';
const T_OP = 'op';
const T_LPAREN = '(';
const T_RPAREN = ')';
const T_EOF = 'eof';

/**
 * 词法分析。
 *
 * ⚠️ **标识符按「含点号的整段」切**：`q.life_time` 必须是一个 token，
 * 切成 `q` / `.` / `life_time` 会让「未知字段」的错误消息失去上下文。
 *
 * @param {string} src
 * @returns {Array<{type: string, value: *, pos: number}>}
 */
function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    // 空白
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
    if (ch === T_LPAREN || ch === T_RPAREN) {
      out.push({ type: ch, value: ch, pos: i }); i++; continue;
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      out.push({ type: T_OP, value: ch, pos: i }); i++; continue;
    }
    // 数字（含小数与科学计数；负号由一元运算符处理，不是数字的一部分）
    if ((ch >= '0' && ch <= '9') || (ch === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const start = i;
      while (i < src.length && /[0-9]/.test(src[i])) i++;
      if (src[i] === '.') { i++; while (i < src.length && /[0-9]/.test(src[i])) i++; }
      if (src[i] === 'e' || src[i] === 'E') {
        const save = i;
        i++;
        if (src[i] === '+' || src[i] === '-') i++;
        if (/[0-9]/.test(src[i] || '')) { while (i < src.length && /[0-9]/.test(src[i])) i++; }
        else i = save;   // 'e' 后面不是数字 ⇒ 不是科学计数，回退
      }
      const text = src.slice(start, i);
      const value = Number(text);
      if (!Number.isFinite(value)) throw new MolangError(`数字字面量无法解析：${text}`, src);
      out.push({ type: T_NUM, value, pos: start });
      continue;
    }
    // 标识符：字母/下划线开头，后续可含字母、数字、下划线、点号
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < src.length && /[A-Za-z0-9_.]/.test(src[i])) i++;
      out.push({ type: T_IDENT, value: src.slice(start, i), pos: start });
      continue;
    }
    throw new MolangError(`无法识别的字符 ${JSON.stringify(ch)}（位置 ${i}）`, src);
  }
  out.push({ type: T_EOF, value: null, pos: src.length });
  return out;
}

/**
 * 把一条 Molang 表达式编译成 `(scope) => number`。
 *
 * @param {string} expr 表达式原文
 * @returns {(scope: {lifeTime?: number, targetYaw?: number, targetPitch?: number}) => number}
 * @throws {MolangError} 非字符串 / 语法错误 / 不支持的标识符或函数
 */
export function compileMolang(expr) {
  if (typeof expr !== 'string') {
    throw new MolangError(`表达式必须是字符串，收到 ${typeof expr}`, String(expr));
  }
  const tokens = tokenize(expr);
  if (tokens.length === 1) throw new MolangError('表达式为空', expr);

  let cur = 0;
  /** 读当前 token（不前进） */
  const peek = () => tokens[cur];
  /** 吃掉当前 token 并返回它 */
  const eat = () => tokens[cur++];
  /** 当前 token 必须是期望的类型，否则抛错 */
  const expect = (type, what) => {
    const t = peek();
    if (t.type !== type) {
      throw new MolangError(`期望 ${what}，实际是 ${t.type === T_EOF ? '表达式结束' : JSON.stringify(t.value)}`, expr);
    }
    return eat();
  };

  // 文法（优先级从低到高）：
  //   expr   := term (('+' | '-') term)*
  //   term   := unary (('*' | '/') unary)*
  //   unary  := '-' unary | primary
  //   primary:= number | ident ['(' expr ')'] | '(' expr ')'

  /** @returns {(scope: object) => number} */
  function parseExpr() {
    let left = parseTerm();
    for (;;) {
      const t = peek();
      if (t.type !== T_OP || (t.value !== '+' && t.value !== '-')) break;
      eat();
      const right = parseTerm();
      const l = left;
      const op = t.value;
      // 闭包捕获：不能用 `left` 直接累加（会让闭包共享可变状态）
      left = op === '+' ? (s) => l(s) + right(s) : (s) => l(s) - right(s);
    }
    return left;
  }

  function parseTerm() {
    let left = parseUnary();
    for (;;) {
      const t = peek();
      if (t.type !== T_OP || (t.value !== '*' && t.value !== '/')) break;
      eat();
      const right = parseUnary();
      const l = left;
      const op = t.value;
      left = op === '*' ? (s) => l(s) * right(s) : (s) => l(s) / right(s);
    }
    return left;
  }

  function parseUnary() {
    const t = peek();
    if (t.type === T_OP && t.value === '-') {
      eat();
      const inner = parseUnary();
      return (s) => -inner(s);
    }
    if (t.type === T_OP && t.value === '+') {
      // 一元正号：Molang 里合法但不常见，容忍
      eat();
      return parseUnary();
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const t = peek();
    if (t.type === T_NUM) {
      eat();
      const v = t.value;
      return () => v;
    }
    if (t.type === T_LPAREN) {
      eat();
      const inner = parseExpr();
      expect(T_RPAREN, '右括号');
      return inner;
    }
    if (t.type === T_IDENT) {
      eat();
      const name = t.value;
      // Math.xxx(...) —— 只支持 MATH_FNS 里的
      if (name.startsWith('Math.')) {
        const fnName = name.slice('Math.'.length);
        const fn = MATH_FNS[fnName];
        if (!fn) {
          throw new MolangError(
            `不支持的函数 ${name}（只支持 ${Object.keys(MATH_FNS).map((k) => 'Math.' + k).join(', ')}）`,
            expr,
          );
        }
        expect(T_LPAREN, `${name} 的左括号`);
        const arg = parseExpr();
        expect(T_RPAREN, `${name} 的右括号`);
        return (s) => fn(arg(s));
      }
      // q.xxx —— 只支持 QUERY_FIELDS 里的（缺省 0）
      const field = QUERY_FIELDS[name];
      if (field === undefined) {
        throw new MolangError(
          `不支持的标识符 ${name}（只支持 ${Object.keys(QUERY_FIELDS).join(', ')}）`,
          expr,
        );
      }
      return (s) => {
        const v = s == null ? undefined : s[field];
        return Number.isFinite(v) ? v : 0;
      };
    }
    throw new MolangError(
      `无法解析的记号 ${t.type === T_EOF ? '表达式结束' : JSON.stringify(t.value)}`,
      expr,
    );
  }

  const fn = parseExpr();
  // 必须吃到结尾：多余的 token（如 `1 2`、`1)`）是语法错误
  if (peek().type !== T_EOF) {
    const t = peek();
    throw new MolangError(`表达式末尾有多余内容 ${JSON.stringify(t.value)}`, expr);
  }
  return fn;
}
