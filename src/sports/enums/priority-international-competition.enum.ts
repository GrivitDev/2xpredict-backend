/**
 * Curated international competitions that receive ELITE, HIGH, or REGIONAL
 * priority. Unlisted ESPN competitions remain SELECTIVE.
 */
export enum PriorityInternationalCompetition {
  // Major international tournaments
  FIFA_WORLD_CUP = 'fifa.world',
  UEFA_EURO = 'uefa.euro',
  AFCON = 'caf.nations',
  COPA_AMERICA = 'conmebol.america',

  // Qualifiers and major international leagues/tournaments
  FIFA_WORLD_CUP_QUALIFIERS = 'fifa.worldq',
  FIFA_WORLD_CUP_QUALIFIERS_UEFA = 'fifa.worldq.uefa',
  FIFA_WORLD_CUP_QUALIFIERS_CAF = 'fifa.worldq.caf',
  FIFA_WORLD_CUP_QUALIFIERS_AFC = 'fifa.worldq.afc',
  FIFA_WORLD_CUP_QUALIFIERS_CONCACAF = 'fifa.worldq.concacaf',
  FIFA_WORLD_CUP_QUALIFIERS_CONMEBOL = 'fifa.worldq.conmebol',
  AFCON_QUALIFIERS = 'caf.nations_qual',
  UEFA_EURO_QUALIFIERS = 'uefa.euroq',
  UEFA_NATIONS_LEAGUE = 'uefa.nations',
  CONCACAF_GOLD_CUP = 'concacaf.gold',
  CONCACAF_NATIONS_LEAGUE = 'concacaf.nations.league',
  AFC_ASIAN_CUP = 'afc.asian.cup',

  // Additional major women's and multi-sport tournaments
  FIFA_WOMENS_WORLD_CUP = 'fifa.wwc',
  UEFA_WOMENS_EURO = 'uefa.weuro',
  CONCACAF_WOMENS_GOLD_CUP = 'concacaf.w.gold',
  MENS_OLYMPIC_SOCCER = 'fifa.olympics',
}

