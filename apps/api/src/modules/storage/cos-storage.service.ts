import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import COS from 'cos-nodejs-sdk-v5';
import { randomUUID } from 'crypto';
import type { UploadMediaType } from './dto/upload-credential.dto';

/** COS 预签名上传 URL 的有效期（秒） */
const UPLOAD_URL_TTL_SECONDS = 600;
/** 腾讯云 COS bucket 名：小写名称加 -appid 后缀 */
const COS_BUCKET_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?-\d{6,10}$/;
/** 本项目支持的 COS 区域格式：ap-{region} */
const COS_REGION_PATTERN = /^ap-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 可签发的媒体类型与扩展名到 MIME 类型的唯一闭集 */
const CONTENT_TYPES: Readonly<
  Record<UploadMediaType, Readonly<Record<string, string>>>
> = {
  image: {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    heic: 'image/heic',
  },
  audio: {
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    wav: 'audio/wav',
    aac: 'audio/aac',
    amr: 'audio/amr',
    ogg: 'audio/ogg',
    opus: 'audio/opus',
  },
};

interface CosStorageConfig {
  secretId: string;
  secretKey: string;
  bucket: string;
  region: string;
  domain: string;
}

export interface CosUploadCredential {
  key: string;
  uploadUrl: string;
  accessUrl: string;
  headers: { 'Content-Type': string };
  expiresAt: number;
}

export interface CosObjectMetadata {
  contentLength: number;
  contentType: string;
}

export interface CosDownloadedObject extends CosObjectMetadata {
  body: Buffer;
}

/**
 * 腾讯云 COS 对象存储
 * @description 统一签发单对象 HTTPS PUT 预签名 URL、生成公有读访问 URL，
 * 并为 AI 生图等服务端自产内容提供二进制上传能力。
 */
@Injectable()
export class CosStorageService {
  constructor(private readonly configService: ConfigService) {}

  /**
   * 签发小程序直传 COS 的单对象上传凭证
   * @param userId 上传者 ID，用于归属对象 key
   * @param type 媒体类型，决定 image 或 audio 目录
   * @param ext 文件扩展名，已由调用方 DTO 校验为字母数字
   * @returns 返回对象 key、HTTPS PUT URL、访问 URL、必填请求头和过期时间
   * @description 每次调用只对一个新 key 签名十分钟，凭证不允许泛化到其他对象。
   */
  async createUploadCredential(
    userId: string,
    type: UploadMediaType,
    ext: string,
  ): Promise<CosUploadCredential> {
    const contentType = this.resolveContentType(type, ext);
    const config = this.requireConfig();
    const key = this.buildObjectKey(type, userId, ext);
    const headers = { 'Content-Type': contentType };
    const uploadUrl = await this.createSignedPutUrl(config, key, headers);

    return {
      key,
      uploadUrl,
      accessUrl: this.buildAccessUrl(config.domain, key),
      headers,
      expiresAt: Date.now() + UPLOAD_URL_TTL_SECONDS * 1000,
    };
  }

  /**
   * 生成公开对象访问 URL
   * @param key 已登记的 COS 对象 key
   * @returns 返回由访问域名与安全编码 key 组成的稳定 URL
   * @description 当前存储桶采用公有读、私有写，读取不签名；仍校验 key，避免路径或协议注入。
   */
  resolveAccessUrl(key: string): string {
    const config = this.requireConfig();
    return this.buildAccessUrl(config.domain, key);
  }

  /**
   * 将服务端生成的二进制上传至 COS
   * @param input 数据、归属用户、媒体类型与扩展名
   * @returns 返回上传成功的对象 key
   * @description 复用单对象预签名 PUT 约束，供 AI 生图等服务端自产内容持久化；失败时不登记资产。
   */
  async uploadBuffer(input: {
    data: Buffer;
    ownerId: string;
    type: UploadMediaType;
    ext: string;
  }): Promise<string> {
    const credential = await this.createUploadCredential(
      input.ownerId,
      input.type,
      input.ext,
    );
    const response = await fetch(credential.uploadUrl, {
      method: 'PUT',
      headers: credential.headers,
      body: new Blob([new Uint8Array(input.data)]),
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `腾讯云 COS 服务端上传失败(${response.status})：${detail.slice(0, 200)}`,
      );
    }
    return credential.key;
  }

  /**
   * 读取对象的真实元数据。
   * @param key 已登记的 COS 对象 key
   * @returns 返回 COS 实际 Content-Length 与 Content-Type
   * @description 聊天附件不能信任客户端登记的大小和 MIME；在创建任务前通过带服务端凭据的
   * HEAD 请求核对真实对象，避免伪造登记值绕过视觉输入上限。
   */
  async getObjectMetadata(key: string): Promise<CosObjectMetadata> {
    this.assertSafeKey(key);
    const config = this.requireConfig();
    let result: COS.HeadObjectResult;
    try {
      result = await this.createClient(config).headObject({
        Bucket: config.bucket,
        Region: config.region,
        Key: key,
      });
    } catch {
      throw new ServiceUnavailableException('腾讯云 COS 对象元数据读取失败');
    }
    return this.readObjectMetadata(result.headers);
  }

  /**
   * 下载一个有明确字节上限的 COS 对象。
   * @param key 已登记的 COS 对象 key
   * @param maxBytes 允许读入内存的最大字节数
   * @returns 返回对象二进制与 COS 实际元数据
   * @description 先 HEAD 拒绝超限对象，再用 Range 多取一个字节作为竞态保护；即使对象在
   * HEAD 后被替换，也不会无界读入 Activity Worker 内存。
   */
  async downloadObject(
    key: string,
    maxBytes: number,
  ): Promise<CosDownloadedObject> {
    const metadata = await this.getObjectMetadata(key);
    if (metadata.contentLength > maxBytes) {
      throw new BadRequestException(`COS 对象不能超过 ${maxBytes} 字节`);
    }
    const config = this.requireConfig();
    let result: COS.GetObjectResult;
    try {
      result = await this.createClient(config).getObject({
        Bucket: config.bucket,
        Region: config.region,
        Key: key,
        Range: `bytes=0-${maxBytes}`,
      });
    } catch {
      throw new ServiceUnavailableException('腾讯云 COS 对象下载失败');
    }
    if (result.Body.length > maxBytes) {
      throw new BadRequestException(`COS 对象不能超过 ${maxBytes} 字节`);
    }
    return { body: result.Body, ...metadata };
  }

  /**
   * 生成 COS 对象 key
   * @param type 媒体类型，作为对象目录前缀
   * @param userId 上传者 ID，作为对象归属目录
   * @param ext 文件扩展名
   * @returns 返回格式为 {image|audio}/{yyyyMM}/{userId}/{uuid32}.{ext} 的对象 key
   * @description 按月和用户分层，随机 UUID 避免同名覆盖并便于对象生命周期治理。
   */
  private buildObjectKey(
    type: UploadMediaType,
    userId: string,
    ext: string,
  ): string {
    const now = new Date();
    const month = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const id = randomUUID().replaceAll('-', '');
    return `${type}/${month}/${userId}/${id}.${ext.toLowerCase()}`;
  }

  /**
   * 生成确定的上传 Content-Type
   * @param type 媒体类型
   * @param ext 文件扩展名
   * @returns 返回用于 COS 签名与小程序 PUT 请求的 MIME 类型
   * @description 仅允许媒体类型与扩展名的闭集组合，避免为未知或不匹配的文件签发上传地址。
   */
  private resolveContentType(type: UploadMediaType, ext: string): string {
    const contentType = CONTENT_TYPES[type][ext.toLowerCase()];
    if (!contentType) {
      throw new BadRequestException(
        `不支持的媒体扩展名：${type} 类型不支持 .${ext.toLowerCase()}`,
      );
    }

    return contentType;
  }

  /**
   * 使用官方 COS SDK 生成 HTTPS PUT 预签名 URL
   * @param config 已校验的 COS 配置
   * @param key 本次上传唯一允许写入的对象 key
   * @param headers 必须参与签名并由小程序原样携带的请求头
   * @returns 返回十分钟有效的 HTTPS PUT 预签名 URL
   * @description SDK 的 getObjectUrl 使用回调，本方法将其封装为 Promise，便于上层正确等待签名完成与处理错误。
   */
  private createSignedPutUrl(
    config: CosStorageConfig,
    key: string,
    headers: { 'Content-Type': string },
  ): Promise<string> {
    const client = new COS({
      SecretId: config.secretId,
      SecretKey: config.secretKey,
    });

    return new Promise((resolve, reject) => {
      client.getObjectUrl(
        {
          Bucket: config.bucket,
          Region: config.region,
          Key: key,
          Method: 'PUT',
          Sign: true,
          Expires: UPLOAD_URL_TTL_SECONDS,
          Protocol: 'https:',
          Headers: headers,
        },
        (error, data) => {
          if (error) {
            reject(
              new ServiceUnavailableException('腾讯云 COS 上传凭证签发失败'),
            );
            return;
          }

          if (!data.Url.startsWith('https://')) {
            reject(
              new ServiceUnavailableException(
                '腾讯云 COS 未返回 HTTPS 上传地址',
              ),
            );
            return;
          }

          resolve(data.Url);
        },
      );
    });
  }

  /** 使用已校验配置创建 COS SDK 客户端。 */
  private createClient(config: CosStorageConfig): COS {
    return new COS({
      SecretId: config.secretId,
      SecretKey: config.secretKey,
    });
  }

  /** 从 COS 响应头收窄出可信对象大小与 MIME。 */
  private readObjectMetadata(
    headers: COS.Headers | undefined,
  ): CosObjectMetadata {
    const contentLength = Number(headers?.['content-length']);
    const contentType = headers?.['content-type'];
    if (
      !Number.isSafeInteger(contentLength) ||
      contentLength <= 0 ||
      typeof contentType !== 'string' ||
      !contentType.trim()
    ) {
      throw new ServiceUnavailableException('腾讯云 COS 对象元数据不完整');
    }
    return {
      contentLength,
      contentType: contentType.split(';', 1)[0].trim().toLowerCase(),
    };
  }

  /**
   * 读取并校验 COS 配置
   * @returns 返回签发预签名 URL 所需的 COS 凭据、空间、区域和访问域名
   * @description 配置校验延迟到实际调用，缺失配置不会影响 API 启动，但所有对象存储操作都会明确失败。
   */
  private requireConfig(): CosStorageConfig {
    const secretId = this.configService.get<string>('COS_SECRET_ID');
    const secretKey = this.configService.get<string>('COS_SECRET_KEY');
    const bucket = this.configService.get<string>('COS_BUCKET');
    const region = this.configService.get<string>('COS_REGION');
    const rawDomain = this.configService.get<string>('COS_BUCKET_DOMAIN');

    if (
      !secretId?.trim() ||
      !secretKey?.trim() ||
      !bucket?.trim() ||
      !region?.trim() ||
      !rawDomain?.trim()
    ) {
      throw new ServiceUnavailableException(
        'COS 对象存储未配置：请在 env 中填写 COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET / COS_REGION / COS_BUCKET_DOMAIN',
      );
    }

    const normalizedBucket = bucket.trim();
    const normalizedRegion = region.trim();
    this.assertBucketAndRegion(normalizedBucket, normalizedRegion);

    return {
      secretId: secretId.trim(),
      secretKey: secretKey.trim(),
      bucket: normalizedBucket,
      region: normalizedRegion,
      domain: this.normalizeDomain(rawDomain),
    };
  }

  /**
   * 校验 COS 存储桶与区域格式
   * @param bucket COS bucket 名称，必须含 APPID 后缀
   * @param region COS 区域，必须使用 ap- 前缀
   * @returns 无返回值；格式不合法时抛出服务不可用异常
   * @description 在请求 SDK 签名之前拒绝错误配置，避免生成不能使用的上传地址。
   */
  private assertBucketAndRegion(bucket: string, region: string): void {
    if (!COS_BUCKET_PATTERN.test(bucket) || !COS_REGION_PATTERN.test(region)) {
      throw new ServiceUnavailableException(
        'COS 对象存储配置无效：COS_BUCKET 必须是含 -appid 后缀的小写 bucket 名，COS_REGION 必须形如 ap-guangzhou',
      );
    }
  }

  /**
   * 规范化 COS 对象访问域名
   * @param rawDomain 环境变量中的 CDN 或 COS 访问域名
   * @returns 返回不含路径、查询参数和尾部斜杠的 HTTP(S) 域名基址
   * @description 访问 URL 只允许由域名与服务端生成的 key 组成，避免环境配置中携带路径或凭据后改变对象访问路径。
   */
  private normalizeDomain(rawDomain: string): string {
    const candidate = rawDomain.trim();
    const value = /^https?:\/\//i.test(candidate)
      ? candidate
      : `https://${candidate}`;

    try {
      const url = new URL(value);
      const hasOnlyOrigin =
        /^\/+$/u.test(url.pathname) &&
        !url.search &&
        !url.hash &&
        !url.username &&
        !url.password;

      if (
        (url.protocol !== 'https:' && url.protocol !== 'http:') ||
        !url.hostname ||
        !hasOnlyOrigin
      ) {
        throw new Error('invalid COS bucket domain');
      }

      return url.origin;
    } catch {
      throw new ServiceUnavailableException(
        'COS 对象存储配置无效：COS_BUCKET_DOMAIN 必须是纯 HTTP(S) 域名',
      );
    }
  }

  /**
   * 拼接安全的 COS 公有读地址
   * @param domain 已规范化的 COS 或 CDN 域名
   * @param key 对象 key
   * @returns 返回可直接访问的对象 URL
   * @description key 逐段保留目录结构并编码特殊字符，禁止相对路径、协议片段和绝对路径。
   */
  private buildAccessUrl(domain: string, key: string): string {
    this.assertSafeKey(key);
    const encodedKey = key.split('/').map(encodeURIComponent).join('/');
    return `${domain}/${encodedKey}`;
  }

  /**
   * 校验对象 key 不会改变访问域名或逃逸对象目录
   * @param key 待解析的对象 key
   * @returns 无返回值；非法 key 抛出请求错误
   */
  private assertSafeKey(key: string): void {
    if (
      !key ||
      key.includes('..') ||
      key.includes('://') ||
      key.startsWith('/')
    ) {
      throw new BadRequestException('非法的对象 key');
    }
  }
}
