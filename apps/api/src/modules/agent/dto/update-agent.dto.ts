import { PartialType } from '@nestjs/swagger';
import { CreateAgentDto } from './create-agent.dto';

/** 更新智能体：全部字段可选（isDefault 由 seed 管理，不经此更新） */
export class UpdateAgentDto extends PartialType(CreateAgentDto) {}
