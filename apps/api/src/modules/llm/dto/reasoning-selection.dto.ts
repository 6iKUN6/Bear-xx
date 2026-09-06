import { IsIn, IsInt, IsOptional, Min, ValidateIf } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
  PersistedReasoningConfig,
  ReasoningSelection,
} from '@litter-bear/types';
import type { LlmReasoningCapability } from '../llm.types';
import { Prisma } from '@prisma/client';
import {
  persistedReasoningConfigSchema,
  reasoningSelectionSchema,
  REASONING_EFFORT_VALUES,
} from '../model-reasoning.schema';

export class ReasoningSelectionDto implements ReasoningSelection {
  @ApiPropertyOptional({ enum: ['enabled', 'disabled', 'auto'] })
  @IsOptional()
  @IsIn(['enabled', 'disabled', 'auto'])
  activation?: 'enabled' | 'disabled' | 'auto';

  @ApiPropertyOptional({ enum: REASONING_EFFORT_VALUES })
  @IsOptional()
  @IsIn(REASONING_EFFORT_VALUES)
  effort?: (typeof REASONING_EFFORT_VALUES)[number];

  @ApiPropertyOptional({
    oneOf: [
      { type: 'integer', minimum: 1 },
      { type: 'string', enum: ['auto'] },
    ],
  })
  @IsOptional()
  @ValidateIf((_object, value: unknown) => value !== 'auto')
  @IsInt()
  @Min(1)
  budgetTokens?: number | 'auto';
}

/** 可嵌入其他 DTO 的 reasoning 字段校验装饰器所需类型。 */
export class ReasoningActivationCapabilityDto {
  @ApiProperty({ enum: ['enabled', 'disabled', 'auto'], isArray: true })
  values: readonly ('enabled' | 'disabled' | 'auto')[];
  @ApiProperty({ enum: ['enabled', 'disabled', 'auto'] })
  defaultValue: 'enabled' | 'disabled' | 'auto';
  @ApiProperty() configurable: boolean;
}

export class ReasoningEffortCapabilityDto {
  @ApiProperty({ enum: REASONING_EFFORT_VALUES, isArray: true })
  values: readonly (typeof REASONING_EFFORT_VALUES)[number][];
  @ApiProperty({ enum: REASONING_EFFORT_VALUES })
  defaultValue: (typeof REASONING_EFFORT_VALUES)[number];
  @ApiProperty() configurable: boolean;
}

export class ReasoningBudgetCapabilityDto {
  @ApiProperty() supportsAuto: boolean;
  @ApiPropertyOptional() minimum?: number;
  @ApiPropertyOptional() maximum?: number;
  @ApiPropertyOptional() lessThanMaxOutputTokens?: boolean;
  @ApiProperty({
    oneOf: [{ type: 'integer' }, { type: 'string', enum: ['auto'] }],
  })
  defaultValue: number | 'auto';
  @ApiProperty() configurable: boolean;
}

/** 服务端能力目录向客户端暴露的只读安全投影。 */
export class ModelReasoningCapabilityDto implements LlmReasoningCapability {
  @ApiPropertyOptional({ type: ReasoningActivationCapabilityDto })
  activation?: ReasoningActivationCapabilityDto;
  @ApiPropertyOptional({ type: ReasoningEffortCapabilityDto })
  effort?: ReasoningEffortCapabilityDto;
  @ApiPropertyOptional({ type: ReasoningBudgetCapabilityDto })
  budget?: ReasoningBudgetCapabilityDto;
  @ApiPropertyOptional({ type: ReasoningSelectionDto })
  defaultSelection?: ReasoningSelectionDto;
  @ApiProperty({ enum: ['allowed', 'forbidden', 'forbidden_when_enabled'] })
  temperaturePolicy: 'allowed' | 'forbidden' | 'forbidden_when_enabled';
  @ApiProperty({ enum: ['allowed', 'forbidden', 'forbidden_when_enabled'] })
  topPPolicy: 'allowed' | 'forbidden' | 'forbidden_when_enabled';
}

export function parseReasoningSelection(
  value: unknown,
): ReasoningSelection | undefined {
  return value === undefined
    ? undefined
    : reasoningSelectionSchema.parse(value);
}

export function parsePersistedReasoningConfig(
  value: unknown,
): PersistedReasoningConfig | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return persistedReasoningConfigSchema.parse(value);
}

/** 将已校验选择转换为 Prisma 接受的 JSON 对象，不靠宽泛类型断言。 */
export function toPersistedReasoningJson(
  selection: ReasoningSelection,
): Prisma.InputJsonObject {
  const payload = {
    ...(selection.activation !== undefined
      ? { activation: selection.activation }
      : {}),
    ...(selection.effort !== undefined ? { effort: selection.effort } : {}),
    ...(selection.budgetTokens !== undefined
      ? { budgetTokens: selection.budgetTokens }
      : {}),
  } satisfies Prisma.InputJsonObject;
  return { version: 1, selection: payload };
}
