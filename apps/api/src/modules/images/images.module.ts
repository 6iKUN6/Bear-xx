import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { StorageModule } from '../storage/storage.module';
import { ImageGenerationService } from './image-generation.service';
import { ImagesController } from './images.controller';

@Module({
  imports: [LlmModule, StorageModule],
  controllers: [ImagesController],
  providers: [ImageGenerationService],
  exports: [ImageGenerationService],
})
export class ImagesModule {}
