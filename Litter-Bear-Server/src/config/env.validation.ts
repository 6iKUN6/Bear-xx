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
}
