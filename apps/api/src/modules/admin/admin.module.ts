import { Module } from '@nestjs/common';
import { StreamTaskModule } from '../stream-task/stream-task.module';
import { LlmModule } from '../llm/llm.module';
import { AdminController } from './admin.controller';
import { AdminAgentTestController } from './admin-agent-test.controller';
import { AdminModelPresetController } from './admin-model-preset.controller';
import { AdminObservabilityService } from './admin-observability.service';
import { ModelPresetService } from './model-preset.service';

@Module({
  imports: [StreamTaskModule, LlmModule],
  controllers: [
    AdminController,
    AdminAgentTestController,
    AdminModelPresetController,
  ],
  providers: [AdminObservabilityService, ModelPresetService],
})
export class AdminModule {}
