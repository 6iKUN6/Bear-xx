import { Module } from '@nestjs/common';
import { CosStorageService } from './cos-storage.service';
import { StorageAssetService } from './storage-asset.service';
import { StorageController } from './storage.controller';

@Module({
  controllers: [StorageController],
  providers: [CosStorageService, StorageAssetService],
  exports: [CosStorageService, StorageAssetService],
})
export class StorageModule {}
