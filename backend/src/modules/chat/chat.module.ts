import { Module } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { AiModule } from '../ai/ai.module';
import { ConversationModule } from '../conversation/conversation.module';
import { StreamTaskModule } from '../stream-task/stream-task.module';

@Module({
  imports: [AiModule, ConversationModule, StreamTaskModule],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
