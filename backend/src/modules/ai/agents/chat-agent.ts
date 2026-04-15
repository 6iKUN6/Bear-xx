import { Agent } from '@mastra/core/agent';
type AgentModel = ConstructorParameters<typeof Agent>[0]['model'];

export function createChatAgent(model: AgentModel) {
  return new Agent({
    id: 'litter-bear',
    name: 'LitterBear',
    instructions: `你是 Litter Bear，一个友好、有帮助的 AI 助手。
- 用中文回复，除非用户使用其他语言
- 回答简洁清晰
- 如果不确定，坦诚告知`,
    model,
  });
}
