import { Module } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { AiModule } from '../ai/ai.module';
import { ConversationModule } from '../conversation/conversation.module';

@Module({
  imports: [AiModule, ConversationModule],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
