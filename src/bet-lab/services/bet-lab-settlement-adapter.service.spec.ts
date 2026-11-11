import { ConflictException } from '@nestjs/common';
import { BetLabLegStatus } from '../enums/bet-lab-leg-status.enum';
import { BetLabTicketStatus } from '../enums/bet-lab-ticket-status.enum';
import type { ApplyBetLabSettlementInput } from '../interfaces/bet-lab-settlement.interface';
import { BetLabSettlementAdapterService } from './bet-lab-settlement-adapter.service';

describe('BetLabSettlementAdapterService idempotency', () => {
  const ticketId = '64a000000000000000000001';

  const makeHarness = () => {
    const session = {
      withTransaction: jest.fn(async (work: () => Promise<void>) => work()),
      endSession: jest.fn().mockResolvedValue(undefined),
    };
    const ticket: any = {
      _id: ticketId,
      userId: 'user-1',
      ticketNumber: 'BL-0001',
      stake: 100,
      status: BetLabTicketStatus.OPEN,
      legs: [
        {
          legId: 'leg-1',
          status: BetLabLegStatus.OPEN,
          settlementOutcome: undefined,
          settledAt: undefined,
        },
      ],
      save: jest.fn().mockResolvedValue(undefined),
    };
    const wallet: any = {
      userId: 'user-1',
      ticketsSettled: 0,
      ticketsWon: 0,
      ticketsLost: 0,
      ticketsVoided: 0,
      ticketsPushed: 0,
      ticketsPartiallyWon: 0,
      ticketsPartiallyLost: 0,
      save: jest.fn().mockResolvedValue(undefined),
    };
    const ticketQuery = {
      session: jest.fn().mockReturnThis(),
      exec: jest.fn().mockImplementation(async () => ticket),
    };
    const walletQuery = {
      session: jest.fn().mockReturnThis(),
      exec: jest.fn().mockImplementation(async () => wallet),
    };
    const ticketModel: any = {
      db: { startSession: jest.fn().mockResolvedValue(session) },
      findById: jest.fn().mockReturnValue(ticketQuery),
    };
    const walletModel: any = {
      findOne: jest.fn().mockReturnValue(walletQuery),
    };
    const walletService: any = {
      creditSettlementReturnInSession: jest.fn().mockResolvedValue(undefined),
    };
    const events: any = { record: jest.fn().mockResolvedValue(undefined) };
    const notificationEvents: any = {
      betLabTicketSettled: jest.fn().mockResolvedValue(undefined),
      walletCredited: jest.fn().mockResolvedValue(undefined),
    };
    const service = new BetLabSettlementAdapterService(
      ticketModel,
      walletModel,
      walletService,
      events,
      notificationEvents,
    );

    return {
      service,
      session,
      ticket,
      wallet,
      ticketModel,
      walletModel,
      walletService,
      events,
      notificationEvents,
    };
  };

  const makeInput = (
    overrides: Partial<ApplyBetLabSettlementInput> = {},
  ): ApplyBetLabSettlementInput => ({
    ticketId,
    settlementId: 'SETTLEMENT:fixture-1:ticket-1',
    ticketStatus: BetLabTicketStatus.WON,
    grossReturn: 150,
    resolvedLegs: [
      {
        legId: 'leg-1',
        status: BetLabLegStatus.WON,
        outcomeLabel: 'WON',
      },
    ],
    settledAt: new Date('2026-11-10T17:00:00.000Z'),
    note: 'Automated settlement',
    ...overrides,
  });

  it('credits and finalizes once, then returns an idempotent replay for the same settlement payload', async () => {
    const h = makeHarness();
    const input = makeInput();

    const first = await h.service.applyResolvedTicket(input);
    const replay = await h.service.applyResolvedTicket(input);

    expect(first).toMatchObject({
      ticketId,
      status: BetLabTicketStatus.WON,
      grossReturn: 150,
      alreadyApplied: false,
    });
    expect(replay).toMatchObject({
      ticketId,
      status: BetLabTicketStatus.WON,
      grossReturn: 150,
      alreadyApplied: true,
    });
    expect(h.walletService.creditSettlementReturnInSession).toHaveBeenCalledTimes(1);
    expect(h.wallet.save).toHaveBeenCalledTimes(1);
    expect(h.ticket.save).toHaveBeenCalledTimes(1);
    expect(h.notificationEvents.betLabTicketSettled).toHaveBeenCalledTimes(1);
    expect(h.notificationEvents.walletCredited).toHaveBeenCalledTimes(1);
    expect(h.events.record).toHaveBeenCalledTimes(1);
    expect(h.wallet.ticketsSettled).toBe(1);
    expect(h.wallet.ticketsWon).toBe(1);
  });

  it('rejects reuse of a settlement ID when the result fingerprint differs', async () => {
    const h = makeHarness();
    const input = makeInput();
    await h.service.applyResolvedTicket(input);

    await expect(
      h.service.applyResolvedTicket({ ...input, grossReturn: 175 }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(h.walletService.creditSettlementReturnInSession).toHaveBeenCalledTimes(1);
    expect(h.wallet.save).toHaveBeenCalledTimes(1);
    expect(h.ticket.save).toHaveBeenCalledTimes(1);
  });

  it('rejects a different settlement ID after the ticket is terminal', async () => {
    const h = makeHarness();
    const input = makeInput();
    await h.service.applyResolvedTicket(input);

    await expect(
      h.service.applyResolvedTicket({
        ...input,
        settlementId: 'SETTLEMENT:fixture-2:ticket-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(h.walletService.creditSettlementReturnInSession).toHaveBeenCalledTimes(1);
  });

  it('rejects duplicate resolved-leg IDs before wallet credit', async () => {
    const h = makeHarness();
    const input = makeInput({
      resolvedLegs: [
        { legId: 'leg-1', status: BetLabLegStatus.WON },
        { legId: 'leg-1', status: BetLabLegStatus.WON },
      ],
    });

    await expect(h.service.applyResolvedTicket(input)).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(h.walletService.creditSettlementReturnInSession).not.toHaveBeenCalled();
    expect(h.wallet.save).not.toHaveBeenCalled();
    expect(h.ticket.save).not.toHaveBeenCalled();
  });
});
