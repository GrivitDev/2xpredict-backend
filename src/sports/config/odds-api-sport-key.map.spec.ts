import { getOddsApiSportKey } from './odds-api-sport-key.map';

describe('Odds API sport-key mappings', () => {
  it('maps Spanish Copa del Rey to the supported Odds API key', () => {
    expect(getOddsApiSportKey('esp.copa_del_rey')).toBe(
      'soccer_spain_copa_del_rey',
    );
  });

  it("maps UEFA Women's Champions League to the supported Odds API key", () => {
    expect(getOddsApiSportKey('uefa.wchampions')).toBe(
      'soccer_uefa_champs_league_women',
    );
  });
});
