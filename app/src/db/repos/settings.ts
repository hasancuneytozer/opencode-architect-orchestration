/** `settings` tablosu — anahtar/değer yapılandırma. */
import { type Db, nowIso } from "./../base.js";
import { fromJson, toJson } from "./../json.js";

export class SettingsRepo {
  constructor(private readonly db: Db) {}

  /** Değer okunur; yoksa `fallback` döner. */
  get<T>(key: string, fallback: T): T {
    const r = this.db
      .prepare<[string], { value_json: string }>("SELECT value_json FROM settings WHERE key = ?")
      .get(key);
    if (!r) return fallback;
    return fromJson<T>(r.value_json, fallback);
  }

  has(key: string): boolean {
    const r = this.db
      .prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM settings WHERE key = ?")
      .get(key);
    return (r?.n ?? 0) > 0;
  }

  set<T>(key: string, value: T): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                                        updated_at = excluded.updated_at`,
      )
      .run(key, toJson(value), nowIso());
  }

  delete(key: string): boolean {
    return this.db.prepare("DELETE FROM settings WHERE key = ?").run(key).changes > 0;
  }

  list(limit = 200): Array<{ key: string; value: unknown; updatedAt: string }> {
    return this.db
      .prepare<[number], { key: string; value_json: string; updated_at: string }>(
        "SELECT key, value_json, updated_at FROM settings ORDER BY key LIMIT ?",
      )
      .all(limit)
      .map((r) => ({ key: r.key, value: fromJson<unknown>(r.value_json, null), updatedAt: r.updated_at }));
  }
}
