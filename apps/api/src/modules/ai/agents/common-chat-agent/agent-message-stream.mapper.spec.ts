import type { BaseMessageChunk } from '@langchain/core/messages';
import {
  mapMessagesStream,
  type MessagesModeChunk,
} from './agent-message-stream.mapper';

describe('mapMessagesStream 的模型调用计数', () => {
  /**
   * 构造一个 messages 模式的块
   * @param type 消息类型：ai 为模型输出，tool 为工具结果
   * @param metadata LangGraph 注入的步骤元数据
   * @param text 可选的模型文本增量
   * @returns 返回可直接投喂 mapMessagesStream 的块
   * @description 只造计数所需的最小形状；工具分片、审批中断由其他链路覆盖。
   */
  function chunk(
    type: 'ai' | 'tool',
    metadata: Record<string, unknown>,
    text = '',
  ): MessagesModeChunk {
    return [{ type, content: text } as unknown as BaseMessageChunk, metadata];
  }

  /**
   * 构造 LangGraph 的步骤元数据
   * @param node 节点名
   * @param step 步骤序号
   * @returns 返回与真实流同形的元数据
   */
  function at(node: string, step: number): Record<string, unknown> {
    return { langgraph_node: node, langgraph_step: step };
  }

  /**
   * 把块数组包装为异步可迭代对象
   * @param chunks 待产出的块序列
   * @returns 返回 mapMessagesStream 可消费的异步流
   * @description 不写成 async 生成器：这里没有真正的异步等待，async function* 只会为了过
   * lint 塞一个无意义的 await。
   */
  function toAsyncStream(
    chunks: MessagesModeChunk[],
  ): AsyncIterable<MessagesModeChunk> {
    return {
      [Symbol.asyncIterator]: () => {
        let index = 0;
        return {
          next: () => {
            const current = chunks[index];
            index += 1;
            return Promise.resolve(
              current
                ? { value: current, done: false }
                : { value: undefined, done: true },
            );
          },
        };
      },
    };
  }

  /**
   * 消费一个块序列并统计模型调用次数
   * @param chunks 待消费的块序列
   * @returns 返回 onModelTurn 被调用的次数
   */
  async function countTurns(chunks: MessagesModeChunk[]): Promise<number> {
    let turns = 0;
    for await (const _event of mapMessagesStream(toAsyncStream(chunks), () => {
      turns += 1;
    })) {
      // 计数只依赖块本身，事件在此不参与断言
    }
    return turns;
  }

  it('同一模型调用产出的多个分片只计一次', async () => {
    await expect(
      countTurns([
        chunk('ai', at('agent', 1), '你'),
        chunk('ai', at('agent', 1), '好'),
        chunk('ai', at('agent', 1), '呀'),
      ]),
    ).resolves.toBe(1);
  });

  it('ReAct 往返中每次模型调用各计一次，工具结果不计', async () => {
    await expect(
      countTurns([
        chunk('ai', at('agent', 1)),
        chunk('tool', at('tools', 2)),
        chunk('ai', at('agent', 3), '最终答案'),
      ]),
    ).resolves.toBe(2);
  });

  it('只产出工具调用、没有文本的模型调用同样计数', async () => {
    // 事件层面这一步可能只有 tool.call.*，挂在事件上计数会漏计，故按块判定
    await expect(countTurns([chunk('ai', at('agent', 1))])).resolves.toBe(1);
  });

  it('子图与外层图的同名节点同步骤不互相吞掉', async () => {
    let turns = 0;
    const nested: Array<[string[], MessagesModeChunk]> = [
      [[], chunk('ai', at('agent', 1))],
      [['plan:0'], chunk('ai', at('agent', 1))],
    ];
    for await (const _event of mapMessagesStream(
      toAsyncStream(nested as unknown as MessagesModeChunk[]),
      () => {
        turns += 1;
      },
    )) {
      // 只统计回调次数
    }
    expect(turns).toBe(2);
  });

  it('缺少 LangGraph 步骤元数据时按块计数，宁可多计也不让预算静默变成无限', async () => {
    await expect(countTurns([chunk('ai', {}), chunk('ai', {})])).resolves.toBe(
      2,
    );
  });
});
