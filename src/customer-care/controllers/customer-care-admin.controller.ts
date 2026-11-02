import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { SupportIncident } from '../schemas/support-incident.schema';
import { SupportActionAudit } from '../schemas/support-action-audit.schema';
import { CustomerCareBroadcast } from '../schemas/customer-care-broadcast.schema';
import { CustomerCareJob } from '../schemas/customer-care-job.schema';
import { SupportConversation } from '../schemas/support-conversation.schema';
import { CustomerCareService } from '../services/customer-care.service';
import { CustomerCareMonitorService } from '../services/customer-care-monitor.service';
import { UpdateSupportIncidentDto } from '../dto/update-support-incident.dto';
import { RetryCustomerCareBroadcastDto } from '../dto/retry-customer-care-broadcast.dto';
import { SendAdminSupportReplyDto } from '../dto/send-admin-support-reply.dto';

@Controller('admin/customer-care')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class CustomerCareAdminController {
  constructor(
    private readonly customerCare: CustomerCareService,
    private readonly monitor: CustomerCareMonitorService,
    @InjectModel(SupportIncident.name) private readonly incidents: Model<SupportIncident>,
    @InjectModel(SupportActionAudit.name) private readonly actions: Model<SupportActionAudit>,
    @InjectModel(CustomerCareBroadcast.name) private readonly broadcasts: Model<CustomerCareBroadcast>,
    @InjectModel(CustomerCareJob.name) private readonly jobs: Model<CustomerCareJob>,
    @InjectModel(SupportConversation.name) private readonly conversations: Model<SupportConversation>,
  ) {}

  @Get('monitor')
  getMonitor() { return this.monitor.getOverview(); }

  @Get('inbox/summary')
  getInboxSummary(@GetUser() admin: { _id?: unknown }) {
    return this.customerCare.getAdminInboxSummary(String(admin?._id ?? ''));
  }

  @Get('inbox')
  getInbox(
    @GetUser() admin: { _id?: unknown },
    @Query('view') view?: string,
    @Query('limit') limit?: string,
  ) {
    return this.customerCare.getAdminInbox(String(admin?._id ?? ''), view, Number(limit) || 50);
  }

  @Post('conversations/:id/claim')
  claimConversation(@GetUser() admin: { _id?: unknown }, @Param('id') id: string) {
    return this.customerCare.claimAdminConversation(String(admin?._id ?? ''), id);
  }

  @Post('conversations/:id/reply')
  replyToConversation(
    @GetUser() admin: { _id?: unknown },
    @Param('id') id: string,
    @Body() body: SendAdminSupportReplyDto,
  ) {
    return this.customerCare.replyToAdminConversation(
      String(admin?._id ?? ''),
      id,
      body.message,
      body.clientMessageId,
    );
  }

  @Post('conversations/:id/read')
  markConversationRead(@GetUser() admin: { _id?: unknown }, @Param('id') id: string) {
    return this.customerCare.markAdminConversationRead(String(admin?._id ?? ''), id);
  }

  @Post('conversations/:id/release')
  releaseConversation(@GetUser() admin: { _id?: unknown }, @Param('id') id: string) {
    return this.customerCare.releaseAdminConversation(String(admin?._id ?? ''), id);
  }

  @Post('conversations/:id/resolve')
  resolveConversation(@GetUser() admin: { _id?: unknown }, @Param('id') id: string) {
    return this.customerCare.resolveAdminConversation(String(admin?._id ?? ''), id);
  }

  @Get('conversations')
  async listConversations(@Query('limit') limit?: string, @Query('status') status?: string) {
    const safeLimit = boundedLimit(limit, 50);
    const filter: Record<string, unknown> = { retentionDeleting: { $ne: true } };
    if (status && ['OPEN', 'RESOLVED', 'CLOSED'].includes(status.toUpperCase())) filter.status = status.toUpperCase();
    const [items, total] = await Promise.all([
      this.conversations.find(filter).sort({ lastMessageAt: -1 }).limit(safeLimit).lean().exec(),
      this.conversations.countDocuments(filter).exec(),
    ]);
    return { items, total, limit: safeLimit };
  }

  @Get('conversations/:id')
  getConversation(@Param('id') id: string) { return this.customerCare.getAdminConversation(id); }

  @Get('incidents/:id')
  async getIncident(@Param('id') id: string) {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('Invalid incident ID.');
    const incident = await this.incidents.findById(id).lean().exec();
    if (!incident) throw new NotFoundException('Support incident was not found.');
    return incident;
  }

  @Get('incidents')
  async listIncidents(@Query('limit') limit?: string, @Query('status') status?: string, @Query('severity') severity?: string) {
    const safeLimit = boundedLimit(limit, 50);
    const filter: Record<string, unknown> = {};
    if (status && ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'].includes(status.toUpperCase())) filter.status = status.toUpperCase();
    if (severity && ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(severity.toUpperCase())) filter.severity = severity.toUpperCase();
    const [items, total] = await Promise.all([
      this.incidents.find(filter).sort({ lastSeenAt: -1, severity: -1 }).limit(safeLimit).lean().exec(),
      this.incidents.countDocuments(filter).exec(),
    ]);
    return { items, total, limit: safeLimit };
  }

  @Patch('incidents/:id')
  async updateIncident(@Param('id') id: string, @Body() body: UpdateSupportIncidentDto, @GetUser() admin?: { _id?: unknown }) {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('Invalid incident ID.');
    const incident = await this.incidents.findById(id).exec();
    if (!incident) throw new NotFoundException('Support incident was not found.');
    if (body.status) {
      incident.status = body.status;
      if (body.status === 'RESOLVED' || body.status === 'CLOSED') incident.resolvedAt = new Date();
    }
    if (typeof body.resolutionNotes === 'string') incident.resolutionNotes = body.resolutionNotes.trim().slice(0, 3000);
    await incident.save();
    await this.actions.create({
      ...(admin?._id && Types.ObjectId.isValid(String(admin._id)) ? { actorId: new Types.ObjectId(String(admin._id)) } : {}),
      actorRole: 'ADMIN',
      actionName: 'admin_updated_incident', actionType: 'ESCALATION', outcome: 'SUCCEEDED',
      summary: `Administrator updated incident ${id}.`, details: { status: incident.status }, durationMs: 0,
    });
    return incident.toObject();
  }

  @Get('actions')
  async listActions(@Query('limit') limit?: string, @Query('type') type?: string, @Query('outcome') outcome?: string) {
    const filter: Record<string, unknown> = {};
    if (type && ['DIAGNOSTIC', 'REPAIR', 'ESCALATION', 'BROADCAST'].includes(type.toUpperCase())) filter.actionType = type.toUpperCase();
    if (outcome && ['STARTED', 'SUCCEEDED', 'FAILED', 'DENIED', 'SKIPPED'].includes(outcome.toUpperCase())) filter.outcome = outcome.toUpperCase();
    return this.actions.find(filter).sort({ createdAt: -1 }).limit(boundedLimit(limit, 100)).lean().exec();
  }

  @Get('broadcasts')
  async listBroadcasts(@Query('limit') limit?: string, @Query('status') status?: string) {
    const filter: Record<string, unknown> = {};
    if (status && ['GENERATING', 'READY', 'SENDING', 'SENT', 'SKIPPED', 'FAILED'].includes(status.toUpperCase())) filter.status = status.toUpperCase();
    return this.broadcasts.find(filter).sort({ updatedAt: -1 }).limit(boundedLimit(limit, 100)).lean().exec();
  }

  @Post('broadcasts/:id/retry')
  async retryBroadcast(
    @Param('id') id: string,
    @Body() body: RetryCustomerCareBroadcastDto,
    @GetUser() admin?: { _id?: unknown },
  ) {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('Invalid broadcast ID.');
    const broadcast = await this.broadcasts.findById(id).exec();
    if (!broadcast) throw new NotFoundException('Customer Care broadcast was not found.');
    if (broadcast.status === 'SENT' || broadcast.status === 'SKIPPED') {
      throw new BadRequestException('A sent or skipped broadcast cannot be retried.');
    }
    if (broadcast.manualReviewRequired && body?.confirmNotPosted !== true) {
      throw new BadRequestException('Check the public Telegram channel first, then confirm that the message was not posted.');
    }

    // Explicit admin confirmation is required only when the Telegram response
    // was ambiguous. This prevents blind duplicate posts on timeout/restart.
    broadcast.manualReviewRequired = false;
    broadcast.status = 'FAILED';
    broadcast.lastError = '';
    await broadcast.save();

    const type = broadcast.kind === 'DAILY_PICKS' ? 'DAILY_PICKS' : 'PROMOTION';
    const jobKey = `${type}:${broadcast.dateKey}`;
    const now = new Date();
    await this.jobs.updateOne(
      { jobKey },
      { $set: { type, dateKey: broadcast.dateKey, sourceId: '', payload: {}, status: 'PENDING', scheduledAt: now, attempts: 0, lastError: '' }, $unset: { leaseExpiresAt: 1, completedAt: 1 }, $setOnInsert: { jobKey } },
      { upsert: true },
    ).exec();
    await this.actions.create({
      ...(admin?._id && Types.ObjectId.isValid(String(admin._id)) ? { actorId: new Types.ObjectId(String(admin._id)) } : {}),
      actorRole: 'ADMIN', actionName: 'admin_retried_broadcast', actionType: 'BROADCAST', outcome: 'SUCCEEDED',
      summary: `Administrator queued broadcast ${String(broadcast._id)} for retry.`,
      details: { broadcastId: String(broadcast._id), kind: broadcast.kind, dateKey: broadcast.dateKey, confirmedNotPosted: body?.confirmNotPosted === true }, durationMs: 0,
    });
    return { broadcastId: String(broadcast._id), jobKey, status: 'PENDING', scheduledAt: now };
  }

  @Post('jobs/:id/retry')
  async retryJob(@Param('id') id: string, @GetUser() admin?: { _id?: unknown }) {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('Invalid job ID.');
    const job = await this.jobs.findById(id).exec();
    if (!job) throw new NotFoundException('Customer Care job was not found.');
    if (job.status !== 'FAILED') throw new BadRequestException('Only failed jobs can be manually retried.');
    if (job.type === 'DAILY_PICKS' || job.type === 'PROMOTION') {
      const kind = job.type === 'DAILY_PICKS' ? 'DAILY_PICKS' : 'PROMOTION';
      const broadcast = await this.broadcasts.findOne({ kind, dateKey: job.dateKey, sourceKey: 'daily' }).lean().exec();
      if (broadcast?.manualReviewRequired) {
        throw new BadRequestException('This broadcast has an uncertain Telegram delivery result. Use the broadcast retry endpoint after checking the public channel.');
      }
    }
    job.status = 'PENDING';
    job.attempts = 0;
    job.scheduledAt = new Date();
    job.lastError = '';
    job.leaseExpiresAt = undefined;
    job.completedAt = undefined;
    await job.save();
    await this.actions.create({
      ...(admin?._id && Types.ObjectId.isValid(String(admin._id)) ? { actorId: new Types.ObjectId(String(admin._id)) } : {}),
      actorRole: 'ADMIN',
      actionName: 'admin_retried_job',
      actionType: ['INCIDENT_ALERT', 'SUPPORT_NOTIFICATION'].includes(job.type) ? 'ESCALATION' : 'BROADCAST',
      outcome: 'SUCCEEDED',
      summary: `Administrator queued failed job ${job.jobKey} for retry.`,
      details: { jobId: String(job._id), jobType: job.type },
      durationMs: 0,
    });
    return { jobId: String(job._id), status: job.status, scheduledAt: job.scheduledAt };
  }

  @Get('jobs')
  async listJobs(@Query('limit') limit?: string, @Query('status') status?: string) {
    const filter: Record<string, unknown> = {};
    if (status && ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'].includes(status.toUpperCase())) filter.status = status.toUpperCase();
    return this.jobs.find(filter).sort({ scheduledAt: -1 }).limit(boundedLimit(limit, 100)).lean().exec();
  }
}

function boundedLimit(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(200, Math.floor(parsed)) : fallback;
}
