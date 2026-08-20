import { plainToInstance } from 'class-transformer';
import {
  IsString,
  IsNotEmpty,
  IsEnum,
  IsOptional,
  Matches,
  ValidateIf,
  validateSync,
} from 'class-validator';

export class EnvConfig {
  @IsOptional()
  @IsString()
  PORT?: string;

  @IsOptional()
  @IsEnum(['development', 'production', 'test'])
  NODE_ENV?: string;

  @IsOptional()
  @IsString()
  LOG_LEVEL?: string;

  @IsOptional()
  @IsString()
  LOG_PRETTY?: string;

  @IsOptional()
  @IsString()
  LOG_TO_FILE?: string;

  @IsOptional()
  @IsString()
  LOG_FILE_PATH?: string;

  @IsString()
  @IsNotEmpty()
  DATABASE_URL: string;

  @IsString()
  @IsNotEmpty()
  REDIS_HOST: string;

  @IsOptional()
  @IsString()
  REDIS_PORT?: string;

  @IsOptional()
  @IsString()
  REDIS_PASSWORD?: string;

  @IsString()
  @IsNotEmpty()
  JWT_ACCESS_SECRET: string;

  @IsString()
  @IsNotEmpty()
  JWT_REFRESH_SECRET: string;

  @IsOptional()
  @IsString()
  JWT_ACCESS_EXPIRES_IN?: string;

  @IsOptional()
  @IsString()
  JWT_REFRESH_EXPIRES_IN?: string;

  @IsOptional()
  @IsString()
  OPENAI_API_KEY?: string;

  @IsOptional()
  @IsString()
  OPENAI_BASE_URL?: string;

  @IsOptional()
  @IsString()
  OPENAI_MODEL?: string;

  @IsOptional()
  @IsString()
  ANTHROPIC_API_KEY?: string;

  @IsOptional()
  @IsString()
  ANTHROPIC_BASE_URL?: string;

  @IsOptional()
  @IsString()
  ANTHROPIC_MODEL?: string;

  @IsOptional()
  @IsString()
  DEEPSEEK_API_KEY?: string;

  @IsOptional()
  @IsString()
  DEEPSEEK_BASE_URL?: string;

  @IsOptional()
  @IsString()
  DEEPSEEK_MODEL?: string;

  @IsOptional()
  @IsString()
  KIMI_API_KEY?: string;

  @IsOptional()
  @IsString()
  KIMI_BASE_URL?: string;

  @IsOptional()
  @IsString()
  KIMI_MODEL?: string;

  @IsOptional()
  @IsString()
  DOUBAO_API_KEY?: string;

  @IsOptional()
  @IsString()
  DOUBAO_BASE_URL?: string;

  @IsOptional()
  @IsString()
  DOUBAO_MODEL?: string;

  /**
   * 模型预设 apiKey 的加密主密钥
   * @description 必填且无降级路径：模型配置的唯一来源是 model_presets 表的密文，缺了它
   * 一次模型调用都发不出去。设为可选会让「配置缺失」延迟到管理员保存预设或首次模型调用时
   * 才暴露，与启动即失败相比排查成本高得多。
   * 字符集在此校验，解码后必须为 32 字节由 LlmCredentialCryptoService.requireKey 断言。
   */
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Za-z0-9+/]+={0,2}$/)
  LLM_CREDENTIAL_ENCRYPTION_KEY: string;

  @IsOptional()
  @IsString()
  LLM_DEFAULT_MODEL_ID?: string;

  @IsOptional()
  @IsString()
  LLM_MODEL?: string;

  @IsOptional()
  @IsString()
  LLM_MODEL_PRESETS?: string;

  @IsOptional()
  @IsString()
  LLM_MAX_RETRIES?: string;

  @IsOptional()
  @IsString()
  LLM_TIMEOUT_MS?: string;

  @IsOptional()
  @IsString()
  LLM_DEBUG?: string;

  @IsOptional()
  @IsString()
  LLM_DEBUG_CHUNKS?: string;

  @IsOptional()
  @IsString()
  LLM_DEBUG_CHUNK_PREVIEW_LENGTH?: string;

  @IsOptional()
  @IsString()
  LLM_DEBUG_TIMEOUT_MS?: string;

  @IsOptional()
  @IsString()
  LLM_DEBUG_PROVIDER?: string;

  @IsOptional()
  @IsString()
  TAVILY_API_KEY?: string;

  @IsOptional()
  @IsString()
  COS_SECRET_ID?: string;

  @IsOptional()
  @IsString()
  COS_SECRET_KEY?: string;

  @IsOptional()
  @IsString()
  COS_BUCKET?: string;

  @IsOptional()
  @IsString()
  COS_REGION?: string;

  @IsOptional()
  @IsString()
  COS_BUCKET_DOMAIN?: string;

  @IsOptional()
  @IsString()
  AI_WHISPER_MODEL?: string;

  @IsOptional()
  @IsString()
  AI_IMAGE_MODEL?: string;

  // ---- AI 生图 provider（独立于聊天模型；留白则激活 provider 返回 503）----
  @IsOptional()
  @IsString()
  IMAGE_GEN_PROVIDER?: string;

  @IsOptional()
  @IsString()
  IMAGE_GEN_BASE_URL?: string;

  @IsOptional()
  @IsString()
  IMAGE_GEN_API_KEY?: string;

  @IsOptional()
  @IsString()
  IMAGE_GEN_MODEL?: string;

  @IsOptional()
  @IsString()
  IMAGE_GEN_SEEDREAM_BASE_URL?: string;

  @IsOptional()
  @IsString()
  IMAGE_GEN_SEEDREAM_API_KEY?: string;

  @IsOptional()
  @IsString()
  IMAGE_GEN_SEEDREAM_MODEL?: string;

  @IsOptional()
  @IsString()
  MCDONALDS_MCP_URL?: string;

  @IsOptional()
  @IsString()
  MCDONALDS_MCP_TOOL_PREFIX?: string;

  @IsOptional()
  @IsString()
  TEMPORAL_ADDRESS?: string;

  @IsOptional()
  @IsString()
  TEMPORAL_NAMESPACE?: string;

  @IsOptional()
  @IsString()
  TEMPORAL_TASK_QUEUE?: string;

  @IsOptional()
  @IsString()
  TEMPORAL_ORCHESTRATOR_TASK_QUEUE?: string;

  @IsOptional()
  @IsString()
  TEMPORAL_ACTIVITY_TASK_QUEUE?: string;

  @IsOptional()
  @IsString()
  TEMPORAL_API_KEY?: string;

  @IsOptional()
  @Matches(/^(true|false)$/)
  TEMPORAL_TLS?: string;

  @ValidateIf(
    (config: EnvConfig) =>
      config.MCDONALDS_CREDENTIAL_ENCRYPTION_KEY !== undefined &&
      config.MCDONALDS_CREDENTIAL_ENCRYPTION_KEY !== '',
  )
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Za-z0-9+/]+={0,2}$/)
  MCDONALDS_CREDENTIAL_ENCRYPTION_KEY?: string;

  @ValidateIf(
    (config: EnvConfig) =>
      config.MCDONALDS_PAYMENT_URL_ENCRYPTION_KEY !== undefined &&
      config.MCDONALDS_PAYMENT_URL_ENCRYPTION_KEY !== '',
  )
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Za-z0-9+/]+={0,2}$/)
  MCDONALDS_PAYMENT_URL_ENCRYPTION_KEY?: string;
}

/**
 * 校验应用环境变量
 * @param config 原始环境变量键值对
 * @returns 返回已转换并通过校验的环境变量对象
 * @description 放在本文件而非 config.module.ts：后者的 `NestConfigModule.forRoot()`
 * 在 import 期就会读取 .env 并跑一次校验，测试只要 import 那个模块就会撞上开发者本机的
 * 真实环境，导致用例结果取决于 .env 内容而非入参。
 */
export function validateEnvironment(config: Record<string, unknown>) {
  const validated = plainToInstance(EnvConfig, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    throw new Error(`Config validation error:\n${errors.toString()}`);
  }
  return validated;
}
