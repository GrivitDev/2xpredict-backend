export interface SportsDataFilter {
  /**
   * A single UTC calendar date.
   *
   * When provided, the service interprets it as:
   * [date 00:00:00Z, next date 00:00:00Z)
   */
  date?: Date;

  /**
   * Inclusive lower date/time boundary.
   */
  from?: Date;

  /**
   * Exclusive upper date/time boundary.
   */
  to?: Date;

  /**
   * ESPN/application competition (league) identifier.
   */
  competitionId?: string;

  /**
   * Team identifier.
   *
   * For fixture collections, this matches either the home or away team.
   */
  teamId?: string;
}
