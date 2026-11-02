import {
  Controller,
  Get,
  Patch,
  Body,
  UseGuards,
  Delete,
} from '@nestjs/common';

import { UsersService } from './users.service';

import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { GetUser } from '../common/decorators/get-user.decorator';
import { UserSessionService } from '../user-session/user-session.service';

@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly sessionService: UserSessionService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Get('me')
  getProfile(@GetUser() user: any) {
    return this.usersService.findById(user._id);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('me')
  updateProfile(
    @GetUser() user: any,
    @Body()
    body: {
      fullName?: string;
      username?: string;
      phoneNumber?: string;
    },
  ) {
    return this.usersService.updateProfile(user._id, body);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('me')
  async deleteAccount(@GetUser() user: any) {
    await this.sessionService.deactivateAllUserSessions(user._id);

    return this.usersService.softDeleteUser(user._id);
  }
}

