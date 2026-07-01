import { readFileSync } from 'fs';
import { join } from 'path';

export const chatAgentCommonPrompt = readPromptMarkdown('common-chat-agent.md');
export const conversationSummaryFullPrompt = readPromptMarkdown(
  'conversation-summary-full.md',
);
export const conversationSummaryIncrementalPrompt = readPromptMarkdown(
  'conversation-summary-incremental.md',
);

function readPromptMarkdown(filename: string) {
  for (const baseDir of [__dirname, join(__dirname, '..', 'src', 'prompts')]) {
    try {
      return readFileSync(join(baseDir, filename), 'utf8').trim();
    } catch {
      // Try the next candidate path. This keeps both src and dist runtime paths usable.
    }
  }

  throw new Error(`Prompt markdown not found: ${filename}`);
}
