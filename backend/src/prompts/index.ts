import { readFileSync } from 'fs';
import { join } from 'path';

export const chatAgentCommonPrompt = readPromptMarkdown('common-chat-agent.md');

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
