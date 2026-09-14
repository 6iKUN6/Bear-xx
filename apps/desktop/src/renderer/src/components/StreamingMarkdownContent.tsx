import { readStreamTail } from "@litter-bear/markdown";
import { MarkdownContent } from "./MarkdownContent";

interface StreamingMarkdownContentProps {
  content: string;
  streaming?: boolean;
  tailLength?: number;
}

/**
 * 流式 Markdown：完整渲染 + 末尾 shimmer 尾片
 * @description 与小程序端同一模式：整体 renderMarkdown 上屏，
 * 再用 readStreamTail 取末尾一段做呼吸高亮，提示仍在生成。
 */
export function StreamingMarkdownContent({
  content,
  streaming = false,
  tailLength = 12,
}: StreamingMarkdownContentProps) {
  const tail = streaming ? readStreamTail(content, tailLength) : "";

  return (
    <span className="relative block">
      <MarkdownContent content={content} />
      {tail && (
        <span
          aria-hidden
          className="pointer-events-none absolute bottom-0 right-0 select-none text-sm leading-[1.75] text-[var(--lb-accent)] animate-[lb-pulse_1.2s_ease-in-out_infinite]"
        >
          {tail}
        </span>
      )}
    </span>
  );
}
