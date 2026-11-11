import { BetLabTicketService } from './bet-lab-ticket.service';
import { BetLabTicketType } from '../enums/bet-lab-ticket-type.enum';
import { BetLabTicketStatus } from '../enums/bet-lab-ticket-status.enum';
import { BetLabMarketCode } from '../enums/bet-lab-market-code.enum';
import { BET_LAB_PRICING_SNAPSHOT_VERSION } from '../utils/bet-lab-pricing-snapshot.util';

describe('BetLabTicketService placement transaction boundary', () => {
  const createQuote = () => ({
    fixture: {
      eventId: 'fixture-1',
      leagueId: 'league-1',
      leagueName: 'League 1',
      fixtureDate: new Date(Date.now() + 60 * 60 * 1000),
      homeTeamId: 'team-home',
      homeTeamName: 'Home',
      awayTeamId: 'team-away',
      awayTeamName: 'Away',
      live: false,
      completed: false,
      status: 'SCHEDULED',
    },
    market: {
      code: BetLabMarketCode.MATCH_RESULT,
      jsonVariable: 'match_result',
      fullName: 'Match Result',
      abbreviation: '1X2',
    },
    selection: {
      code: 'HOME',
      jsonVariable: 'home',
      fullName: 'Home Win',
      abbreviation: '1',
    },
    decimalOdds: 2.5,
    oddsSource: 'GRIVIT',
    priceType: 'PRE_MATCH',
    oddsTimestampBasis: 'CAPTURED_AT',
    oddsCapturedAt: new Date(),
    isFresh: true,
  });

  const createService = (debitImplementation = jest.fn().mockResolvedValue(undefined)) => {
    const session = {
      withTransaction: jest.fn(async (callback: () => Promise<void>) => callback()),
      endSession: jest.fn().mockResolvedValue(undefined),
    };
    const ticketQuery = {
      session: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(null),
    };
    const ledgerQuery = {
      session: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(null),
    };
    const ticketModel = {
      db: { startSession: jest.fn().mockResolvedValue(session) },
      findOne: jest.fn().mockReturnValue(ticketQuery),
      create: jest.fn().mockResolvedValue([{ _id: 'ticket-1' }]),
    };
    const ledgerModel = {
      findOne: jest.fn().mockReturnValue(ledgerQuery),
    };
    const wallet = { _id: 'wallet-1', balance: 900 };
    const walletService = {
      getCurrentEntitlement: jest.fn().mockResolvedValue({ plan: 'free' }),
      ensureWalletInSession: jest.fn().mockResolvedValue(wallet),
      debitStakeInSession: debitImplementation,
      toSnapshot: jest.fn().mockReturnValue({ balance: 900 }),
      getExistingWalletSnapshotInSession: jest.fn().mockResolvedValue({ balance: 800 }),
      dispatchRecentAllowanceNotifications: jest.fn().mockResolvedValue(undefined),
    };
    const events = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new BetLabTicketService(
      ticketModel as never,
      ledgerModel as never,
      {} as never,
      walletService as never,
      events as never,
      {} as never,
      {} as never,
      {} as never,
    );

    // Isolate the transaction boundary from the market-read and initial
    // idempotency-query collaborators; their behavior has separate coverage.
    Reflect.set(service, 'findExistingByIdempotency', jest.fn().mockResolvedValue(null));
    Reflect.set(service, 'revalidateSelectionQuotes', jest.fn().mockResolvedValue(undefined));

    return {
      service,
      session,
      ticketModel,
      ledgerModel,
      wallet,
      walletService,
      events,
    };
  };

  it('creates the ticket and debits its wallet inside the same Mongo session', async () => {
    const context = createService();
    const quote = createQuote();

    const placeTicketAtomic = Reflect.get(context.service, 'placeTicketAtomic') as (...args: unknown[]) => Promise<unknown>;
    const result = await placeTicketAtomic.call(context.service,
      'user-1',
      BetLabTicketType.SINGLE,
      100,
      'key-transaction-1',
      'single-fingerprint',
      [quote],
    );

    expect(context.session.withTransaction).toHaveBeenCalledTimes(1);
    expect(context.ticketModel.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          userId: 'user-1',
          ticketType: BetLabTicketType.SINGLE,
          status: BetLabTicketStatus.OPEN,
          stake: 100,
          combinedOdds: 2.5,
          potentialReturn: 250,
          idempotencyKey: 'key-transaction-1',
          pricingSnapshotVersion: BET_LAB_PRICING_SNAPSHOT_VERSION,
          pricingSnapshotFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          pricingSnapshotCapturedAt: expect.any(Date),
          legs: [expect.objectContaining({ oddsSnapshotFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) })],
        }),
      ],
      { session: context.session },
    );
    expect(context.walletService.debitStakeInSession).toHaveBeenCalledWith(
      context.wallet,
      'user-1',
      'ticket-1',
      100,
      'TICKET_STAKE:key-transaction-1',
      context.session,
    );
    expect(context.ticketModel.create.mock.invocationCallOrder[0]).toBeLessThan(
      context.walletService.debitStakeInSession.mock.invocationCallOrder[0],
    );
    expect(context.session.endSession).toHaveBeenCalledTimes(1);
    expect(context.walletService.dispatchRecentAllowanceNotifications).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ticket: { _id: 'ticket-1' },
      alreadyPlaced: false,
      wallet: { balance: 900 },
    });
  });

  it('replays an existing ticket found inside the transaction without another debit', async () => {
    const context = createService();
    const existingTicket = {
      _id: 'ticket-existing',
      requestFingerprint: 'single-fingerprint',
      idempotencyKey: 'key-transaction-replay',
    };
    context.ticketModel.findOne.mockReturnValue({
      session: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(existingTicket),
    });

    const placeTicketAtomic = Reflect.get(context.service, 'placeTicketAtomic') as (...args: unknown[]) => Promise<unknown>;
    const result = await placeTicketAtomic.call(context.service,
      'user-1',
      BetLabTicketType.SINGLE,
      100,
      'key-transaction-replay',
      'single-fingerprint',
      [createQuote()],
    );

    expect(context.ticketModel.create).not.toHaveBeenCalled();
    expect(context.walletService.debitStakeInSession).not.toHaveBeenCalled();
    expect(context.walletService.getExistingWalletSnapshotInSession).toHaveBeenCalledWith(
      'user-1',
      context.session,
    );
    expect(result).toMatchObject({
      ticket: existingTicket,
      alreadyPlaced: true,
      wallet: { balance: 800 },
    });
  });

  it('does not return a placed ticket when the wallet debit fails inside the transaction', async () => {
    const debit = jest.fn().mockRejectedValue(new Error('ledger write failed'));
    const context = createService(debit);

    const placeTicketAtomic = Reflect.get(context.service, 'placeTicketAtomic') as (...args: unknown[]) => Promise<unknown>;
    await expect(
      placeTicketAtomic.call(context.service,
        'user-1',
        BetLabTicketType.SINGLE,
        100,
        'key-transaction-2',
        'single-fingerprint',
        [createQuote()],
      ),
    ).rejects.toThrow('ledger write failed');

    expect(context.ticketModel.create).toHaveBeenCalledTimes(1);
    expect(context.walletService.debitStakeInSession).toHaveBeenCalledTimes(1);
    expect(context.session.endSession).toHaveBeenCalledTimes(1);
    expect(context.walletService.dispatchRecentAllowanceNotifications).not.toHaveBeenCalled();
  });

  it('does not proceed to ticket creation when an existing stake ledger key is found', async () => {
    const context = createService();
    context.ledgerModel.findOne.mockReturnValue({
      session: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue({ _id: 'ledger-existing' }),
    });

    const placeTicketAtomic = Reflect.get(context.service, 'placeTicketAtomic') as (...args: unknown[]) => Promise<unknown>;
    await expect(
      placeTicketAtomic.call(context.service,
        'user-1',
        BetLabTicketType.SINGLE,
        100,
        'key-transaction-3',
        'single-fingerprint',
        [createQuote()],
      ),
    ).rejects.toThrow('This idempotency key was already used.');

    expect(context.ticketModel.create).not.toHaveBeenCalled();
    expect(context.walletService.debitStakeInSession).not.toHaveBeenCalled();
    expect(context.session.endSession).toHaveBeenCalledTimes(1);
  });
});

