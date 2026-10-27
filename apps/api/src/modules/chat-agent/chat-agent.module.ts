import { Module } from '@nestjs/common';
import { AgentFlowModule } from '../agent-flow/agent-flow.module';
import { AiModule } from '../ai/ai.module';
import { LlmModule } from '../llm/llm.module';
import { ChatAgentActivities } from './chat-agent.activities';
import { DefaultChatAgent } from './default-chat.agent';

/**
 * 代码定义的默认 ReAct 智能体
 * @description 未绑定 Flow 的智能体走这里：DefaultChatAgent 定义智能体，ChatAgentActivities 供 Temporal Worker 执行。
 */
@Module({
  imports: [AgentFlowModule, AiModule, LlmModule],
  providers: [DefaultChatAgent, ChatAgentActivities],
  exports: [ChatAgentActivities],
})
export class ChatAgentModule {}
