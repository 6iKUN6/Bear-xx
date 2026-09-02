import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { ConversationService } from './conversation.service';
import { GroupRouterService } from './group-router.service';
import { ConversationController } from './conversation.controller';
import { McDonaldsOrderModule } from '../mcdonalds-order/mcdonalds-order.module';
import { AgentAccessModule } from '../agent-access/agent-access.module';

@Module({
  imports: [LlmModule, McDonaldsOrderModule, AgentAccessModule],
  controllers: [ConversationController],
  providers: [ConversationService, GroupRouterService],
  exports: [ConversationService, GroupRouterService],
})
export class ConversationModule {}
