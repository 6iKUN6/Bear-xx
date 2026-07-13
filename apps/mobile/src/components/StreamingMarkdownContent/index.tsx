import { View } from "@tarojs/components";
import MarkdownContent from "../MarkdownContent";
import "./index.scss";

interface StreamingMarkdownContentProps {
  content: string;
  className?: string;
  emptyText?: string;
  streaming?: boolean;
  tailLength?: number;
}

export default function StreamingMarkdownContent({
  content,
  className = "",
  emptyText,
  streaming = false,
  tailLength = 12,
}: StreamingMarkdownContentProps) {
  const tail = streaming ? readStreamTail(content, tailLength) : "";

  return (
    <View className="streaming-markdown-content">
      <MarkdownContent
        content={content}
        emptyText={emptyText}
        className={className}
      />
      {tail && (
        <View className="streaming-markdown-tail" aria-hidden>
          {tail}
        </View>
      )}
    </View>
  );
}

function readStreamTail(content: string, tailLength: number) {
  const trimmed = content.replace(/\s+$/, "");
  if (!trimmed) {
    return "";
  }

  return trimmed.slice(Math.max(0, trimmed.length - tailLength));
}
