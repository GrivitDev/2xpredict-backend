export enum CompetitionPriority {
  /**
   * Highest-priority competitions.
   *
   * These competitions are considered first when
   * allocating prediction and fixture-collection resources.
   */
  ELITE = 'ELITE',

  /**
   * Strong global and regional competitions.
   */
  HIGH = 'HIGH',

  /**
   * Relevant regional competitions.
   */
  REGIONAL = 'REGIONAL',

  /**
   * Lower-priority competitions.
   *
   * These remain supported when present in the ESPN catalogue,
   * but they receive lower priority when resources are allocated.
   */
  SELECTIVE = 'SELECTIVE',
}
