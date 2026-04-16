import { IsString, IsNotEmpty, IsEnum, IsOptional } from 'class-validator';

export class EnvConfig {
  @IsOptional()
  @IsString()
  PORT?: string;

  @IsOptional()
  @IsEnum(['development', 'production', 'test'])
  NODE_ENV?: string;

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
  AI_WHISPER_MODEL?: string;

  @IsOptional()
  @IsString()
  AI_IMAGE_MODEL?: string;
}
