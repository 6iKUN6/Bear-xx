import { AIMessage } from '@langchain/core/messages';
import { ModelPresetProbeService } from './model-preset-probe.service';

describe('ModelPresetProbeService', () => {
  /**
   * 构造探针与其底层模型替身
   * @param behavior 无工具调用与带工具调用两条路径的行为
   * @returns 返回探针实例与调用记录
   */
  function createProbe(behavior: {
    plainInvoke?: () => Promise<unknown>;
    boundInvoke?: (messages: unknown[]) => Promise<unknown>;
    supportsTools?: boolean;
  }) {
    const boundInvokeCalls: unknown[][] = [];
    const bound = {
      invoke: (messages: unknown[]) => {
        boundInvokeCalls.push(messages);
        return (
          behavior.boundInvoke?.(messages) ??
          Promise.resolve(new AIMessage({ content: 'ok' }))
        );
      },
    };
    const model = {
      invoke: () => behavior.plainInvoke?.() ?? Promise.resolve('pong'),
      ...(behavior.supportsTools === false ? {} : { bindTools: () => bound }),
    };
    const probe = new ModelPresetProbeService({
      createChatModel: () => model,
    } as never);
    return { probe, boundInvokeCalls };
  }

  const target = {
    presetId: 'draft',
    upstreamFormat: 'openai_chat_completions' as const,
    platform: 'openai',
    model: 'gpt-5.5',
    apiKey: 'sk-probe',
  };

  /** 构造一条带工具调用的模型回复 */
  function withToolCall() {
    return new AIMessage({
      content: '',
      tool_calls: [
        { id: 'call_1', name: 'connectivity_probe', args: { value: 'ping' } },
      ],
    });
  }

  it('两级都通过时判定为 tools', async () => {
    const { probe, boundInvokeCalls } = createProbe({
      boundInvoke: (messages) =>
        Promise.resolve(
          messages.length === 1
            ? withToolCall()
            : new AIMessage({ content: '完成' }),
        ),
    });

    await expect(probe.probe(target)).resolves.toEqual({
      capability: 'tools',
      stages: { reachable: true, toolRoundTrip: true },
    });
    // 必须真的回灌一次工具结果：id 语义不匹配的上游正是在第二轮才报 400
    expect(boundInvokeCalls).toHaveLength(2);
    expect(boundInvokeCalls[1]).toHaveLength(3);
  });

  it('连不通时判定为 unreachable，且不再尝试工具探测', async () => {
    const { probe, boundInvokeCalls } = createProbe({
      plainInvoke: () => Promise.reject(new Error('401 invalid api key')),
    });

    const result = await probe.probe(target);

    expect(result.capability).toBe('unreachable');
    expect(result.error).toContain('401');
    expect(boundInvokeCalls).toHaveLength(0);
  });

  it('连通但工具回灌失败时降级为 basic，仍可用于无工具节点', async () => {
    const { probe } = createProbe({
      boundInvoke: (messages) =>
        messages.length === 1
          ? Promise.resolve(withToolCall())
          : Promise.reject(
              new Error('400 No tool call found for function call output'),
            ),
    });

    const result = await probe.probe(target);

    expect(result.capability).toBe('basic');
    expect(result.stages).toEqual({ reachable: true, toolRoundTrip: false });
    expect(result.error).toContain('No tool call found');
  });

  it('上游未发起工具调用时不算通过，不声称支持工具', async () => {
    // 拿不到工具调用就无法证明闭环；判成功等于给出一个骗人的绿灯
    const { probe } = createProbe({
      boundInvoke: () => Promise.resolve(new AIMessage({ content: '你好' })),
    });

    const result = await probe.probe(target);

    expect(result.capability).toBe('basic');
    expect(result.error).toContain('未发起工具调用');
  });

  it('客户端不支持工具绑定时降级为 basic', async () => {
    const { probe } = createProbe({ supportsTools: false });

    const result = await probe.probe(target);

    expect(result.capability).toBe('basic');
    expect(result.error).toContain('不支持工具绑定');
  });

  it('错误文本被截断，避免超长上游响应写满数据库', async () => {
    const { probe } = createProbe({
      plainInvoke: () => Promise.reject(new Error('x'.repeat(2000))),
    });

    const result = await probe.probe(target);

    expect(result.error).toHaveLength(500);
  });
});
