export class EspnPayloadUtil {
  static asRecord(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, any>)
      : {};
  }

  static asArray(value: unknown): any[] {
    return Array.isArray(value) ? value : [];
  }

  static finiteNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value.replace(/%/g, '').trim());
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  static firstNonEmpty(...values: unknown[]): string | undefined {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (typeof value === 'number' && Number.isFinite(value))
        return String(value);
    }
    return undefined;
  }

  static findStatistic(
    statistics: unknown,
    candidates: string[],
  ): number | null {
    const wanted = new Set(candidates.map((value) => this.normalizeKey(value)));
    for (const entry of this.asArray(statistics)) {
      const record = this.asRecord(entry);
      const keys = [
        record.name,
        record.abbreviation,
        record.label,
        record.displayName,
      ]
        .filter((value) => typeof value === 'string')
        .map((value) => this.normalizeKey(value));
      if (!keys.some((key) => wanted.has(key))) continue;
      const value = this.finiteNumber(
        record.displayValue ?? record.value ?? record.valueDisplay,
      );
      if (value !== null) return value;
    }
    return null;
  }

  static normalizeKey(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  static findRecursive(
    value: unknown,
    predicate: (record: Record<string, any>) => boolean,
    maxDepth = 10,
  ): Record<string, any>[] {
    const result: Record<string, any>[] = [];
    const visit = (current: unknown, depth: number): void => {
      if (depth > maxDepth || current === null || current === undefined) return;
      if (Array.isArray(current)) {
        for (const item of current) visit(item, depth + 1);
        return;
      }
      if (typeof current !== 'object') return;
      const record = current as Record<string, any>;
      if (predicate(record)) result.push(record);
      for (const entry of Object.values(record)) {
        if (entry && typeof entry === 'object') visit(entry, depth + 1);
      }
    };
    visit(value, 0);
    return result;
  }

  static toValidDate(value: unknown): Date | null {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
    if (typeof value === 'string' || typeof value === 'number') {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    return null;
  }
}

