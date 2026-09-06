import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  ToolMessage,
} from '@langchain/core/messages';

import { CommonChatAgentLoopService } from './common-chat-agent-loop.service';

describe('CommonChatAgentLoopService model context collection', () => {
  it('普通执行会按模型轮次合并 AI chunk 并保留工具结果顺序', async () => {
    const runnable = {
      stream: jest.fn().mockResolvedValue(
        asyncChunks([
          [new AIMessageChunk('先'), at('agent', 1)],
          [new AIMessageChunk('思考'), at('agent', 1)],
          [
            new ToolMessage({
              content: 'result',
              tool_call_id: 'call-1',
              name: 'lookup',
            }),
            at('tools', 2),
          ],
          [new AIMessageChunk('完成'), at('agent', 3)],
        ]),
      ),
      getState: jest.fn(),
    };
    const onCompletedMessages = jest.fn();
    const service = createService(runnable);

    for await (const _event of service.stream({
      model: null as never,
      messages: [new HumanMessage('问题')],
      onCompletedMessages,
    })) {
      // 只验证完成后的原始消息采集。
    }

    expect(onCompletedMessages).toHaveBeenCalledTimes(1);
    expect(onCompletedMessages.mock.calls[0]?.[0]).toMatchObject([
      { type: 'ai', content: '先思考' },
      { type: 'tool', content: 'result', tool_call_id: 'call-1' },
      { type: 'ai', content: '完成' },
    ]);
  });

  it('HITL 恢复完成后从最终 checkpoint 取回中断前后的完整消息', async () => {
    const input = new HumanMessage('下单');
    const beforeInterrupt = new AIMessage({
      content: '',
      tool_calls: [
        { id: 'call-1', name: 'place_order', args: { sku: 'meal-1' } },
      ],
    });
    const toolResult = new ToolMessage({
      content: 'order-1',
      tool_call_id: 'call-1',
      name: 'place_order',
    });
    const finalAnswer = new AIMessage('订单已创建');
    const runnable = {
      stream: jest.fn().mockResolvedValue(asyncChunks([])),
      getState: jest
        .fn()
        .mockResolvedValueOnce({
          tasks: [
            {
              interrupts: [
                {
                  value: {
                    actionRequests: [
                      { name: 'place_order', args: { sku: 'meal-1' } },
                    ],
                  },
                },
              ],
            },
          ],
        })
        .mockResolvedValueOnce({ tasks: [] })
        .mockResolvedValueOnce({
          values: {
            messages: [input, beforeInterrupt, toolResult, finalAnswer],
          },
        }),
    };
    const onCompletedMessages = jest.fn();
    const service = createService(runnable);

    for await (const _event of service.resume({
      model: null as never,
      messages: [input],
      threadId: 'task-1',
      approvalToolNames: ['place_order'],
      decision: { decision: 'approve' },
      onCompletedMessages,
    })) {
      // 空流完成后从 checkpoint 采集。
    }

    expect(onCompletedMessages).toHaveBeenCalledWith([
      beforeInterrupt,
      toolResult,
      finalAnswer,
    ]);
  });

  it('仍在等待审批时不触发完成上下文回调', async () => {
    const runnable = {
      stream: jest.fn().mockResolvedValue(asyncChunks([])),
      getState: jest.fn().mockResolvedValue({
        tasks: [
          {
            interrupts: [
              {
                value: {
                  actionRequests: [{ name: 'place_order', args: {} }],
                },
              },
            ],
          },
        ],
      }),
    };
    const onCompletedMessages = jest.fn();
    const service = createService(runnable);

    for await (const _event of service.stream({
      model: null as never,
      messages: [new HumanMessage('下单')],
      threadId: 'task-1',
      approvalToolNames: ['place_order'],
      onCompletedMessages,
    })) {
      // 消费 approval.required。
    }

    expect(onCompletedMessages).not.toHaveBeenCalled();
  });
});

function createService(runnable: { stream: jest.Mock; getState: jest.Mock }) {
  return new CommonChatAgentLoopService(
    { createAgent: jest.fn().mockReturnValue(runnable) } as never,
    { get: jest.fn().mockReturnValue({}) } as never,
  );
}

function at(node: string, step: number) {
  return { langgraph_node: node, langgraph_step: step };
}

function asyncChunks(chunks: unknown[]): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator]: () => {
      let index = 0;
      return {
        next: () => {
          const value = chunks[index];
          index += 1;
          return Promise.resolve(
            value === undefined
              ? { value: undefined, done: true as const }
              : { value: value as never, done: false as const },
          );
        },
      };
    },
  };
}
