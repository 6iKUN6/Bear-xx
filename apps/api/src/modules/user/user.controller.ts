import { Controller, Get, Patch, Body, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiOkResponse,
} from '@nestjs/swagger';
import { UserService } from './user.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UserProfileDto } from './dto/user-profile.dto';

@ApiTags('用户')
@ApiBearerAuth()
@Controller('user')
@UseGuards(JwtAuthGuard)
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get('profile')
  @ApiOperation({ summary: '获取当前用户信息' })
  @ApiOkResponse({
    description: '当前用户信息',
    type: UserProfileDto,
  })
  async getProfile(@CurrentUser('id') userId: string) {
    const user = await this.userService.findById(userId);
    if (!user) return null;
    return {
      id: user.id,
      nickname: user.nickname,
      avatarUrl: user.avatarUrl,
    };
  }

  @Patch('profile')
  @ApiOperation({ summary: '更新用户资料', description: '可更新昵称和头像' })
  @ApiOkResponse({
    description: '更新后的用户信息',
    type: UserProfileDto,
  })
  async updateProfile(
    @CurrentUser('id') userId: string,
    @Body() body: UpdateProfileDto,
  ) {
    const user = await this.userService.updateProfile(userId, body);
    return {
      id: user.id,
      nickname: user.nickname,
      avatarUrl: user.avatarUrl,
    };
  }
}
