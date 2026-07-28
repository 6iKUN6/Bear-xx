import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminObservabilityService } from './admin-observability.service';

@Module({
  controllers: [AdminController],
  providers: [AdminObservabilityService],
})
export class AdminModule {}
