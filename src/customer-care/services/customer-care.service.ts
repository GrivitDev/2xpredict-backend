import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { GroqAssistantService } from './groq-assistant.service';
import { SupportEscalationService } from './support-escalation.service';
import { SupportRateLimitService } from './support-rate-limit.service';
import { SupportConversation } from '../schemas/support-conversation.schema';
import {
  SupportMessage,
  type SupportMessageDocument,
} from '../schemas/support-message.schema';
import { SupportActionAudit } from '../schemas/support-action-audit.schema';
import { SupportIncident } from '../schemas/support-incident.schema';
import { CustomerCareReplyJob } from '../schemas/customer-care-reply-job.schema';

const QUEUED_ACKNOWLEDGEMENT =
  'Your message has been received. Customer Care is checking it now. Keep this conversation open; the reply will appear in the conversation shortly.';
const GROQ_FAILURE_REPLY =
  'I’m having trouble checking that just now. Please try again shortly.';

// New conversations use the names established by the customer-facing persona.
// Legacy names remain valid so existing conversations never unexpectedly change identity.
const SUPPORT_ASSISTANT_NAMES = [
  'Chloe',
  'Favor',
  'Grace',
  'Esther',
  'Olivia',
  'Hannah',
] as const;

const LEGACY_SUPPORT_ASSISTANT_NAMES = [
  'Serena',
  'Talia',
  'Kaira',
  'Zara',
  'Nadia',
] as const;

type SupportAssistantName =
  | (typeof SUPPORT_ASSISTANT_NAMES)[number]
  | (typeof LEGACY_SUPPORT_ASSISTANT_NAMES)[number];

function chooseSupportAssistantName(): SupportAssistantName {
  return SUPPORT_ASSISTANT_NAMES[
    Math.floor(Math.random() * SUPPORT_ASSISTANT_NAMES.length)
  ];
}

function isSupportAssistantName(value: string): value is SupportAssistantName {
  return (
    (SUPPORT_ASSISTANT_NAMES as readonly string[]).includes(value) ||
    (LEGACY_SUPPORT_ASSISTANT_NAMES as readonly string[]).includes(value)
  );
}

/**
 * Old assistant replies may predate the customer-facing response guard. Keep
 * those historical diagnostics out of customer API responses without rewriting
 * the stored message (the admin history remains available for audit purposes).
 */
function sanitizeCustomerVisibleSupportReply(
  value: unknown,
  assistantName: string,
  isFirstAssistantReply = false,
): string {
  const allowedName = isSupportAssistantName(assistantName)
    ? assistantName
    : 'Serena';
  let answer = typeof value === 'string' ? value.trim().slice(0, 8000) : '';
  if (!answer) return '';

  const verificationValues = [
    ...answer.matchAll(
      /\b(?:isVerified|is_verified|emailVerified|email_verified)\s*(?::|=)\s*(true|false)\b/gi,
    ),
  ].map((match) => match[1].toLowerCase());
  const hasOtherInternalField =
    /\b(?:userId|user_id|accountStatus|account_status|paymentStatus|payment_status|subscriptionStatus|subscription_status|verificationStatus|verification_status|walletBalance|wallet_balance)\b/i.test(
      answer,
    ) ||
    /\bstatus\s*(?::|=|\bis\b)\s*(?:true|false|null|undefined|["'][^"']*["']|[a-z0-9_.-]+)/i.test(
      answer,
    );
  const containsCodeOrTable = /```|^\s*\|.*\|\s*$/m.test(answer);
  const containsInternalVerificationField =
    /\b(?:isVerified|is_verified|emailVerified|email_verified)\b/i.test(answer);

  if (verificationValues.length && new Set(verificationValues).size === 1) {
    // Convert a known verification flag into a complete customer-facing answer;
    // discard the rest of the old diagnostic output rather than exposing it.
    answer =
      verificationValues[0] === 'true'
        ? 'I’ve confirmed that your email address is verified. If Bet Lab is still unavailable, tell me the exact message you see and I’ll help you with the next step.'
        : 'I’ve checked this for you, and your email address still needs to be verified. Please check your inbox for the verification link. If you can’t find it or it has expired, tell me and I’ll guide you through the next step.';
  } else if (
    containsInternalVerificationField ||
    hasOtherInternalField ||
    containsCodeOrTable ||
    /```|\b(?:MongoDB|Mongoose|stack trace|internal diagnostic|tool output|database collection|schema field)\b/i.test(
      answer,
    )
  ) {
    answer =
      'I can’t confirm the result clearly enough to give you a reliable answer just yet. Please tell me the exact message you see in 2xPredict, and I’ll guide you through the next step.';
  }

  if (isFirstAssistantReply) {
    const alreadyIntroducedWithSavedName = new RegExp(
      `^\\s*(?:hi|hello)(?:\\s+there)?[,!\\s]+i['’]m\\s+${allowedName}\\b`,
      'i',
    ).test(answer);
    if (!alreadyIntroducedWithSavedName) {
      answer = answer
        .replace(
          /^\s*(?:(?:hi|hello)(?:\s+there)?|good morning|good afternoon|good evening)[,!\s.]+/i,
          '',
        )
        .replace(/^\s*(?:i am|i['’]m)\s+[a-z][a-z'-]*[.!?,\s]*/i, '')
        .trim();
      if (!answer)
        return `Hi, I'm ${allowedName}. How can I help you with 2xPredict today?`;
      answer = answer.charAt(0).toUpperCase() + answer.slice(1);
      answer = `Hi, I'm ${allowedName}. ${answer}`;
    }
  }

  return answer;
}

type ConversationState = {
  _id: Types.ObjectId;
  userId?: Types.ObjectId;
  status: string;
  category: string;
  lastMessageAt?: Date;
  summary: string;
  assistantName?: string;
  retentionDeleting?: boolean;
  humanSupportStatus?: string;
  assignedAdminId?: Types.ObjectId;
  lastCustomerMessageAt?: Date;
  lastSupportReplyAt?: Date;
  customerLastReadAt?: Date;
  adminLastReadAt?: Date;
  save(): Promise<unknown>;
};

type MessageState = {
  _id: Types.ObjectId;
  conversationId: Types.ObjectId;
  userId: Types.ObjectId;
  content: string;
  createdAt?: Date;
  replyStatus?: string;
  metadata?: unknown;
  idempotencyKey?: string;
  save(): Promise<unknown>;
};

type MessageRecord = {
  _id: Types.ObjectId;
  role: string;
  content?: string;
  createdAt?: Date;
  metadata?: unknown;
};

type ReplyJobState = {
  _id?: Types.ObjectId;
  status?: string;
  attempts?: number;
  scheduledAt?: Date;
  lastError?: string;
  leaseExpiresAt?: Date;
  claimToken?: string;
  completedAt?: Date;
  save(): Promise<unknown>;
};

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function isFallbackMessage(value: unknown): boolean {
  return recordValue(recordValue(value).metadata).fallback === true;
}

function messageCreatedAt(value: unknown): Date | undefined {
  const createdAt = recordValue(value).createdAt;
  return createdAt instanceof Date ? createdAt : undefined;
}

function toMessageRecord(
  value:
    | (Partial<SupportMessage> & {
        _id: Types.ObjectId;
        role?: string;
        content?: string;
        createdAt?: Date;
        metadata?: unknown;
      })
    | null,
): MessageRecord | null {
  if (!value) return null;
  return {
    _id: value._id,
    role: String(value.role ?? 'USER'),
    content: typeof value.content === 'string' ? value.content : undefined,
    createdAt: value.createdAt ?? undefined,
    metadata: value.metadata,
  };
}

@Injectable()
export class CustomerCareService {
  private readonly logger = new Logger(CustomerCareService.name);

  constructor(
    @InjectModel(SupportConversation.name)
    private readonly conversationModel: Model<SupportConversation>,
    @InjectModel(SupportMessage.name)
    private readonly messageModel: Model<SupportMessage>,
    @InjectModel(SupportActionAudit.name)
    private readonly auditModel: Model<SupportActionAudit>,
    @InjectModel(SupportIncident.name)
    private readonly incidentModel: Model<SupportIncident>,
    @InjectModel(CustomerCareReplyJob.name)
    private readonly replyJobs: Model<CustomerCareReplyJob>,
    private readonly groq: GroqAssistantService,
    private readonly escalation: SupportEscalationService,
    private readonly rateLimit: SupportRateLimitService,
  ) {}

  /**
   * Persist the customer message and durable reply job, then return immediately.
   * Pass a stable clientMessageId/Idempotency-Key when retrying a request.
   */
  async sendMessage(
    userId: string,
    text: string,
    conversationId?: string,
    requestId?: string,
  ): Promise<Record<string, unknown>> {
    this.assertUserId(userId);
    const rawMessage = String(text ?? '').trim();
    if (!rawMessage || rawMessage.length > 4000) {
      throw new BadRequestException(
        'A support message must contain 1–4000 characters.',
      );
    }
    const message = redactSupportMessage(rawMessage);
    if (!message) {
      throw new BadRequestException(
        'Please send a support message without passwords, OTPs, or access tokens.',
      );
    }

    const idempotencyKey = String(requestId ?? '').trim();
    if (
      idempotencyKey &&
      (idempotencyKey.length < 8 || idempotencyKey.length > 128)
    ) {
      throw new BadRequestException(
        'The client message ID must contain 8–128 characters.',
      );
    }

    // Idempotent retries return the original message state and do not consume a
    // second rate-limit slot or make another Groq request.
    if (idempotencyKey) {
      const existing = await this.messageModel
        .findOne({
          userId: new Types.ObjectId(userId),
          role: 'USER',
          idempotencyKey,
        })
        .exec();
      if (existing) {
        await this.ensureReplyJobForExistingMessage(existing);
        return this.acceptedMessageResponse(existing);
      }
    }

    // Atomically enforced by MongoDB across all API instances.
    await this.rateLimit.consume(userId);

    const now = new Date();
    let conversation: ConversationState;
    let assistantName: SupportAssistantName;
    let createdNewConversation = false;
    let humanSupportActive = false;
    if (conversationId) {
      if (!Types.ObjectId.isValid(conversationId))
        throw new BadRequestException('Invalid conversation ID.');
      const activityUpdate: {
        $set: Record<string, unknown>;
        $unset?: Record<string, 1>;
      } = {
        // Keep activity fresh for retention and inbox sorting, but advance
        // lastCustomerMessageAt only after a new message has actually been
        // saved. A concurrent idempotent retry must not create fake unanswered
        // work for the customer-care team.
        $set: { lastMessageAt: now },
      };
      const existingConversation = await this.conversationModel
        .findOne({
          _id: new Types.ObjectId(conversationId),
          userId: new Types.ObjectId(userId),
          retentionDeleting: { $ne: true },
        })
        .exec();
      if (!existingConversation)
        throw new NotFoundException(
          'Support conversation was not found or has expired.',
        );
      assistantName = await this.ensureAssistantName(existingConversation._id);
      humanSupportActive = [
        'WAITING_FOR_ADMIN',
        'ASSIGNED',
        'HUMAN_REPLIED',
      ].includes(
        String(existingConversation.humanSupportStatus ?? 'AI_HANDLING'),
      );
      if (existingConversation.status === 'CLOSED') {
        throw new BadRequestException(
          'This support conversation is closed. Start a new conversation to continue.',
        );
      }
      if (existingConversation.status === 'RESOLVED') {
        activityUpdate.$set.status = 'OPEN';
        activityUpdate.$unset = { resolvedAt: 1 };
      }
      if (humanSupportActive && existingConversation.assignedAdminId) {
        activityUpdate.$set.humanSupportStatus = 'ASSIGNED';
      }
      const updatedConversation = await this.conversationModel
        .findOneAndUpdate(
          {
            _id: new Types.ObjectId(conversationId),
            userId: new Types.ObjectId(userId),
            status: { $ne: 'CLOSED' },
            retentionDeleting: { $ne: true },
          },
          activityUpdate,
          { returnDocument: 'after' },
        )
        .exec();
      if (!updatedConversation)
        throw new NotFoundException(
          'This support conversation is being deleted. Start a new conversation.',
        );
      conversation = updatedConversation;
    } else {
      assistantName = chooseSupportAssistantName();
      conversation = await this.conversationModel.create({
        userId: new Types.ObjectId(userId),
        title: makeTitle(message),
        assistantName,
        status: 'OPEN',
        category: classifyIssue(message),
        summary: `User: ${message.slice(0, 900)}`.slice(0, 4000),
        humanSupportStatus: 'AI_HANDLING',
        lastCustomerMessageAt: now,
        lastMessageAt: now,
      });
      createdNewConversation = true;
    }

    let userMessage: MessageState;
    try {
      userMessage = await this.messageModel.create({
        conversationId: conversation._id,
        userId: new Types.ObjectId(userId),
        role: 'USER',
        content: message,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(!humanSupportActive ? { replyStatus: 'QUEUED' as const } : {}),
        metadata: { source: 'website-chat', humanSupportActive },
      });
    } catch (error) {
      if (isDuplicateKey(error) && idempotencyKey) {
        // A concurrent retry won the unique idempotency index. Do not leave an
        // empty new conversation behind from the losing request.
        if (createdNewConversation) {
          await this.conversationModel
            .deleteOne({
              _id: conversation._id,
              userId: new Types.ObjectId(userId),
            })
            .exec()
            .catch(() => undefined);
        }
        const existing = await this.messageModel
          .findOne({
            userId: new Types.ObjectId(userId),
            role: 'USER',
            idempotencyKey,
          })
          .exec();
        if (existing) {
          await this.ensureReplyJobForExistingMessage(existing);
          return this.acceptedMessageResponse(existing);
        }
      }
      throw error;
    }

    conversation.category =
      conversation.category === 'GENERAL'
        ? classifyIssue(message)
        : conversation.category;
    conversation.lastMessageAt = now;
    conversation.lastCustomerMessageAt = now;
    if (humanSupportActive && conversation.assignedAdminId) {
      conversation.humanSupportStatus = 'ASSIGNED';
    }
    if (!humanSupportActive) {
      conversation.summary = `User: ${message.slice(0, 900)}`.slice(0, 4000);
    }
    await conversation.save();

    if (humanSupportActive) {
      const escalation = this.escalation as unknown as {
        enqueueSupportNotification(notification: {
          kind: 'CUSTOMER_MESSAGE' | 'HANDOFF_REQUESTED';
          conversationId: string;
          eventKey: string;
          category: string;
          summary: string;
          assignedAdminId?: string;
        }): Promise<unknown>;
      };
      const notificationKind = conversation.assignedAdminId
        ? 'CUSTOMER_MESSAGE'
        : 'HANDOFF_REQUESTED';
      await escalation
        .enqueueSupportNotification({
          kind: notificationKind,
          conversationId: String(conversation._id),
          eventKey: String(userMessage._id),
          category: String(conversation.category ?? 'GENERAL'),
          summary: `A customer sent a new message in support conversation ${String(conversation._id)}.`,
          assignedAdminId: conversation.assignedAdminId
            ? String(conversation.assignedAdminId)
            : undefined,
        })
        .catch((error) =>
          this.logger.warn(
            `Could not queue customer support notification: ${safeError(error)}`,
          ),
        );
      return {
        conversationId: String(conversation._id),
        assistantName,
        messageId: String(userMessage._id),
        answer: conversation.assignedAdminId
          ? 'Your message has been sent to the support administrator handling this conversation.'
          : 'Your message has been added to the support queue. An administrator will respond here.',
        status: conversation.assignedAdminId ? 'ASSIGNED' : 'WAITING_FOR_ADMIN',
        conversationStatus: conversation.status,
        humanSupportStatus: conversation.humanSupportStatus,
        escalated: true,
        createdAt: userMessage.createdAt ?? now,
      };
    }

    await this.ensureReplyJob(
      userId,
      String(conversation._id),
      String(userMessage._id),
    );

    return {
      conversationId: String(conversation._id),
      assistantName,
      messageId: String(userMessage._id),
      answer: QUEUED_ACKNOWLEDGEMENT,
      status: 'QUEUED',
      conversationStatus: conversation.status,
      escalated: false,
      createdAt: userMessage.createdAt ?? now,
      pollUrl: `/api/customer-care/messages/${String(userMessage._id)}/status`,
    };
  }

  /** Called only by the durable worker after it has atomically claimed a reply job. */
  async processQueuedMessage(
    userId: string,
    conversationId: string,
    userMessageId: string,
  ): Promise<void> {
    this.assertUserId(userId);
    if (
      !Types.ObjectId.isValid(conversationId) ||
      !Types.ObjectId.isValid(userMessageId)
    ) {
      throw new Error('Customer Care reply job contains an invalid reference.');
    }
    const owner = new Types.ObjectId(userId);
    const conversationObjectId = new Types.ObjectId(conversationId);
    const messageObjectId = new Types.ObjectId(userMessageId);
    const userMessage = await this.messageModel
      .findOne({
        _id: messageObjectId,
        conversationId: conversationObjectId,
        userId: owner,
        role: 'USER',
      })
      .exec();
    if (!userMessage) {
      // Chat retention may have removed a very old request before it was claimed.
      throw new Error('The queued customer message no longer exists.');
    }

    const existingReply = await this.messageModel
      .findOne({ replyToMessageId: messageObjectId, role: 'ASSISTANT' })
      .exec();
    if (existingReply) {
      const replyStatus = isFallbackMessage(existingReply)
        ? 'FAILED'
        : 'COMPLETED';
      await this.messageModel
        .updateOne({ _id: messageObjectId }, { $set: { replyStatus } })
        .exec();
      await this.conversationModel
        .updateOne(
          { _id: conversationObjectId, userId: owner },
          {
            $set: {
              lastMessageAt: messageCreatedAt(existingReply) ?? new Date(),
              lastSupportReplyAt: messageCreatedAt(existingReply) ?? new Date(),
              summary: makeSummary(
                String(userMessage.content),
                String(existingReply.content ?? ''),
              ),
            },
          },
        )
        .exec();
      if (recordValue(existingReply.metadata).escalated === true) {
        await this.ensureHumanHandoff(
          String(conversationObjectId),
          userId,
          String(messageObjectId),
          String(
            existingReply.content ??
              'The AI assistant requested administrator assistance.',
          ),
        );
      }
      return;
    }

    await this.messageModel
      .updateOne(
        { _id: messageObjectId },
        { $set: { replyStatus: 'PROCESSING' } },
      )
      .exec();
    const conversation = await this.conversationModel
      .findOne({
        _id: conversationObjectId,
        userId: owner,
        retentionDeleting: { $ne: true },
      })
      .exec();
    if (!conversation)
      throw new Error(
        'The support conversation was removed or is being retained/deleted.',
      );
    const assistantName = await this.ensureAssistantName(conversationObjectId);
    if (
      ['WAITING_FOR_ADMIN', 'ASSIGNED', 'HUMAN_REPLIED'].includes(
        String(conversation.humanSupportStatus ?? 'AI_HANDLING'),
      )
    ) {
      await this.messageModel
        .updateOne({ _id: messageObjectId }, { $unset: { replyStatus: 1 } })
        .exec();
      await (
        this.escalation.enqueueSupportNotification as (notification: {
          kind: 'CUSTOMER_MESSAGE' | 'HANDOFF_REQUESTED';
          conversationId: string;
          eventKey: string;
          category: string;
          summary: string;
          assignedAdminId?: string;
        }) => Promise<unknown>
      )({
        kind: conversation.assignedAdminId
          ? 'CUSTOMER_MESSAGE'
          : 'HANDOFF_REQUESTED',
        conversationId,
        eventKey: String(userMessage._id),
        category: String(conversation.category ?? 'GENERAL'),
        summary: 'A customer message is awaiting administrator attention.',
        assignedAdminId: conversation.assignedAdminId
          ? String(conversation.assignedAdminId)
          : undefined,
      });
      return;
    }

    // History query is constrained to real user/assistant messages, retrieves only
    // the last 12 turns, and does not send TOOL/SYSTEM rows back into the prompt.
    const [historyRowsRaw, hasPreviousAssistantReply] = await Promise.all([
      this.messageModel
        .find({
          conversationId: conversationObjectId,
          userId: owner,
          role: { $in: ['USER', 'ASSISTANT'] },
          _id: { $ne: messageObjectId },
        })
        .sort({ createdAt: -1 })
        .limit(12)
        .lean()
        .exec(),
      this.messageModel
        .exists({
          conversationId: conversationObjectId,
          userId: owner,
          role: 'ASSISTANT',
        })
        .exec(),
    ]);
    const historyRows = historyRowsRaw as Array<
      Partial<SupportMessage> & {
        _id: Types.ObjectId;
        role: string;
        content?: string;
        createdAt?: Date;
      }
    >;
    const history = historyRows.reverse().map((row) => ({
      role:
        row.role === 'ASSISTANT' ? ('assistant' as const) : ('user' as const),
      content: String(row.content ?? '').slice(0, 4000),
    }));

    const startedAt = Date.now();
    const result = await this.groq.answerSupportMessage({
      userId,
      conversationId,
      assistantName,
      isFirstAssistantReply: !hasPreviousAssistantReply,
      message: String(userMessage.content).slice(0, 4000),
      history,
    });

    // Unique replyToMessageId makes a recovered/retried worker safe if a process
    // completed the model call but crashed before acknowledging its queue job.
    let assistantReply: MessageRecord | null;
    try {
      assistantReply = toMessageRecord(
        await this.messageModel
          .findOneAndUpdate(
            { replyToMessageId: messageObjectId, role: 'ASSISTANT' },
            {
              $setOnInsert: {
                conversationId: conversationObjectId,
                userId: owner,
                role: 'ASSISTANT',
                content: result.answer.slice(0, 8000),
                replyToMessageId: messageObjectId,
                metadata: {
                  toolCalls: result.toolCalls.slice(0, 20),
                  escalated: result.escalated,
                },
              },
            },
            {
              upsert: true,
              returnDocument: 'after',
              setDefaultsOnInsert: true,
            },
          )
          .exec(),
      );
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      assistantReply = toMessageRecord(
        await this.messageModel
          .findOne({ replyToMessageId: messageObjectId, role: 'ASSISTANT' })
          .exec(),
      );
      if (!assistantReply) throw error;
    }

    await this.messageModel
      .updateOne(
        { _id: messageObjectId },
        { $set: { replyStatus: 'COMPLETED' } },
      )
      .exec();
    conversation.category =
      conversation.category === 'GENERAL'
        ? classifyIssue(String(userMessage.content))
        : conversation.category;
    conversation.lastMessageAt = messageCreatedAt(assistantReply) ?? new Date();
    conversation.lastSupportReplyAt =
      messageCreatedAt(assistantReply) ?? new Date();
    conversation.summary = makeSummary(
      String(userMessage.content),
      String(assistantReply?.content ?? result.answer),
    );
    await conversation.save();
    if (result.escalated) {
      await this.ensureHumanHandoff(
        conversationId,
        userId,
        String(userMessage._id),
        String(assistantReply?.content ?? result.answer),
      );
    }

    await this.auditModel
      .create({
        conversationId: conversationObjectId,
        userId: owner,
        actionName: 'support_message_completed',
        actionType: 'DIAGNOSTIC',
        outcome: 'SUCCEEDED',
        summary: result.escalated
          ? 'Asynchronous assistant response returned; at least one incident was escalated.'
          : 'Asynchronous assistant response returned.',
        details: {
          toolCount: result.toolCalls.length,
          escalated: result.escalated,
          processingMode: 'durable-queue',
        },
        durationMs: Math.max(0, Date.now() - startedAt),
      })
      .catch((error) =>
        this.logger.warn(
          `Could not persist support completion audit: ${safeError(error)}`,
        ),
      );
  }

  /** Final bounded retry exhausted: persist a useful response and escalate once. */
  async finalizeQueuedMessageFailure(
    userId: string,
    conversationId: string,
    userMessageId: string,
    errorMessage: string,
  ): Promise<void> {
    const owner = new Types.ObjectId(userId);
    const conversationObjectId = new Types.ObjectId(conversationId);
    const messageObjectId = new Types.ObjectId(userMessageId);
    const userMessage = await this.messageModel
      .findOne({ _id: messageObjectId, userId: owner, role: 'USER' })
      .exec();
    if (!userMessage) return;
    const assistantName = await this.ensureAssistantName(conversationObjectId);
    const earlierAssistantReply = await this.messageModel
      .findOne({
        conversationId: conversationObjectId,
        role: 'ASSISTANT',
        _id: { $ne: messageObjectId },
      })
      .select('_id')
      .lean()
      .exec();
    const customerFacingFailureReply = earlierAssistantReply
      ? GROQ_FAILURE_REPLY
      : `Hi, I'm ${assistantName}. I’m having trouble checking that just now. Please try again shortly.`;
    const priorReply = await this.messageModel
      .findOne({ replyToMessageId: messageObjectId, role: 'ASSISTANT' })
      .lean()
      .exec();
    if (priorReply) {
      const replyStatus = isFallbackMessage(priorReply)
        ? 'FAILED'
        : 'COMPLETED';
      await this.messageModel
        .updateOne({ _id: messageObjectId }, { $set: { replyStatus } })
        .exec();
      await this.conversationModel
        .updateOne(
          { _id: conversationObjectId, userId: owner },
          {
            $set: {
              lastMessageAt: messageCreatedAt(priorReply) ?? new Date(),
              lastSupportReplyAt: messageCreatedAt(priorReply) ?? new Date(),
              summary: makeSummary(
                String(userMessage.content),
                String(priorReply.content ?? ''),
              ),
            },
          },
        )
        .exec();
      return;
    }

    const error = safeError(errorMessage);
    let assistantReply: MessageRecord | null;
    try {
      assistantReply = toMessageRecord(
        await this.messageModel
          .findOneAndUpdate(
            { replyToMessageId: messageObjectId, role: 'ASSISTANT' },
            {
              $setOnInsert: {
                conversationId: conversationObjectId,
                userId: owner,
                role: 'ASSISTANT',
                content: customerFacingFailureReply,
                replyToMessageId: messageObjectId,
                metadata: { toolCalls: [], escalated: true, fallback: true },
              },
            },
            {
              upsert: true,
              returnDocument: 'after',
              setDefaultsOnInsert: true,
            },
          )
          .exec(),
      );
    } catch (insertError) {
      if (!isDuplicateKey(insertError)) throw insertError;
      assistantReply = toMessageRecord(
        await this.messageModel
          .findOne({ replyToMessageId: messageObjectId, role: 'ASSISTANT' })
          .exec(),
      );
    }

    await this.messageModel
      .updateOne({ _id: messageObjectId }, { $set: { replyStatus: 'FAILED' } })
      .exec();
    await this.conversationModel
      .updateOne(
        { _id: conversationObjectId, userId: owner },
        {
          $set: {
            lastMessageAt: messageCreatedAt(assistantReply) ?? new Date(),
            lastSupportReplyAt: messageCreatedAt(assistantReply) ?? new Date(),
            summary: makeSummary(
              String(userMessage.content),
              String(assistantReply?.content ?? customerFacingFailureReply),
            ),
          },
        },
      )
      .exec();

    await this.ensureHumanHandoff(
      conversationId,
      userId,
      String(userMessage._id),
      customerFacingFailureReply,
    );

    await this.escalation
      .createIncident({
        userId,
        conversationId,
        category: 'GROQ_PROVIDER',
        severity: 'HIGH',
        summary:
          'Customer Care could not complete a Groq request after automatic retries. Automated diagnosis was interrupted.',
        evidence: [`Final provider/processing error: ${error.slice(0, 300)}`],
        attemptedActions: [
          'The request was retried through the durable queue; a safe fallback response was recorded.',
        ],
        fingerprint: 'CUSTOMER_CARE:GROQ_PROVIDER_UNAVAILABLE',
      })
      .catch((incidentError) =>
        this.logger.error(
          `Could not persist Groq failure incident: ${safeError(incidentError)}`,
        ),
      );

    await this.auditModel
      .create({
        conversationId: conversationObjectId,
        userId: owner,
        actionName: 'support_message_failed',
        actionType: 'DIAGNOSTIC',
        outcome: 'FAILED',
        summary:
          'The asynchronous Groq response exhausted retries; a fallback reply was returned.',
        details: { processingMode: 'durable-queue', error },
        durationMs: 0,
      })
      .catch((auditError) =>
        this.logger.warn(
          `Could not persist support failure audit: ${safeError(auditError)}`,
        ),
      );
  }

  async getCustomerNotificationSummary(
    userId: string,
  ): Promise<Record<string, unknown>> {
    this.assertUserId(userId);
    const owner = new Types.ObjectId(userId);
    const base = {
      userId: owner,
      status: { $ne: 'CLOSED' },
      retentionDeleting: { $ne: true },
    } as const;
    const epoch = new Date(0);
    const [waitingForReply, unreadReplies] = await Promise.all([
      this.conversationModel
        .countDocuments({
          ...base,
          status: 'OPEN',
          lastCustomerMessageAt: { $exists: true },
          $expr: {
            $gt: [
              '$lastCustomerMessageAt',
              { $ifNull: ['$lastSupportReplyAt', epoch] },
            ],
          },
        })
        .exec(),
      this.conversationModel
        .countDocuments({
          ...base,
          lastSupportReplyAt: { $exists: true },
          $expr: {
            $gt: [
              '$lastSupportReplyAt',
              { $ifNull: ['$customerLastReadAt', epoch] },
            ],
          },
        })
        .exec(),
    ]);
    return {
      waitingForReply,
      unreadReplies,
      hasAttention: waitingForReply > 0 || unreadReplies > 0,
    };
  }

  async markCustomerConversationRead(
    userId: string,
    conversationId: string,
  ): Promise<Record<string, unknown>> {
    this.assertUserId(userId);
    if (!Types.ObjectId.isValid(conversationId))
      throw new BadRequestException('Invalid conversation ID.');
    const readAt = new Date();
    const conversation = await this.conversationModel
      .findOneAndUpdate(
        {
          _id: new Types.ObjectId(conversationId),
          userId: new Types.ObjectId(userId),
          retentionDeleting: { $ne: true },
        },
        { $set: { customerLastReadAt: readAt } },
        { returnDocument: 'after' },
      )
      .lean()
      .exec();
    if (!conversation)
      throw new NotFoundException('Support conversation was not found.');
    return { conversationId, customerLastReadAt: readAt };
  }

  async getAdminInboxSummary(
    adminId: string,
  ): Promise<Record<string, unknown>> {
    this.assertUserId(adminId);
    const admin = new Types.ObjectId(adminId);
    const base = { status: 'OPEN', retentionDeleting: { $ne: true } } as const;
    const [
      unclaimedRequests,
      assignedConversationsNeedingReply,
      assignedUnreadMessages,
    ] = await Promise.all([
      this.conversationModel
        .countDocuments({
          ...base,
          humanSupportStatus: 'WAITING_FOR_ADMIN',
          $or: [
            { assignedAdminId: { $exists: false } },
            { assignedAdminId: null },
          ],
        })
        .exec(),
      this.conversationModel
        .countDocuments({
          ...base,
          assignedAdminId: admin,
          lastCustomerMessageAt: { $exists: true },
          $expr: {
            $gt: [
              '$lastCustomerMessageAt',
              { $ifNull: ['$lastSupportReplyAt', new Date(0)] },
            ],
          },
        })
        .exec(),
      this.conversationModel
        .countDocuments({
          ...base,
          assignedAdminId: admin,
          lastCustomerMessageAt: { $exists: true },
          $expr: {
            $gt: [
              '$lastCustomerMessageAt',
              { $ifNull: ['$adminLastReadAt', new Date(0)] },
            ],
          },
        })
        .exec(),
    ]);
    return {
      unclaimedRequests,
      assignedConversationsNeedingReply,
      assignedUnreadMessages,
      // Claiming a request marks the initial inbound message as seen, so the
      // shared alert clears. A later customer message alerts the assignee again.
      hasAttention: unclaimedRequests > 0 || assignedUnreadMessages > 0,
    };
  }

  async getAdminInbox(
    adminId: string,
    viewValue = 'open',
    limitValue = 50,
  ): Promise<Record<string, unknown>> {
    this.assertUserId(adminId);
    const limit = Math.max(
      1,
      Math.min(100, Math.floor(Number(limitValue) || 50)),
    );
    const view = ['open', 'mine', 'all'].includes(
      String(viewValue).toLowerCase(),
    )
      ? String(viewValue).toLowerCase()
      : 'open';
    const filter: Record<string, unknown> = {
      retentionDeleting: { $ne: true },
    };
    if (view === 'open') {
      filter.status = 'OPEN';
      filter.humanSupportStatus = 'WAITING_FOR_ADMIN';
      filter.$or = [
        { assignedAdminId: { $exists: false } },
        { assignedAdminId: null },
      ];
    } else if (view === 'mine') {
      filter.status = 'OPEN';
      filter.assignedAdminId = new Types.ObjectId(adminId);
    }
    const [items, total] = await Promise.all([
      this.conversationModel
        .find(filter)
        .populate({ path: 'userId', select: 'email name firstName lastName' })
        .sort({ lastMessageAt: -1 })
        .limit(limit)
        .lean()
        .exec(),
      this.conversationModel.countDocuments(filter).exec(),
    ]);
    return { items, total, limit, view };
  }

  async claimAdminConversation(
    adminId: string,
    conversationId: string,
  ): Promise<Record<string, unknown>> {
    this.assertUserId(adminId);
    if (!Types.ObjectId.isValid(conversationId))
      throw new BadRequestException('Invalid conversation ID.');
    const admin = new Types.ObjectId(adminId);
    const now = new Date();
    const claimed = await this.conversationModel
      .findOneAndUpdate(
        {
          _id: new Types.ObjectId(conversationId),
          status: 'OPEN',
          retentionDeleting: { $ne: true },
          humanSupportStatus: 'WAITING_FOR_ADMIN',
          $or: [
            { assignedAdminId: { $exists: false } },
            { assignedAdminId: null },
          ],
        },
        {
          $set: {
            assignedAdminId: admin,
            claimedAt: now,
            adminLastReadAt: now,
            humanSupportStatus: 'ASSIGNED',
          },
        },
        { returnDocument: 'after' },
      )
      .exec();

    if (!claimed) {
      const existing = await this.conversationModel
        .findById(conversationId)
        .lean()
        .exec();
      if (
        existing &&
        String(existing.assignedAdminId ?? '') === adminId &&
        existing.status === 'OPEN'
      ) {
        return this.getAdminConversation(conversationId);
      }
      if (!existing)
        throw new NotFoundException('Support conversation was not found.');
      throw new BadRequestException(
        'This request has already been claimed or is no longer open. Refresh the inbox.',
      );
    }

    await this.auditModel.create({
      conversationId: claimed._id,
      userId: claimed.userId,
      actorId: admin,
      actorRole: 'ADMIN',
      actionName: 'admin_claimed_support_conversation',
      actionType: 'ESCALATION',
      outcome: 'SUCCEEDED',
      summary: `Administrator claimed support conversation ${conversationId}.`,
      details: { assignedAdminId: adminId },
      durationMs: 0,
    });
    return this.getAdminConversation(conversationId);
  }

  async replyToAdminConversation(
    adminId: string,
    conversationId: string,
    rawText: string,
    requestId?: string,
  ): Promise<Record<string, unknown>> {
    this.assertUserId(adminId);
    if (!Types.ObjectId.isValid(conversationId))
      throw new BadRequestException('Invalid conversation ID.');
    const rawMessage = String(rawText ?? '').trim();
    if (!rawMessage || rawMessage.length > 4000)
      throw new BadRequestException(
        'A support reply must contain 1–4000 characters.',
      );
    const idempotencyKey = String(requestId ?? '').trim();
    if (
      idempotencyKey &&
      (idempotencyKey.length < 8 || idempotencyKey.length > 128)
    ) {
      throw new BadRequestException(
        'The client message ID must contain 8–128 characters.',
      );
    }
    const message = redactSupportMessage(rawMessage);
    if (!message)
      throw new BadRequestException(
        'Please send a support reply without passwords, OTPs, or access tokens.',
      );

    const admin = new Types.ObjectId(adminId);
    const conversationIdObject = new Types.ObjectId(conversationId);
    const conversation = await this.conversationModel
      .findOne({
        _id: conversationIdObject,
        assignedAdminId: admin,
        status: 'OPEN',
        retentionDeleting: { $ne: true },
      })
      .lean()
      .exec();
    if (!conversation) {
      const exists = await this.conversationModel
        .exists({ _id: conversationIdObject })
        .exec();
      if (!exists)
        throw new NotFoundException('Support conversation was not found.');
      throw new BadRequestException(
        'Claim this open conversation before replying, or refresh if it has been reassigned.',
      );
    }

    // A retry after a network timeout must return the saved reply instead of
    // creating a second customer-visible admin message.
    if (idempotencyKey) {
      const existingReply = await this.messageModel
        .findOne({
          userId: conversation.userId,
          conversationId: conversationIdObject,
          role: 'ADMIN',
          idempotencyKey,
          'metadata.adminId': adminId,
        })
        .lean()
        .exec();
      if (existingReply) {
        return {
          conversationId,
          message: existingReply,
          humanSupportStatus: 'HUMAN_REPLIED',
          duplicate: true,
        };
      }
    }

    const now = new Date();
    let savedMessage: SupportMessageDocument;
    try {
      savedMessage = await this.messageModel.create({
        conversationId: conversationIdObject,
        userId: conversation.userId,
        role: 'ADMIN',
        content: message,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        metadata: { source: 'admin-inbox', adminId },
      });
    } catch (error) {
      // Handle two identical retries arriving concurrently on different API
      // instances. The unique message idempotency index is the final authority.
      if (isDuplicateKey(error) && idempotencyKey) {
        const existingReply = await this.messageModel
          .findOne({
            userId: conversation.userId,
            conversationId: conversationIdObject,
            role: 'ADMIN',
            idempotencyKey,
            'metadata.adminId': adminId,
          })
          .lean()
          .exec();
        if (existingReply) {
          return {
            conversationId,
            message: existingReply,
            humanSupportStatus: 'HUMAN_REPLIED',
            duplicate: true,
          };
        }
      }
      throw error;
    }
    const updated = await this.conversationModel
      .updateOne(
        {
          _id: conversationIdObject,
          assignedAdminId: admin,
          status: 'OPEN',
          retentionDeleting: { $ne: true },
        },
        {
          $set: {
            lastMessageAt: now,
            lastSupportReplyAt: now,
            adminLastReadAt: now,
            humanSupportStatus: 'HUMAN_REPLIED',
          },
        },
      )
      .exec();
    if (updated.modifiedCount === 0) {
      await this.messageModel
        .deleteOne({ _id: savedMessage._id, role: 'ADMIN' })
        .exec()
        .catch(() => undefined);
      throw new BadRequestException(
        'The conversation changed before the reply was saved. Refresh and try again.',
      );
    }

    await this.auditModel.create({
      conversationId: conversationIdObject,
      userId: conversation.userId,
      actorId: admin,
      actorRole: 'ADMIN',
      actionName: 'admin_replied_to_support_conversation',
      actionType: 'ESCALATION',
      outcome: 'SUCCEEDED',
      summary: `Administrator replied to support conversation ${conversationId}.`,
      details: { messageId: String(savedMessage._id) },
      durationMs: 0,
    });
    return {
      conversationId,
      message: savedMessage.toObject(),
      humanSupportStatus: 'HUMAN_REPLIED',
    };
  }

  async markAdminConversationRead(
    adminId: string,
    conversationId: string,
  ): Promise<Record<string, unknown>> {
    this.assertUserId(adminId);
    if (!Types.ObjectId.isValid(conversationId))
      throw new BadRequestException('Invalid conversation ID.');
    const readAt = new Date();
    const updated = await this.conversationModel
      .findOneAndUpdate(
        {
          _id: new Types.ObjectId(conversationId),
          assignedAdminId: new Types.ObjectId(adminId),
          retentionDeleting: { $ne: true },
        },
        { $set: { adminLastReadAt: readAt } },
        { returnDocument: 'after' },
      )
      .lean()
      .exec();
    if (!updated)
      throw new NotFoundException(
        'Assigned support conversation was not found.',
      );
    return { conversationId, adminLastReadAt: readAt };
  }

  async releaseAdminConversation(
    adminId: string,
    conversationId: string,
  ): Promise<Record<string, unknown>> {
    this.assertUserId(adminId);
    if (!Types.ObjectId.isValid(conversationId))
      throw new BadRequestException('Invalid conversation ID.');
    const admin = new Types.ObjectId(adminId);
    const released = await this.conversationModel
      .findOneAndUpdate(
        {
          _id: new Types.ObjectId(conversationId),
          assignedAdminId: admin,
          status: 'OPEN',
          retentionDeleting: { $ne: true },
        },
        {
          $set: { humanSupportStatus: 'WAITING_FOR_ADMIN' },
          $unset: { assignedAdminId: 1, claimedAt: 1, adminLastReadAt: 1 },
        },
        { returnDocument: 'after' },
      )
      .exec();
    if (!released)
      throw new BadRequestException(
        'Only the assigned administrator can release an open conversation.',
      );
    await this.auditModel.create({
      conversationId: released._id,
      userId: released.userId,
      actorId: admin,
      actorRole: 'ADMIN',
      actionName: 'admin_released_support_conversation',
      actionType: 'ESCALATION',
      outcome: 'SUCCEEDED',
      summary: `Administrator returned support conversation ${conversationId} to the shared queue.`,
      details: {},
      durationMs: 0,
    });
    const escalation = this.escalation as unknown as {
      enqueueSupportNotification(notification: {
        kind: 'CUSTOMER_MESSAGE' | 'HANDOFF_REQUESTED';
        conversationId: string;
        eventKey: string;
        category: string;
        summary: string;
        assignedAdminId?: string;
      }): Promise<unknown>;
    };
    await escalation
      .enqueueSupportNotification({
        kind: 'HANDOFF_REQUESTED',
        conversationId,
        eventKey: `release-${Date.now()}`,
        category: String(released.category ?? 'GENERAL'),
        summary:
          'An assigned support conversation has been returned to the shared queue.',
      })
      .catch((error) =>
        this.logger.warn(
          `Could not queue released support conversation notification: ${safeError(error)}`,
        ),
      );
    return { conversationId, humanSupportStatus: 'WAITING_FOR_ADMIN' };
  }

  async resolveAdminConversation(
    adminId: string,
    conversationId: string,
  ): Promise<Record<string, unknown>> {
    this.assertUserId(adminId);
    if (!Types.ObjectId.isValid(conversationId))
      throw new BadRequestException('Invalid conversation ID.');
    const admin = new Types.ObjectId(adminId);
    const conversationObjectId = new Types.ObjectId(conversationId);
    const current = await this.conversationModel
      .findOne({
        _id: conversationObjectId,
        assignedAdminId: admin,
        status: 'OPEN',
        retentionDeleting: { $ne: true },
      })
      .select('lastCustomerMessageAt lastSupportReplyAt')
      .lean()
      .exec();
    if (!current)
      throw new BadRequestException(
        'Only the assigned administrator can resolve an open conversation.',
      );
    if (
      current.lastCustomerMessageAt &&
      (!current.lastSupportReplyAt ||
        current.lastCustomerMessageAt > current.lastSupportReplyAt)
    ) {
      throw new BadRequestException(
        'Reply to the latest customer message before resolving this conversation.',
      );
    }
    const now = new Date();
    // Repeat the unanswered-message guard atomically so a customer message that
    // arrives after the read above cannot be hidden by a concurrent resolution.
    const resolved = await this.conversationModel
      .findOneAndUpdate(
        {
          _id: conversationObjectId,
          assignedAdminId: admin,
          status: 'OPEN',
          retentionDeleting: { $ne: true },
          $or: [
            { lastCustomerMessageAt: { $exists: false } },
            {
              $expr: {
                $lte: [
                  '$lastCustomerMessageAt',
                  { $ifNull: ['$lastSupportReplyAt', new Date(0)] },
                ],
              },
            },
          ],
        },
        {
          $set: {
            status: 'RESOLVED',
            resolvedAt: now,
            lastMessageAt: now,
            humanSupportStatus: 'HUMAN_REPLIED',
          },
        },
        { returnDocument: 'after' },
      )
      .exec();
    if (!resolved)
      throw new BadRequestException(
        'The conversation changed or has a customer message awaiting a reply. Refresh before resolving.',
      );
    await this.auditModel.create({
      conversationId: resolved._id,
      userId: resolved.userId,
      actorId: new Types.ObjectId(adminId),
      actorRole: 'ADMIN',
      actionName: 'admin_resolved_support_conversation',
      actionType: 'ESCALATION',
      outcome: 'SUCCEEDED',
      summary: `Administrator resolved support conversation ${conversationId}.`,
      details: {},
      durationMs: 0,
    });
    return { conversationId, status: 'RESOLVED' };
  }

  async getMessageStatus(
    userId: string,
    messageId: string,
  ): Promise<Record<string, unknown>> {
    this.assertUserId(userId);
    if (!Types.ObjectId.isValid(messageId))
      throw new BadRequestException('Invalid message ID.');
    const owner = new Types.ObjectId(userId);
    const message = await this.messageModel
      .findOne({
        _id: new Types.ObjectId(messageId),
        userId: owner,
        role: 'USER',
      })
      .lean()
      .exec();
    if (!message) throw new NotFoundException('Support message was not found.');
    const [reply, conversation] = await Promise.all([
      this.messageModel
        .findOne({ replyToMessageId: message._id, role: 'ASSISTANT' })
        .select('role content createdAt metadata')
        .lean()
        .exec(),
      this.conversationModel
        .findById(message.conversationId)
        .select('humanSupportStatus assistantName')
        .lean()
        .exec(),
    ]);
    const customerMessageCreatedAt = messageCreatedAt(message);
    const humanReply =
      !reply && customerMessageCreatedAt
        ? await this.messageModel
            .findOne({
              conversationId: message.conversationId,
              userId: owner,
              role: 'ADMIN',
              createdAt: { $gte: customerMessageCreatedAt },
            })
            .sort({ createdAt: 1 })
            .select('role content createdAt')
            .lean()
            .exec()
        : null;
    const supportReply = reply ?? humanReply;
    const storedStatus = String(message.replyStatus ?? 'QUEUED');
    const humanStatus = String(
      conversation?.humanSupportStatus ?? 'AI_HANDLING',
    );
    const waitingForHuman =
      ['WAITING_FOR_ADMIN', 'ASSIGNED', 'HUMAN_REPLIED'].includes(
        humanStatus,
      ) && !supportReply;
    const isFallbackReply = isFallbackMessage(supportReply);
    const status = waitingForHuman
      ? humanStatus
      : isFallbackReply
        ? 'FAILED'
        : reply && storedStatus !== 'FAILED'
          ? 'COMPLETED'
          : humanReply
            ? 'HUMAN_REPLIED'
            : storedStatus;
    return {
      messageId: String(message._id),
      conversationId: String(message.conversationId),
      status,
      reply:
        supportReply?.role === 'ASSISTANT'
          ? sanitizeCustomerVisibleSupportReply(
              supportReply.content,
              String(conversation?.assistantName ?? 'Serena'),
            )
          : (supportReply?.content ?? null),
      replyCreatedAt: messageCreatedAt(supportReply) ?? null,
    };
  }

  async getMyConversations(
    userId: string,
    limitValue = 20,
  ): Promise<Record<string, unknown>> {
    this.assertUserId(userId);
    const limit = Math.max(
      1,
      Math.min(50, Math.floor(Number(limitValue) || 20)),
    );
    const items = await this.conversationModel
      .find({
        userId: new Types.ObjectId(userId),
        retentionDeleting: { $ne: true },
      })
      .sort({ lastMessageAt: -1 })
      .limit(limit)
      .lean()
      .exec();
    return { items, limit };
  }

  async getConversation(
    userId: string,
    conversationId: string,
  ): Promise<Record<string, unknown>> {
    this.assertUserId(userId);
    if (!Types.ObjectId.isValid(conversationId))
      throw new BadRequestException('Invalid conversation ID.');
    const conversation = await this.conversationModel
      .findOne({
        _id: new Types.ObjectId(conversationId),
        userId: new Types.ObjectId(userId),
        retentionDeleting: { $ne: true },
      })
      .lean()
      .exec();
    if (!conversation)
      throw new NotFoundException('Support conversation was not found.');

    const savedAssistantName = String(conversation.assistantName ?? '');
    const assistantName = isSupportAssistantName(savedAssistantName)
      ? savedAssistantName
      : await this.ensureAssistantName(conversation._id);
    const conversationForResponse = { ...conversation, assistantName };

    // Load the message window and first assistant message concurrently.
    const [messageRows, firstAssistantMessage] = await Promise.all([
      this.messageModel
        .find({
          conversationId: new Types.ObjectId(conversationId),
          userId: new Types.ObjectId(userId),
        })
        .sort({ createdAt: -1 })
        .limit(200)
        .lean()
        .exec(),
      this.messageModel
        .findOne({
          conversationId: new Types.ObjectId(conversationId),
          userId: new Types.ObjectId(userId),
          role: 'ASSISTANT',
        })
        .sort({ createdAt: 1, _id: 1 })
        .select('_id')
        .lean()
        .exec(),
    ]);
    const messages = messageRows.reverse();
    const firstAssistantMessageId = firstAssistantMessage
      ? String(firstAssistantMessage._id)
      : '';
    const customerVisibleMessages = messages.map((message) => {
      if (String(message.role ?? '').toUpperCase() !== 'ASSISTANT')
        return message;
      const sanitizedContent = sanitizeCustomerVisibleSupportReply(
        message.content,
        assistantName,
        Boolean(firstAssistantMessageId) &&
          String(message._id) === firstAssistantMessageId,
      );
      return { ...message, content: sanitizedContent };
    });
    return { conversation: conversationForResponse, messages: customerVisibleMessages };
  }

  async closeConversation(
    userId: string,
    conversationId: string,
  ): Promise<Record<string, unknown>> {
    this.assertUserId(userId);
    if (!Types.ObjectId.isValid(conversationId))
      throw new BadRequestException('Invalid conversation ID.');
    const conversation = await this.conversationModel
      .findOneAndUpdate(
        {
          _id: new Types.ObjectId(conversationId),
          userId: new Types.ObjectId(userId),
          retentionDeleting: { $ne: true },
        },
        { $set: { status: 'CLOSED', resolvedAt: new Date() } },
        { returnDocument: 'after' },
      )
      .lean()
      .exec();
    if (!conversation)
      throw new NotFoundException('Support conversation was not found.');
    return { conversationId, status: conversation.status };
  }

  async getAdminConversation(
    conversationId: string,
  ): Promise<Record<string, unknown>> {
    if (!Types.ObjectId.isValid(conversationId))
      throw new BadRequestException('Invalid conversation ID.');
    const foundConversation = await this.conversationModel
      .findById(conversationId)
      .populate({ path: 'userId', select: 'email name firstName lastName' })
      .lean()
      .exec();
    if (!foundConversation)
      throw new NotFoundException('Support conversation was not found.');
    const savedAssistantName = String(foundConversation.assistantName ?? '');
    const assistantName = isSupportAssistantName(savedAssistantName)
      ? savedAssistantName
      : await this.ensureAssistantName(foundConversation._id);
    const conversation = { ...foundConversation, assistantName };
    const objectId = new Types.ObjectId(conversationId);
    const [messageRows, actions, incidents] = await Promise.all([
      this.messageModel
        .find({ conversationId: objectId })
        .sort({ createdAt: -1 })
        .limit(300)
        .lean()
        .exec(),
      this.auditModel
        .find({ conversationId: objectId })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean()
        .exec(),
      this.incidentModel
        .find({ conversationId: objectId })
        .sort({ lastSeenAt: -1 })
        .limit(20)
        .lean()
        .exec(),
    ]);
    const messages = messageRows.reverse();
    return { conversation, messages, actions, incidents };
  }

  private async ensureHumanHandoff(
    conversationId: string,
    userId: string,
    eventKey: string,
    summary: string,
  ): Promise<void> {
    if (
      !Types.ObjectId.isValid(conversationId) ||
      !Types.ObjectId.isValid(userId)
    )
      return;
    const conversationObjectId = new Types.ObjectId(conversationId);
    const owner = new Types.ObjectId(userId);
    const now = new Date();
    await this.conversationModel
      .findOneAndUpdate(
        {
          _id: conversationObjectId,
          userId: owner,
          status: { $ne: 'CLOSED' },
          retentionDeleting: { $ne: true },
          $or: [
            { assignedAdminId: { $exists: false } },
            { assignedAdminId: null },
          ],
          humanSupportStatus: {
            $nin: ['WAITING_FOR_ADMIN', 'ASSIGNED', 'HUMAN_REPLIED'],
          },
        },
        {
          $set: {
            humanSupportStatus: 'WAITING_FOR_ADMIN',
            handoffRequestedAt: now,
          },
        },
        { returnDocument: 'after' },
      )
      .exec();

    const current = await this.conversationModel
      .findOne({
        _id: conversationObjectId,
        userId: owner,
        status: { $ne: 'CLOSED' },
        retentionDeleting: { $ne: true },
      })
      .lean()
      .exec();
    if (
      !current ||
      current.assignedAdminId ||
      current.humanSupportStatus !== 'WAITING_FOR_ADMIN'
    )
      return;
    const escalation = this.escalation as unknown as {
      enqueueSupportNotification(notification: {
        kind: 'HANDOFF_REQUESTED';
        conversationId: string;
        eventKey: string;
        category: string;
        summary: string;
      }): Promise<unknown>;
    };
    await escalation.enqueueSupportNotification({
      kind: 'HANDOFF_REQUESTED',
      conversationId,
      eventKey,
      category: String(current.category ?? 'GENERAL'),
      summary: redactSupportMessage(
        String(summary ?? 'The AI assistant requested human assistance.'),
      ).slice(0, 600),
    });
  }

  private async ensureReplyJob(
    userId: string,
    conversationId: string,
    userMessageId: string,
  ): Promise<void> {
    const jobKey = `SUPPORT_REPLY:${userMessageId}`;
    await this.replyJobs
      .updateOne(
        { jobKey },
        {
          $setOnInsert: {
            jobKey,
            userId: new Types.ObjectId(userId),
            conversationId: new Types.ObjectId(conversationId),
            userMessageId: new Types.ObjectId(userMessageId),
            status: 'PENDING',
            attempts: 0,
            scheduledAt: new Date(),
            lastError: '',
          },
        },
        { upsert: true },
      )
      .exec();
  }

  private async ensureReplyJobForExistingMessage(
    message: MessageState,
  ): Promise<void> {
    const conversation = await this.conversationModel
      .findById(message.conversationId)
      .select('humanSupportStatus assignedAdminId')
      .lean()
      .exec();
    if (
      conversation &&
      ['WAITING_FOR_ADMIN', 'ASSIGNED', 'HUMAN_REPLIED'].includes(
        String(conversation.humanSupportStatus ?? 'AI_HANDLING'),
      )
    )
      return;
    const existingReply = await this.messageModel
      .exists({ replyToMessageId: message._id, role: 'ASSISTANT' })
      .exec();
    if (existingReply) return;

    const existingJob = (await this.replyJobs
      .findOne({ userMessageId: message._id })
      .exec()) as ReplyJobState | null;
    if (!existingJob) {
      await this.ensureReplyJob(
        String(message.userId),
        String(message.conversationId),
        String(message._id),
      );
    } else if (existingJob.status === 'FAILED') {
      // Recover a historical terminal job only when its assistant reply is missing.
      // A failed job with a persisted fallback reply remains terminal and is not replayed.
      existingJob.status = 'PENDING';
      existingJob.attempts = 0;
      existingJob.scheduledAt = new Date();
      existingJob.lastError =
        'Recovered a failed reply job without a persisted assistant response.';
      existingJob.leaseExpiresAt = undefined;
      existingJob.claimToken = undefined;
      existingJob.completedAt = undefined;
      await existingJob.save();
      message.replyStatus = 'QUEUED';
      await message.save();
    }
  }

  /**
   * Give every conversation one stable assistant name. The conditional update is
   * atomic, so concurrent requests cannot assign two different names.
   */
  private async ensureAssistantName(
    conversationId: Types.ObjectId | string,
  ): Promise<SupportAssistantName> {
    const id =
      conversationId instanceof Types.ObjectId
        ? conversationId
        : new Types.ObjectId(conversationId);
    const existing = (await this.conversationModel
      .findById(id)
      .select('assistantName')
      .lean()
      .exec()) as { assistantName?: unknown } | null;
    const savedName =
      typeof existing?.assistantName === 'string'
        ? existing.assistantName.trim()
        : '';
    if (isSupportAssistantName(savedName)) return savedName;

    const proposedName = chooseSupportAssistantName();
    const missingNameConditions: Record<string, unknown>[] = [
      { assistantName: { $exists: false } },
      { assistantName: null },
      { assistantName: '' },
    ];
    if (savedName) missingNameConditions.push({ assistantName: savedName });

    await this.conversationModel
      .updateOne(
        { _id: id, $or: missingNameConditions },
        { $set: { assistantName: proposedName } },
      )
      .exec();

    const persisted = (await this.conversationModel
      .findById(id)
      .select('assistantName')
      .lean()
      .exec()) as { assistantName?: unknown } | null;
    const persistedName =
      typeof persisted?.assistantName === 'string'
        ? persisted.assistantName.trim()
        : '';
    return isSupportAssistantName(persistedName) ? persistedName : proposedName;
  }

  private async acceptedMessageResponse(
    message: MessageState,
  ): Promise<Record<string, unknown>> {
    const assistantName = await this.ensureAssistantName(
      message.conversationId,
    );
    const conversation = await this.conversationModel
      .findById(message.conversationId)
      .select('status humanSupportStatus assistantName')
      .lean()
      .exec();
    const reply = await this.messageModel
      .findOne({ replyToMessageId: message._id, role: 'ASSISTANT' })
      .lean()
      .exec();
    const humanReply =
      !reply && message.createdAt instanceof Date
        ? await this.messageModel
            .findOne({
              conversationId: message.conversationId,
              userId: message.userId,
              role: 'ADMIN',
              createdAt: { $gte: message.createdAt },
            })
            .sort({ createdAt: 1 })
            .select('role content createdAt metadata')
            .lean()
            .exec()
        : null;
    const supportReply = reply ?? humanReply;
    const storedStatus = String(message.replyStatus ?? 'QUEUED');
    const humanStatus = String(
      conversation?.humanSupportStatus ?? 'AI_HANDLING',
    );
    const waitingForHuman =
      ['WAITING_FOR_ADMIN', 'ASSIGNED', 'HUMAN_REPLIED'].includes(
        humanStatus,
      ) && !supportReply;
    const isFallbackReply = isFallbackMessage(supportReply);
    const status = waitingForHuman
      ? humanStatus
      : isFallbackReply
        ? 'FAILED'
        : reply && storedStatus !== 'FAILED'
          ? 'COMPLETED'
          : humanReply
            ? 'HUMAN_REPLIED'
            : storedStatus;
    return {
      conversationId: String(message.conversationId),
      assistantName,
      messageId: String(message._id),
      answer:
        supportReply?.role === 'ASSISTANT'
          ? sanitizeCustomerVisibleSupportReply(
              supportReply.content,
              assistantName,
            )
          : (supportReply?.content ??
            (waitingForHuman
              ? 'Your message is waiting for our support team.'
              : status === 'FAILED'
                ? GROQ_FAILURE_REPLY
                : QUEUED_ACKNOWLEDGEMENT)),
      status,
      conversationStatus: conversation?.status,
      humanSupportStatus: humanStatus,
      escalated:
        waitingForHuman ||
        recordValue(recordValue(reply).metadata).escalated === true,
      createdAt: message.createdAt ?? new Date(),
      pollUrl: `/api/customer-care/messages/${String(message._id)}/status`,
    };
  }

  private assertUserId(userId: string): void {
    if (!Types.ObjectId.isValid(userId))
      throw new BadRequestException('Authenticated user ID is invalid.');
  }
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 11000
  );
}
function makeTitle(message: string): string {
  return message.replace(/\s+/g, ' ').trim().slice(0, 90) || 'Customer support';
}
function makeSummary(userMessage: string, answer: string): string {
  return `User: ${userMessage.slice(0, 900)}\nAssistant: ${answer.slice(0, 1300)}`.slice(
    0,
    4000,
  );
}
function classifyIssue(message: string): string {
  const text = message.toLowerCase();
  if (/payment|paid|transaction|deposit|reference/.test(text))
    return 'PAYMENTS';
  if (/subscription|vip|premium|regular plan|renew|upgrade/.test(text))
    return 'SUBSCRIPTIONS';
  if (/prediction|pick|market|slip|confidence/.test(text)) return 'PREDICTIONS';
  if (/bet lab|wallet|ticket|virtual balance/.test(text)) return 'BET_LAB';
  if (/promo|promotion|bonus|reward|claim/.test(text)) return 'PROMOS';
  if (/login|password|verification|otp|email/.test(text)) return 'ACCOUNTS';
  return 'GENERAL';
}
function redactSupportMessage(value: string): string {
  const redacted = value
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(
      /(?:my\s+|the\s+)?(?:password|passcode|pin|api[_ -]?key|access token|refresh token|secret)\s*(?:is|:|=)\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '[credential redacted]',
    )
    .replace(
      /\b(?:otp|verification code|one-time code)\s*[:#-]?\s*\d{4,8}\b/gi,
      '[verification code redacted]',
    )
    .replace(
      /\b(?:cvv|cvc|security code)\s*[:=]?\s*\d{3,4}\b/gi,
      '[card security code redacted]',
    )
    .replace(/\b(?:\d[ -]?){13,19}\b/g, '[payment card number redacted]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email redacted]');
  return replaceControlCharacters(redacted)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
}
function safeError(error: unknown): string {
  return replaceControlCharacters(
    error instanceof Error ? error.message : String(error),
  ).slice(0, 800);
}
function replaceControlCharacters(value: string): string {
  return value
    .split('')
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f ? ' ' : character;
    })
    .join('');
}
