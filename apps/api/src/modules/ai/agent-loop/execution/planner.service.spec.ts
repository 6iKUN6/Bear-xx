import { Test } from '@nestjs/testing';
import { LlmService } from '../../../llm/llm.service';
import { PlannerService } from './planner.service';

describe('Planner 会话上下文', () => {
  it('规划延续请求时把前文约束和摘要交给模型', async () => {
    const llm = {
      generateStructured: jest
        .fn()
        .mockResolvedValue({ steps: [{ goal: '按约束续写' }] }),
    };
    const module = await Test.createTestingModule({
      providers: [PlannerService, { provide: LlmService, useValue: llm }],
    }).compile();
    await module.get(PlannerService).plan(
      {
        userId: 'user',
        messages: [
          { role: 'system', content: '较早历史摘要：故事设定在海底' },
          { role: 'user', content: '主角不能离开潜艇' },
          { role: 'assistant', content: '已确定第一章大纲' },
          { role: 'user', content: '按前面讨论的方案继续' },
        ],
        tools: [],
      },
      3,
      [],
      'test-model',
    );
    const messages: Array<{ content: string }> =
      llm.generateStructured.mock.calls[0][0];
    expect(messages.map((message) => message.content).join('\n')).toContain(
      '主角不能离开潜艇',
    );
    expect(messages.map((message) => message.content).join('\n')).toContain(
      '故事设定在海底',
    );
  });
});
