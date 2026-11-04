/**
 * Settlement lifecycle helpers.
 *
 * Fixture/scoreboard refreshes own lifecycle discovery. Summary payloads and
 * kickoff timestamps are deliberately excluded from both helpers.
 */
export function isFixtureRefreshExplicitlyNonFinal(value: unknown): boolean {
  const statusRecords = getFixtureFeedStatusRecords(value);
  return statusRecords.some((record) => {
    const type = asRecord(record.type);
    const text = [
      type?.name,
      type?.state,
      type?.detail,
      type?.description,
      type?.shortDetail,
      type?.abbreviation,
      record.name,
      record.state,
      record.detail,
      record.description,
      record.shortDetail,
      record.abbreviation,
    ]
      .map(asString)
      .join(' ')
      .replace(/[_-]+/g, ' ')
      .toUpperCase();
    return /CANCEL|POSTPON|ABANDON|SUSPEND|INTERRUPT|VOID|NO\s*CONTEST/.test(
      text,
    );
  });
}

export function isFixtureRefreshConfirmedFinished(value: unknown): boolean {
  const fixture = asRecord(value);
  if (!fixture || fixture.completed !== true || fixture.live === true)
    return false;
  if (isFixtureRefreshExplicitlyNonFinal(value)) return false;

  const statusRecords = getFixtureFeedStatusRecords(value);
  return statusRecords.some((record) => {
    const type = asRecord(record.type);
    const state = asString(type?.state ?? record.state)
      .trim()
      .toLowerCase();
    const detail = asString(
      type?.detail ?? type?.description ?? record.detail ?? record.description,
    );
    const name = asString(type?.name ?? record.name);
    const shortDetail = asString(type?.shortDetail ?? record.shortDetail);
    const abbreviation = asString(type?.abbreviation ?? record.abbreviation)
      .trim()
      .toUpperCase();
    const text = `${name} ${state} ${detail} ${shortDetail} ${abbreviation}`
      .replace(/[_-]+/g, ' ')
      .toUpperCase();

    return (
      type?.completed === true ||
      record.completed === true ||
      ['post', 'final', 'complete', 'completed', 'finished'].includes(state) ||
      ['FT', 'AET', 'PEN'].includes(abbreviation) ||
      /STATUS FINAL|FULL TIME|FINISHED|COMPLETED|AFTER EXTRA TIME|AFTER PENALTIES|\bFT\b|\bAET\b|\bPEN\b/.test(
        text,
      )
    );
  });
}

function getFixtureFeedStatusRecords(
  value: unknown,
): Record<string, unknown>[] {
  const record = asRecord(value);
  if (!record) return [];
  const source = asRecord(record.payload) ?? record;
  const records: Record<string, unknown>[] = [];
  const rootStatus = asRecord(source.status);
  if (rootStatus) records.push(rootStatus);

  const competitions = Array.isArray(source.competitions)
    ? source.competitions
    : [];
  for (const item of competitions) {
    const competition = asRecord(item);
    if (!competition) continue;
    const status = asRecord(competition.status);
    if (status) records.push(status);
    if (competition.isFinal === true) {
      records.push({ completed: true, name: 'FINAL' });
    }
  }
  return records;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : '';
}
