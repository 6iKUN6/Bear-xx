import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';
import { QiniuStorageService } from '../storage/qiniu-storage.service';
import { StorageAssetService } from '../storage/storage-asset.service';
import type { LlmImageResult } from '../llm/llm.types';
import type { GeneratedImageDto } from './dto/create-image.dto';

/** 参考图数量上限（gpt-image 支持到 16，业务先收紧） */
export const MAX_REFERENCE_IMAGES = 4;
/** 单张参考图大小上限（字节） */
const REFERENCE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const REFERENCE_DOWNLOAD_TIMEOUT_MS = 30000;

export interface EditImageInput {
  prompt: string;
  /** 参考图对象 key（七牛资产，服务端签 URL 取回） */
  sourceKeys?: string[];
  /** 参考图完整 URL（对话中出现过的图片地址等） */
  sourceUrls?: string[];
  size?: string;
}

/**
 * AI 生图管道
 * @description 文生图（generations）与参考图生图（edits）共用一条持久化路径：
 * 模型出图 → 下载/解码 → 服务端转存七牛 → 登记 StorageAsset（usage=ai-image）。
 * provider 返回的图片 URL 通常是短时效临时链接，必须转存后才能持久引用。
 * 供 /images 直调接口与 generateImage/editImage 工具（生图 agent）共用。
 */
@Injectable()
export class ImageGenerationService {
  private readonly logger = new Logger(ImageGenerationService.name);

  constructor(
    private readonly llmService: LlmService,
    private readonly qiniuStorageService: QiniuStorageService,
    private readonly storageAssetService: StorageAssetService,
  ) {}

  /**
   * 文生图并持久化
   * @param userId 归属用户（进 key 路径与资产登记）
   * @param prompt 提示词
   * @param size 可选尺寸
   * @returns 返回转存后的 URL、对象 key 与润色 prompt
   */
  async generate(
    userId: string,
    prompt: string,
    size?: string,
  ): Promise<GeneratedImageDto> {
    const result = await this.llmService.generateImage({ prompt, size });
    return this.persistResult(userId, result);
  }

  /**
   * 参考图生图并持久化
   * @param userId 归属用户
   * @param input prompt + 参考图（key 或 URL，合计 1-4 张）
   * @returns 返回转存后的 URL、对象 key 与润色 prompt
   * @description key 走七牛签名 URL 取回；外部 URL 有基础 SSRF 防护
   * （仅 http/https、拒绝内网地址、大小与超时上限）。
   */
  async edit(
    userId: string,
    input: EditImageInput,
  ): Promise<GeneratedImageDto> {
    const urls = [
      ...(input.sourceKeys ?? []).map((key) =>
        this.qiniuStorageService.resolveAccessUrl(key),
      ),
      ...(input.sourceUrls ?? []),
    ];
    if (urls.length === 0) {
      throw new BadRequestException(
        '至少提供一张参考图（sourceKeys 或 sourceUrls）',
      );
    }
    if (urls.length > MAX_REFERENCE_IMAGES) {
      throw new BadRequestException(
        `参考图最多 ${MAX_REFERENCE_IMAGES} 张，当前 ${urls.length} 张`,
      );
    }

    const images = await Promise.all(
      urls.map((url) => this.downloadReference(url)),
    );
    const result = await this.llmService.editImage({
      prompt: input.prompt,
      images,
      size: input.size,
    });
    return this.persistResult(userId, result);
  }

  /** 出图结果统一持久化：转存七牛 + 登记资产 */
  private async persistResult(
    userId: string,
    result: LlmImageResult,
  ): Promise<GeneratedImageDto> {
    const imageData = await this.resolveImageData(result.b64, result.url);

    const key = await this.qiniuStorageService.uploadBuffer({
      data: imageData,
      ownerId: userId,
      type: 'image',
      ext: 'png',
    });
    const asset = await this.storageAssetService.register(userId, {
      key,
      usage: 'ai-image',
      size: imageData.length,
      mimeType: 'image/png',
    });

    this.logger.log(
      `AI image persisted: key=${key} bytes=${imageData.length} user=${userId}`,
    );

    return {
      url: asset.url,
      key,
      revisedPrompt: result.revisedPrompt,
    };
  }

  /**
   * 取回图片二进制
   * @description provider 返回 base64 直接解码；返回临时 URL 则服务端下载。
   */
  private async resolveImageData(b64?: string, url?: string): Promise<Buffer> {
    if (b64) {
      return Buffer.from(b64, 'base64');
    }
    if (!url) {
      throw new Error('生图结果缺少图片数据');
    }

    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) {
      throw new Error(`下载生图结果失败(${response.status})`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * 下载参考图（带基础 SSRF 防护）
   * @description URL 可能来自模型/用户输入：仅放行 http(s)，拒绝
   * localhost/内网字面量地址，限制大小与超时。正式来源基本都是自家
   * CDN 域名或 provider 临时链接。
   */
  private async downloadReference(
    rawUrl: string,
  ): Promise<{ data: Buffer; mimeType?: string }> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new BadRequestException(
        `参考图地址不合法：${rawUrl.slice(0, 100)}`,
      );
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new BadRequestException('参考图仅支持 http/https 地址');
    }
    if (this.isPrivateHost(url.hostname)) {
      throw new BadRequestException('参考图地址不允许指向内网');
    }

    const response = await fetch(url, {
      signal: AbortSignal.timeout(REFERENCE_DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new BadRequestException(
        `参考图下载失败(${response.status})：${rawUrl.slice(0, 100)}`,
      );
    }

    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > REFERENCE_IMAGE_MAX_BYTES) {
      throw new BadRequestException('单张参考图不能超过 10MB');
    }

    return {
      data,
      mimeType:
        response.headers.get('content-type')?.split(';')[0] ?? undefined,
    };
  }

  /** 内网/回环地址字面量判定（基础防护，不做 DNS 解析级校验） */
  private isPrivateHost(hostname: string): boolean {
    const host = hostname.toLowerCase();
    return (
      host === 'localhost' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host.startsWith('127.') ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      host.endsWith('.local') ||
      host.endsWith('.internal')
    );
  }
}
