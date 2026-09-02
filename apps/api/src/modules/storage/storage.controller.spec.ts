import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { StorageController } from './storage.controller';

describe('StorageController', () => {
  /**
   * 创建存储控制器测试依赖
   * @returns 返回 COS 服务 mock 与测试控制器实例
   * @description 验证上传凭证路由只调用腾讯云 COS 服务。
   */
  const createController = () => {
    const cosStorageService = {
      createUploadCredential: jest.fn(),
    };
    const storageAssetService = {};
    const controller = new StorageController(
      storageAssetService as never,
      cosStorageService as never,
    );

    return {
      controller,
      cosStorageService,
    };
  };

  it('COS 凭证路由仅向 COS 服务签发单对象 PUT 凭证', async () => {
    const { controller, cosStorageService } = createController();
    const credential = {
      key: 'image/202608/user-1/0123456789abcdef0123456789abcdef.png',
      uploadUrl: 'https://example.cos.ap-guangzhou.myqcloud.com/object',
      accessUrl: 'https://cdn.example.com/object',
      headers: { 'Content-Type': 'image/png' },
      expiresAt: 1_786_000_000_000,
    };
    cosStorageService.createUploadCredential.mockResolvedValue(credential);

    // Nest 将路由元数据附着在原始函数上，测试通过属性描述符读取而不解绑定实例方法。
    const handler = Object.getOwnPropertyDescriptor(
      StorageController.prototype,
      'createCosUploadCredential',
    )?.value as object;

    expect(handler).toEqual(expect.any(Function));
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(
      'cos/upload-credential',
    );
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.POST,
    );

    await expect(
      controller.createCosUploadCredential('user-1', {
        type: 'image',
        ext: 'png',
      }),
    ).resolves.toEqual(credential);
    expect(cosStorageService.createUploadCredential).toHaveBeenCalledWith(
      'user-1',
      'image',
      'png',
    );
  });
});
