import { useMemo } from "react";
import { RichText, Text, View } from "@tarojs/components";
import { renderMarkdown } from "@litter-bear/markdown";

interface MarkdownContentProps {
  content: string;
  className?: string;
  emptyText?: string;
}

/**
 * 小程序端 Markdown 薄壳
 * @description 解析与渲染规则在 @litter-bear/markdown（与桌面端共享），
 * 这里只负责把产出的内联样式 HTML 交给 RichText。
 */
export default function MarkdownContent({
  content,
  className = "",
  emptyText,
}: MarkdownContentProps) {
  const html = useMemo(() => renderMarkdown(content), [content]);

  if (!content && emptyText) {
    return (
      <Text
        className={`block text-[0.9375rem] leading-[1.7] ${className}`.trim()}
      >
        {emptyText}
      </Text>
    );
  }

  return (
    <View className={`markdown-content min-w-0 ${className}`.trim()}>
      <RichText nodes={html} userSelect />
    </View>
  );
}
