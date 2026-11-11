import {
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { NotificationQueryDto } from './dto/notification-query.dto';
import { UserNotificationsService } from './user-notifications.service';

interface AuthenticatedUser {
  _id: string;
}

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class UserNotificationsController {
  constructor(
    private readonly notificationsService: UserNotificationsService,
  ) {}

  @Get()
  list(
    @GetUser() user: AuthenticatedUser,
    @Query() query: NotificationQueryDto,
  ) {
    return this.notificationsService.listForUser(user._id, query);
  }

  @Get('unread-count')
  unreadCount(@GetUser() user: AuthenticatedUser) {
    return this.notificationsService.getUnreadCount(user._id);
  }

  @Patch('read-all')
  markAllAsRead(@GetUser() user: AuthenticatedUser) {
    return this.notificationsService.markAllAsRead(user._id);
  }

  @Patch(':id/read')
  markAsRead(
    @GetUser() user: AuthenticatedUser,
    @Param('id') notificationId: string,
  ) {
    return this.notificationsService.markAsRead(user._id, notificationId);
  }
}
