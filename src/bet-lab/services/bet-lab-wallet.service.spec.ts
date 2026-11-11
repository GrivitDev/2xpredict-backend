import {
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import type { ClientSession } from 'mongoose';
import { BetLabWalletService } from './bet-lab-wallet.service';
import { BetLabCreditBucket, BetLabLedgerType } from '../enums/bet-lab-ledger-type.enum';

describe('BetLabWalletService stake debit integrity', () => {
  let service: BetLabWalletService;
  let ledgerModel: { create: jest.Mock };
  let events: { record: jest.Mock };

  const createWallet = (overrides: Record<string, unknown> = {}) => ({
    _id: 'wallet-1',
    balance: 750,
    welcomeBalance: 100,
    monthlyBalance: 300,
    winningsBalance: 200,
    bonusBalance: 150,
    totalStaked: 100,
    totalReturns: 250,
    netProfitLoss: 150,
    ticketsPlaced: 1,
    lastTicketAt: undefined as Date | undefined,
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  });

  beforeEach(() => {
    ledgerModel = { create: jest.fn().mockResolvedValue([]) };
    events = { record: jest.fn().mockResolvedValue(undefined) };
    service = new BetLabWalletService(
      {} as never,
      ledgerModel as never,
      {} as never,
      events as never,
      {} as never,
      {} as never,
    );
  });

  it('debits the documented buckets in order and writes one matching ledger entry in the same session', async () => {
    const wallet = createWallet();
    const session = {} as ClientSession;

    await service.debitStakeInSession(
      wallet as never,
      'user-1',
      'ticket-1',
      600,
      'TICKET_STAKE:key-1',
      session,
    );

    expect(wallet.monthlyBalance).toBe(0);
    expect(wallet.bonusBalance).toBe(0);
    expect(wallet.welcomeBalance).toBe(0);
    expect(wallet.winningsBalance).toBe(150);
    expect(wallet.balance).toBe(150);
    expect(wallet.totalStaked).toBe(700);
    expect(wallet.netProfitLoss).toBe(-450);
    expect(wallet.ticketsPlaced).toBe(2);
    expect(wallet.save).toHaveBeenCalledWith({ session });

    expect(ledgerModel.create).toHaveBeenCalledTimes(1);
    const [entries, options] = ledgerModel.create.mock.calls[0];
    expect(options).toEqual({ session, ordered: true });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      userId: 'user-1',
      walletId: 'wallet-1',
      transactionType: BetLabLedgerType.STAKE_DEBIT,
      bucket: BetLabCreditBucket.MIXED,
      delta: -600,
      amount: 600,
      balanceBefore: 750,
      balanceAfter: 150,
      ticketId: 'ticket-1',
      idempotencyKey: 'TICKET_STAKE:key-1',
      metadata: {
        allocation: {
          monthly: 300,
          bonus: 150,
          welcome: 100,
          winnings: 50,
        },
      },
    });
  });

  it('rejects an insufficient balance without saving the wallet or writing a ledger entry', async () => {
    const wallet = createWallet({
      balance: 400,
      monthlyBalance: 200,
      bonusBalance: 100,
      welcomeBalance: 50,
      winningsBalance: 50,
    });

    await expect(
      service.debitStakeInSession(
        wallet as never,
        'user-1',
        'ticket-2',
        401,
        'TICKET_STAKE:key-2',
        {} as ClientSession,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(wallet.save).not.toHaveBeenCalled();
    expect(ledgerModel.create).not.toHaveBeenCalled();
    expect(wallet.balance).toBe(400);
  });

  it('rejects an inconsistent bucket total before changing wallet state', async () => {
    const wallet = createWallet({ balance: 749 });

    await expect(
      service.debitStakeInSession(
        wallet as never,
        'user-1',
        'ticket-3',
        100,
        'TICKET_STAKE:key-3',
        {} as ClientSession,
      ),
    ).rejects.toBeInstanceOf(InternalServerErrorException);

    expect(wallet.save).not.toHaveBeenCalled();
    expect(ledgerModel.create).not.toHaveBeenCalled();
    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'WALLET_BALANCE_INVARIANT_FAILED' }),
    );
  });

  it('rejects fractional stakes before touching the wallet', async () => {
    const wallet = createWallet();

    await expect(
      service.debitStakeInSession(
        wallet as never,
        'user-1',
        'ticket-4',
        10.5,
        'TICKET_STAKE:key-4',
        {} as ClientSession,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(wallet.save).not.toHaveBeenCalled();
    expect(ledgerModel.create).not.toHaveBeenCalled();
  });
});
