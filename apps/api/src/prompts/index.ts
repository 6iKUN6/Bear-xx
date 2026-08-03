import { readFileSync } from 'fs';
import { join } from 'path';

export const chatAgentCommonPrompt = readPromptMarkdown('common-chat-agent.md');
export const conversationSummaryFullPrompt = readPromptMarkdown(
  'conversation-summary-full.md',
);
export const conversationSummaryIncrementalPrompt = readPromptMarkdown(
  'conversation-summary-incremental.md',
);
export const conversationTitlePrompt = readPromptMarkdown(
  'conversation-title.md',
);

function readPromptMarkdown(filename: string) {
  // 覆盖两种运行形态：
  // - ts-node/dev：__dirname = <api>/src/prompts
  // - 编译产物：  __dirname = <api>/dist/src/prompts
  // 不依赖构建时的 asset 拷贝，始终能回退到真实的 src/prompts。
  const candidateDirs = [
    __dirname, // .md 与编译产物同目录（nest 拷贝 assets 成功时）
    join(__dirname, '..', '..', '..', 'src', 'prompts'), // dist/src/prompts → api/src/prompts
    join(__dirname, '..', '..', 'src', 'prompts'), // dist/prompts → api/src/prompts（保险）
    join(process.cwd(), 'src', 'prompts'), // 从 apps/api 目录启动时
  ];

  for (const baseDir of candidateDirs) {
    try {
      return readFileSync(join(baseDir, filename), 'utf8').trim();
    } catch {
      // Try the next candidate path.
    }
  }

  throw new Error(`Prompt markdown not found: ${filename}`);
}
