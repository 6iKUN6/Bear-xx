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

/**
 * 腾讯云 COS 对象存储
 * @description 使用官方 SDK 仅签发单对象 HTTPS PUT 预签名 URL；文件本体由小程序直传，
 * 既有七牛上传及 StorageAsset 资产登记链路保持不变。
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
      accessUrl: `${config.domain}/${key}`,
      headers,
      expiresAt: Date.now() + UPLOAD_URL_TTL_SECONDS * 1000,
    };
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

  /**
   * 读取并校验 COS 配置
   * @returns 返回签发预签名 URL 所需的 COS 凭据、空间、区域和访问域名
   * @description 配置校验延迟到实际调用，缺失配置不会影响 API 启动或七牛上传链路。
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
}
