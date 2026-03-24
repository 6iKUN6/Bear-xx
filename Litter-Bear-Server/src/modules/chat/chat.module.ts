import { Module } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { AiModule } from '../ai/ai.module';
import { ConversationModule } from '../conversation/conversation.module';
import { SseTaskModule } from '../sse-task/sse-task.module';

@Module({
  imports: [AiModule, ConversationModule, SseTaskModule],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
