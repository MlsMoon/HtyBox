// SVG 预览清洗管线：把损坏 SVG 的常见 XML 语法瑕疵规范化，让严格 XML 解析器（DOMParser）能通过、
// 从而经 <img> 完整渲染。仅作用于【喂给渲染器的临时副本】，不改编辑缓冲与保存内容
// （层级纪律见 memory feedback-preview-render-tolerance）。新增一类坏法 = 往 SANITIZERS 加一项，
// 不动调用点——终结「每来一种坏法就补一个 if」的模式。

export type Sanitizer = { name: string; apply: (s: string) => string };

// 孤立 &（后面不接合法实体）转义为 &amp;。AI 生成 / 手写 mockup 常在中文文案里裸写 " & "。
const escapeBareAmp: Sanitizer = {
  name: "escape-bare-amp",
  apply: (s) => s.replace(/&(?![a-zA-Z][a-zA-Z0-9]*;|#[0-9]+;|#x[0-9a-fA-F]+;)/g, "&amp;"),
};

// 剥离注释。XML 1.0 §2.5 禁止注释内出现 "--"（如连字符画的分隔线 <!----- x ----->），严格解析器
// 报 "Double hyphen within comment"。注释不参与渲染 → 整体剥除零视觉损失，一次覆盖注释内 --/
// 未闭合/---> 收尾等所有注释类瑕疵。
const stripComments: Sanitizer = {
  name: "strip-comments",
  apply: (s) => {
    const out = s.replace(/<!--[\s\S]*?-->/g, ""); // 成对注释（非贪婪，取第一个 -->）
    const open = out.indexOf("<!--"); // 剩下的 <!-- 必无 -->（否则已被上面匹配）→ 未闭合
    return open === -1 ? out : out.slice(0, open); // 未闭合注释：删到文件尾（尽力渲染最后一跳）
  },
};

// 剥离 XML 1.0 非法字符：除 \t\n\r 外的 C0 控制字符 + DEL。后端 replace_invalid_text_chars 仅在坏字节
// 路径清洗；合法 UTF-8 里混入的这类控制字符会漏到此处，残留一个就让整份 SVG 报 parsererror。渲染层
// 兜底清洗、不改保存（决策 3）。U+FFFE/FFFF 等 noncharacter 极罕见，交后端坏字节路径兜底，此处聚焦 C0。
const stripControlChars: Sanitizer = {
  name: "strip-control-chars",
  apply: (s) => s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ""),
};

// 有序：先文本实体（&）→ 再结构（注释）→ 再字符（控制符）。顺序固定、显式管控累加结果。
export const SANITIZERS: Sanitizer[] = [escapeBareAmp, stripComments, stripControlChars];

// 累加清洗：逐个叠加 sanitizer（跳过无改动项），每步后用注入的 isWellFormed 复验，第一个良构即返回。
// isWellFormed 由调用方注入（生产传 DOMParser 版，单测可注入 mock）；返回 cleaned 标识是否动过内容、
// wellFormed 标识最终是否良构（false = 交调用方决定乐观兜底渲染，见决策 1）。
export function sanitizeForRender(
  content: string,
  isWellFormed: (s: string) => boolean,
): { text: string; cleaned: boolean; wellFormed: boolean } {
  if (isWellFormed(content)) return { text: content, cleaned: false, wellFormed: true };
  let text = content;
  let cleaned = false;
  for (const s of SANITIZERS) {
    const next = s.apply(text);
    if (next === text) continue; // 该清洗器无改动 → 跳过，省一次解析
    text = next;
    cleaned = true;
    if (isWellFormed(text)) return { text, cleaned, wellFormed: true };
  }
  return { text, cleaned, wellFormed: false };
}
