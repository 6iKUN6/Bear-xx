import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * 模型预设 apiKey 的静态加密服务
 * @description 主密钥独立于麦当劳凭据与支付链接的密钥：三者爆炸半径分离，任一泄露或轮换
 * 都不牵连另外两个。密文格式带版本前缀，换算法或轮换密钥时可按前缀分流而不必一次性重写全表。
 */
@Injectable()
export class LlmCredentialCryptoService {
  constructor(private readonly configService: ConfigService) {}

  /**
   * 加密模型预设的 apiKey
   * @param apiKey 待加密的 apiKey 明文
   * @returns 返回版本化 AES-256-GCM 密文
   * @description 明文只在后台写入与解析模型请求这两个瞬间存在，不进日志、不进响应体。
   */
  encrypt(apiKey: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.requireKey(), iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    const ciphertext = Buffer.concat([
      cipher.update(apiKey, 'utf8'),
      cipher.final(),
    ]);
    return [
      VERSION,
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  /**
   * 解密已保存的 apiKey
   * @param ciphertext 已保存的版本化密文
   * @returns 返回仅供当次模型调用使用的 apiKey 明文
   * @description 密文损坏或主密钥已轮换时直接抛错，绝不回退到空 key 或环境变量：静默降级会让
   * 一次密钥事故表现为“模型莫名不可用”，排查成本远高于直接失败。
   */
  decrypt(ciphertext: string): string {
    const [version, ivText, authTagText, encryptedText, ...rest] =
      ciphertext.split('.');
    if (
      version !== VERSION ||
      !ivText ||
      !authTagText ||
      !encryptedText ||
      rest.length > 0
    ) {
      throw new Error('模型预设 apiKey 密文格式非法，请在后台重新填写');
    }
    try {
      const decipher = createDecipheriv(
        ALGORITHM,
        this.requireKey(),
        Buffer.from(ivText, 'base64url'),
        { authTagLength: AUTH_TAG_LENGTH },
      );
      decipher.setAuthTag(Buffer.from(authTagText, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(encryptedText, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new Error(
        '模型预设 apiKey 解密失败：密文已损坏或加密主密钥已变更，请在后台重新填写',
      );
    }
  }

  /**
   * 生成 apiKey 的不可逆指纹
   * @param apiKey apiKey 明文
   * @returns 返回 SHA-256 十六进制摘要
   * @description 用于判断后台提交的 key 是否真的发生变化（相同则不必重写密文与重置探测结果），
   * 以及生成脱敏展示标识；不能用于恢复 apiKey。
   */
  fingerprint(apiKey: string): string {
    return createHash('sha256').update(apiKey, 'utf8').digest('hex');
  }

  /**
   * 返回可安全下发前端的 apiKey 标识
   * @param fingerprint apiKey 的 SHA-256 指纹
   * @returns 返回取自指纹尾部的脱敏标识
   * @description 后台不回显 apiKey 原文。这里刻意取指纹尾部而不是 key 本身的后几位：
   * 后者会泄露真实字符，在共享屏幕或截图场景下仍可能被用于比对。
   */
  toDisplayHint(fingerprint: string): string {
    return `Key ...${fingerprint.slice(-6)}`;
  }

  /**
   * 校验并读取 apiKey 加密主密钥
   * @returns 返回长度为 32 字节的 AES 密钥
   * @description 模型预设是唯一的模型配置入口，密钥缺失意味着所有模型都无法解析；此时必须
   * 明确报错而不是让系统看起来“没有可用模型”。
   */
  private requireKey(): Buffer {
    const encoded = this.configService
      .get<string>('LLM_CREDENTIAL_ENCRYPTION_KEY')
      ?.trim();
    const key = encoded ? Buffer.from(encoded, 'base64') : undefined;
    if (!key || key.length !== 32) {
      throw new Error(
        'LLM_CREDENTIAL_ENCRYPTION_KEY 必须是 base64 编码的 32 字节密钥',
      );
    }
    return key;
  }
}
