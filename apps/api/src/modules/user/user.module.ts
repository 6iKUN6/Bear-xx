import { Module } from '@nestjs/common';
import { UserService } from './user.service';
import { UserController } from './user.controller';
import { AgentAccessModule } from '../agent-access/agent-access.module';

@Module({
  imports: [AgentAccessModule],
  controllers: [UserController],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
