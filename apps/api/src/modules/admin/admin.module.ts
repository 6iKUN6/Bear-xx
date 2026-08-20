import { Module } from '@nestjs/common';
import { StreamTaskModule } from '../stream-task/stream-task.module';
import { LlmModule } from '../llm/llm.module';
import { AiModule } from '../ai/ai.module';
import { AdminController } from './admin.controller';
import { AdminCapabilityController } from './admin-capability.controller';
import { AdminAgentTestController } from './admin-agent-test.controller';
import { AdminModelPresetController } from './admin-model-preset.controller';
import { AdminObservabilityService } from './admin-observability.service';
import { AgentTestSessionService } from './agent-test-session.service';
import { ModelPresetService } from './model-preset.service';
import { ModelPresetProbeService } from './model-preset-probe.service';

@Module({
  imports: [StreamTaskModule, LlmModule, AiModule],
  controllers: [
    AdminController,
    AdminCapabilityController,
    AdminAgentTestController,
    AdminModelPresetController,
  ],
  providers: [
    AdminObservabilityService,
    AgentTestSessionService,
    ModelPresetService,
    ModelPresetProbeService,
  ],
})
export class AdminModule {}
