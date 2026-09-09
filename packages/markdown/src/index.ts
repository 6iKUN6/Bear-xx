import MarkdownIt, {
  type MarkdownItInstance,
  type MarkdownItStateBlock,
  type MarkdownItStateInline,
} from "markdown-it";
import { renderToString } from "katex";

/**
 * 跨端共享的 Markdown 渲染管线
 * @description 输出内联样式的 HTML 字符串：小程序端交给 RichText 渲染
 * （rich-text 节点只认内联样式，外部 CSS 到不了），web 端用
 * `dangerouslySetInnerHTML` 消费同一产物。一套管线，两端薄壳。
 */

const paragraphStyle = "margin:0 0 8px;line-height:1.72;";
const headingStyle =
  "margin:12px 0 8px;font-weight:700;line-height:1.35;color:inherit;";
const listStyle = "margin:6px 0 8px 18px;padding:0;line-height:1.65;";
const listItemStyle = "margin:3px 0;";
const blockquoteStyle =
  "margin:8px 0;padding:8px 10px;border:1px solid var(--lb-line-soft);border-radius:var(--lb-radius-md);background:var(--lb-surface-muted);color:var(--lb-text-secondary);";
const hrStyle = "height:1px;margin:12px 0;background:var(--lb-line-soft);";
const inlineCodeStyle =
  "padding:1px 5px;border-radius:var(--lb-radius-xs);background:var(--lb-surface-hover);font-family:Menlo,Consolas,monospace;font-size:0.88em;color:var(--lb-accent-ink);";
const codeBlockStyle =
  "display:block;box-sizing:border-box;margin:8px 0;padding:10px 12px;border-radius:8px;background:#29231f;color:#faf8f6;font-family:Menlo,Consolas,monospace;font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;";
const mathBlockStyle =
  "display:block;box-sizing:border-box;margin:8px 0;padding:10px 12px;border-radius:var(--lb-radius-md);background:var(--lb-surface-muted);color:var(--lb-accent-ink);text-align:center;overflow-wrap:anywhere;";
const mathInlineStyle = "color:var(--lb-accent-ink);";
// 图片：约束到容器宽度并按原比例缩放（AI 生图产物宽 2048px，不约束会溢出气泡）。
const imageStyle =
  "display:block;box-sizing:border-box;max-width:100%;height:auto;margin:8px 0;border-radius:var(--lb-radius-md);";

const markdown = createMarkdownRenderer();

/**
 * 把 markdown 文本渲染为内联样式 HTML 字符串
 * @param content markdown 原文
 * @returns 渲染后的 HTML 字符串
 */
export function renderMarkdown(content: string): string {
  return markdown.render(content || "");
}

/**
 * 取流式内容的尾部片段（打字光泽动画用）
 * @param content 当前累计内容
 * @param tailLength 尾部字符数
 * @returns 去掉尾部空白后的末尾片段；空内容返回空串
 */
export function readStreamTail(content: string, tailLength: number): string {
  const trimmed = content.replace(/\s+$/, "");
  if (!trimmed) {
    return "";
  }

  return trimmed.slice(Math.max(0, trimmed.length - tailLength));
}

function createMarkdownRenderer() {
  const md: MarkdownIt = new MarkdownIt({
    html: false,
    breaks: true,
    linkify: true,
    typographer: true,
    langPrefix: "language-",
    highlight(str, lang) {
      const escaped = md.utils.escapeHtml(str);
      const codeLang = lang ? `data-lang="${md.utils.escapeHtml(lang)}"` : "";
      return `<code ${codeLang} style="${codeBlockStyle}">${escaped}</code>`;
    },
  });

  md.renderer.rules.paragraph_open = () => `<p style="${paragraphStyle}">`;
  md.renderer.rules.heading_open = (tokens, idx) =>
    `<${tokens[idx].tag} style="${headingStyle}">`;
  md.renderer.rules.bullet_list_open = () => `<ul style="${listStyle}">`;
  md.renderer.rules.ordered_list_open = () => `<ol style="${listStyle}">`;
  md.renderer.rules.list_item_open = () => `<li style="${listItemStyle}">`;
  md.renderer.rules.blockquote_open = () =>
    `<blockquote style="${blockquoteStyle}">`;
  md.renderer.rules.hr = () => `<div style="${hrStyle}"></div>`;
  md.renderer.rules.code_inline = (tokens, idx) =>
    `<code style="${inlineCodeStyle}">${md.utils.escapeHtml(tokens[idx].content)}</code>`;
  md.renderer.rules.image = (tokens, idx) => {
    const token = tokens[idx];
    const src = token.attrGet("src") ?? "";
    if (!src) {
      return "";
    }
    // alt 存在 token.content（markdown-it 对 image token 的约定）
    const alt = md.utils.escapeHtml(token.content || "图片");
    return `<img src="${md.utils.escapeHtml(src)}" alt="${alt}" style="${imageStyle}" />`;
  };
  md.renderer.rules.code_block = (tokens, idx) =>
    `<code style="${codeBlockStyle}">${md.utils.escapeHtml(tokens[idx].content)}</code>`;
  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    const lang = token.info.trim().split(/\s+/)[0] || "code";

    if (lang.toLowerCase() === "math") {
      return renderMath(md, token.content, true);
    }

    const escaped = md.utils.escapeHtml(token.content);
    return `<code style="${codeBlockStyle}">${escaped}</code>`;
  };

  md.use(mathPlugin);
  return md;
}

function mathPlugin(md: MarkdownItInstance) {
  md.block.ruler.before("fence", "math_block", mathBlockRule, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });
  md.inline.ruler.before("escape", "math_inline", mathInlineRule);

  md.renderer.rules.math_inline = (tokens, idx) =>
    renderMath(md, tokens[idx].content, false);
  md.renderer.rules.math_block = (tokens, idx) =>
    renderMath(md, tokens[idx].content, true);
}

function mathBlockRule(
  state: MarkdownItStateBlock,
  startLine: number,
  endLine: number,
  silent = false,
) {
  const start = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];
  const marker = state.src.slice(start, start + 2);

  if (marker !== "$$") {
    return false;
  }

  let nextLine = startLine;
  let found = false;
  let content = state.src.slice(start + 2, max);

  if (content.trim().endsWith("$$") && content.trim().length > 2) {
    content = content.trim().slice(0, -2);
    found = true;
  }

  while (!found) {
    nextLine++;
    if (nextLine >= endLine) {
      return false;
    }

    const lineStart = state.bMarks[nextLine] + state.tShift[nextLine];
    const lineEnd = state.eMarks[nextLine];
    const line = state.src.slice(lineStart, lineEnd);
    const closeIndex = line.indexOf("$$");

    if (closeIndex >= 0) {
      content += `\n${line.slice(0, closeIndex)}`;
      found = true;
      break;
    }

    content += `\n${line}`;
  }

  if (silent) {
    return true;
  }

  const token = state.push("math_block", "math", 0);
  token.block = true;
  token.content = content.trim();
  token.map = [startLine, nextLine + 1];
  state.line = nextLine + 1;
  return true;
}

function mathInlineRule(state: MarkdownItStateInline, silent = false) {
  if (state.src[state.pos] !== "$") {
    return false;
  }

  if (state.src[state.pos + 1] === "$") {
    return false;
  }

  let close = state.pos + 1;
  while ((close = state.src.indexOf("$", close)) >= 0) {
    if (state.src[close - 1] !== "\\") {
      break;
    }
    close++;
  }

  if (close < 0 || close === state.pos + 1) {
    return false;
  }

  if (!silent) {
    const token = state.push("math_inline", "math", 0);
    token.content = state.src.slice(state.pos + 1, close);
  }

  state.pos = close + 1;
  return true;
}

function renderMath(md: MarkdownItInstance, tex: string, displayMode: boolean) {
  try {
    return renderToString(tex, {
      displayMode,
      throwOnError: false,
      output: "mathml",
    });
  } catch {
    const escaped = md.utils.escapeHtml(tex);
    return displayMode
      ? `<div style="${mathBlockStyle}">${escaped}</div>`
      : `<span style="${mathInlineStyle}">${escaped}</span>`;
  }
}
