import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { LlmService } from '../llm/llm.service';
import type { QiniuStorageService } from '../storage/qiniu-storage.service';
import type { StorageAssetService } from '../storage/storage-asset.service';
import { ImageGenerationService } from './image-generation.service';

describe('ImageGenerationService', () => {
  /**
   * 创建生图管道测试实例
   * @returns 返回服务与依赖 mock
   * @description 验证 b64 解码转存、资产登记参数与未配置时的 503 透传。
   */
  const createService = () => {
    const llmService = { generateImage: jest.fn() };
    const qiniu = { uploadBuffer: jest.fn() };
    const assets = { register: jest.fn() };
    return {
      service: new ImageGenerationService(
        llmService as unknown as LlmService,
        qiniu as unknown as QiniuStorageService,
        assets as unknown as StorageAssetService,
      ),
      llmService,
      qiniu,
      assets,
    };
  };

  it('b64 结果解码后转存七牛并按 ai-image 登记资产', async () => {
    const { service, llmService, qiniu, assets } = createService();
    const imageBytes = Buffer.from('fake-png-data');
    llmService.generateImage.mockResolvedValue({
      b64: imageBytes.toString('base64'),
      revisedPrompt: '一只更好的太空熊',
    });
    qiniu.uploadBuffer.mockResolvedValue('image/202608/user-1/abc.png');
    assets.register.mockResolvedValue({
      url: 'http://cdn.example.com/image/202608/user-1/abc.png',
    });

    const result = await service.generate('user-1', '一只太空熊', '1024x1024');

    expect(qiniu.uploadBuffer).toHaveBeenCalledWith({
      data: imageBytes,
      ownerId: 'user-1',
      type: 'image',
      ext: 'png',
    });
    expect(assets.register).toHaveBeenCalledWith('user-1', {
      key: 'image/202608/user-1/abc.png',
      usage: 'ai-image',
      size: imageBytes.length,
      mimeType: 'image/png',
    });
    expect(result).toEqual({
      url: 'http://cdn.example.com/image/202608/user-1/abc.png',
      key: 'image/202608/user-1/abc.png',
      revisedPrompt: '一只更好的太空熊',
    });
  });

  it('参考图生图：下载 key 签名图 → editImage → 转存登记', async () => {
    const { service, llmService, qiniu, assets } = createService();
    const referenceBytes = Buffer.from('reference-image');
    const outputBytes = Buffer.from('output-image');
    (qiniu as unknown as { resolveAccessUrl: jest.Mock }).resolveAccessUrl =
      jest.fn(() => 'http://cdn.example.com/image/202608/user-1/ref.png');
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      headers: new Map([['content-type', 'image/png']]) as unknown as Headers,
      arrayBuffer: () => Promise.resolve(referenceBytes),
    });
    global.fetch = fetchMock;

    llmService.generateImage.mockResolvedValue(undefined);
    (llmService as unknown as { editImage: jest.Mock }).editImage = jest
      .fn()
      .mockResolvedValue({ b64: outputBytes.toString('base64') });
    qiniu.uploadBuffer.mockResolvedValue('image/202608/user-1/out.png');
    assets.register.mockResolvedValue({
      url: 'http://cdn.example.com/image/202608/user-1/out.png',
    });

    const result = await service.edit('user-1', {
      prompt: '改成夜景',
      sourceKeys: ['image/202608/user-1/00000000000000000000000000000000.png'],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        href: 'http://cdn.example.com/image/202608/user-1/ref.png',
      }),
      expect.anything(),
    );
    const editArgs = (llmService as unknown as { editImage: jest.Mock })
      .editImage.mock.calls[0][0] as {
      images: Array<{ data: Buffer }>;
    };
    expect(editArgs.images).toHaveLength(1);
    expect(result.key).toBe('image/202608/user-1/out.png');
  });

  it('参考图为空或超过 4 张被拒绝；内网地址被拒绝', async () => {
    const { service } = createService();
    await expect(service.edit('user-1', { prompt: 'x' })).rejects.toThrow(
      BadRequestException,
    );
    await expect(
      service.edit('user-1', {
        prompt: 'x',
        sourceUrls: Array.from(
          { length: 5 },
          (_, i) => `https://a.com/${i}.png`,
        ),
      }),
    ).rejects.toThrow('最多 4 张');
    await expect(
      service.edit('user-1', {
        prompt: 'x',
        sourceUrls: ['http://127.0.0.1/secret.png'],
      }),
    ).rejects.toThrow('内网');
  });

  it('生图模型未配置时 503 原样透传，不产生半成品资产', async () => {
    const { service, llmService, qiniu, assets } = createService();
    llmService.generateImage.mockRejectedValue(
      new ServiceUnavailableException('生图模型未配置'),
    );

    await expect(service.generate('user-1', 'prompt')).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(qiniu.uploadBuffer).not.toHaveBeenCalled();
    expect(assets.register).not.toHaveBeenCalled();
  });
});
