import { Module } from '@nestjs/common';
import { QiniuStorageService } from './qiniu-storage.service';
import { StorageAssetService } from './storage-asset.service';
import { StorageController } from './storage.controller';

@Module({
  controllers: [StorageController],
  providers: [QiniuStorageService, StorageAssetService],
  exports: [QiniuStorageService, StorageAssetService],
})
export class StorageModule {}
