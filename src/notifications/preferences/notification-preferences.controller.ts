import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { NotificationPreferencesService } from './notification-preferences.service';
import type { UpdateNotificationPreferencesInput } from './notification-preferences.service';

interface AuthenticatedUser {
  _id: string;
}

@Controller('notifications/preferences')
@UseGuards(JwtAuthGuard)
export class NotificationPreferencesController {
  constructor(
    private readonly preferencesService: NotificationPreferencesService,
  ) {}

  @Get()
  getPreferences(@GetUser() user: AuthenticatedUser) {
    return this.preferencesService.getForUser(user._id);
  }

  @Patch()
  updatePreferences(
    @GetUser() user: AuthenticatedUser,
    @Body() body: UpdateNotificationPreferencesInput,
  ) {
    return this.preferencesService.updateForUser(user._id, body);
  }
}
