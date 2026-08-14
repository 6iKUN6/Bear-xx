import { Module } from '@nestjs/common';
import { CosStorageService } from './cos-storage.service';
import { QiniuStorageService } from './qiniu-storage.service';
import { StorageAssetService } from './storage-asset.service';
import { StorageController } from './storage.controller';

@Module({
  controllers: [StorageController],
  providers: [QiniuStorageService, CosStorageService, StorageAssetService],
  exports: [QiniuStorageService, CosStorageService, StorageAssetService],
})
export class StorageModule {}
