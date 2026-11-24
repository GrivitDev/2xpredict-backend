import { BadRequestException } from '@nestjs/common';

import { SportsDomainReadController } from './sports-domain-read.controller';

describe('SportsDomainReadController team lookup', () => {
  const createController = () => {
    const read = {
      getTeamsByIdentifiers: jest.fn().mockResolvedValue([]),
    };
    return {
      controller: new SportsDomainReadController(read as any),
      read,
    };
  };

  it('resolves a deduplicated, trimmed list of canonical or ESPN team IDs in one service call', async () => {
    const { controller, read } = createController();

    await expect(controller.lookupTeams([' team:123 ', '456', 'team:123']))
      .resolves.toEqual([]);

    expect(read.getTeamsByIdentifiers).toHaveBeenCalledTimes(1);
    expect(read.getTeamsByIdentifiers).toHaveBeenCalledWith(['team:123', '456']);
  });

  it('returns an empty list without querying when no IDs are supplied', async () => {
    const { controller, read } = createController();

    await expect(controller.lookupTeams([])).resolves.toEqual([]);
    expect(read.getTeamsByIdentifiers).not.toHaveBeenCalled();
  });

  it('rejects non-array payloads', () => {
    const { controller } = createController();
    expect(() => controller.lookupTeams({ ids: ['team:123'] }))
      .toThrow(BadRequestException);
  });

  it('rejects oversized batches', () => {
    const { controller } = createController();
    expect(() => controller.lookupTeams(Array.from({ length: 1001 }, (_, index) => String(index))))
      .toThrow(BadRequestException);
  });

  it('rejects invalid identifiers', () => {
    const { controller } = createController();
    expect(() => controller.lookupTeams(['team:123', null]))
      .toThrow(BadRequestException);
  });
});
