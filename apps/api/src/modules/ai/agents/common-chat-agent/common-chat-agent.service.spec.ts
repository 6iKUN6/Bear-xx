import { ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { Logger } from '@nestjs/common';

import type { ResolvedLlmTextRequest } from '../../../llm/llm.types';
import { CommonChatAgentService } from './common-chat-agent.service';

describe('CommonChatAgentService model context safety', () => {
  it('提取失败只降级隐藏上下文，不重启模型或工具链', async () => {
    const request: ResolvedLlmTextRequest = {
      model: {
        id: 'kimi:kimi-k3',
        provider: 'openai',
        platform: 'kimi',
        model: 'kimi-k3',
        upstreamFormat: 'openai_chat_completions',
      },
      generation: {},
      reasoning: { effort: 'max' },
    };
    const llmService = {
      resolveTextRequest: jest.fn().mockReturnValue(request),
      createChatModel: jest.fn().mockReturnValue({}),
    };
    const brokenToolMessage = new ToolMessage({
      content: 'result',
      tool_call_id: 'call-1',
      name: 'tool',
    });
    Reflect.set(brokenToolMessage, 'status', 'invalid');
    expect(ToolMessage.isInstance(brokenToolMessage)).toBe(true);
    const loopService = {
      stream: jest.fn().mockImplementation(async function* (options: {
        onCompletedMessages?: (messages: BaseMessage[]) => void | Promise<void>;
      }) {
        await options.onCompletedMessages?.([brokenToolMessage]);
        yield* [];
      }),
      resume: jest.fn(),
    };
    const warn = jest.spyOn(Logger, 'warn').mockImplementation();
    const onCompletedModelContext = jest.fn();
    const service = new CommonChatAgentService(
      llmService as never,
      { get: jest.fn() } as never,
      loopService as never,
    );

    for await (const _event of service.streamEvents({
      llm: request,
      messages: [{ role: 'user', content: '下单' }],
      onCompletedModelContext,
    })) {
      // 提取失败时没有公共事件。
    }

    expect(llmService.createChatModel).toHaveBeenCalledTimes(1);
    expect(loopService.stream).toHaveBeenCalledTimes(1);
    expect(loopService.stream.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        onCompletedMessages: expect.any(Function),
      }),
    );
    expect(onCompletedModelContext).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('model_context.extraction_failed'),
      CommonChatAgentService.name,
    );
    warn.mockRestore();
  });
});
