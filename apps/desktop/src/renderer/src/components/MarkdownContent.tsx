import { useMemo } from "react";
import { renderMarkdown } from "@litter-bear/markdown";

interface MarkdownContentProps {
  content: string;
  className?: string;
}

/**
 * 桌面端 Markdown 薄壳
 * @description 解析与渲染规则在 @litter-bear/markdown（与小程序端共享），
 * 产出的是基于 --lb-* 变量的内联样式 HTML，直接交给 dangerouslySetInnerHTML。
 * 产物来自本地 markdown-it 渲染，不是用户注入的远程脚本。
 */
export function MarkdownContent({ content, className = "" }: MarkdownContentProps) {
  const html = useMemo(() => renderMarkdown(content), [content]);

  return (
    <div
      className={`markdown-body min-w-0 ${className}`.trim()}
      // eslint-disable-next-line react/no-danger -- 共享包产物的内联样式 HTML
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
