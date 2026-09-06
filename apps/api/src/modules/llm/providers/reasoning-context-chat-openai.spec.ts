import { AIMessage, HumanMessage } from '@langchain/core/messages';

import { addReasoningContent } from './reasoning-context-chat-openai';

describe('ReasoningContextChatOpenAICompletions', () => {
  it('只把对应 assistant 的 reasoning_content 写回上游消息', () => {
    expect(
      addReasoningContent(
        [
          { role: 'user', content: '问题' },
          { role: 'assistant', content: '回答' },
        ],
        [
          new HumanMessage('问题'),
          new AIMessage({
            content: '回答',
            additional_kwargs: { reasoning_content: 'private' },
          }),
        ],
      ),
    ).toEqual([
      { role: 'user', content: '问题' },
      { role: 'assistant', content: '回答', reasoning_content: 'private' },
    ]);
  });
});
