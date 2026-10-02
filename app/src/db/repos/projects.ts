/** `projects` tablosu. */
import type { Project } from "../../contract/index.js";
import { type Db, type IdFactory, nowIso, uuid } from "../base.js";

interface Row {
  id: string;
  name: string;
  notes: string | null;
  created_at: string;
}

function toModel(r: Row): Project {
  return { id: r.id, name: r.name, notes: r.notes, createdAt: r.created_at };
}

export interface CreateProjectInput {
  id?: string;
  name: string;
  notes?: string | null;
}

export class ProjectRepo {
  constructor(
    private readonly db: Db,
    private readonly ids: IdFactory = uuid,
  ) {}

  create(input: CreateProjectInput): Project {
    const row: Row = {
      id: input.id ?? this.ids(),
      name: input.name,
      notes: input.notes ?? null,
      created_at: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO projects (id, name, notes, created_at)
         VALUES (@id, @name, @notes, @created_at)`,
      )
      .run(row);
    return toModel(row);
  }

  getById(id: string): Project | null {
    const r = this.db.prepare<[string], Row>("SELECT * FROM projects WHERE id = ?").get(id);
    return r ? toModel(r) : null;
  }

  findByName(name: string): Project | null {
    const r = this.db
      .prepare<[string], Row>("SELECT * FROM projects WHERE name = ? ORDER BY created_at LIMIT 1")
      .get(name);
    return r ? toModel(r) : null;
  }

  /** Ingest isteğinde verilen ad yoksa oluşturur, varsa döndürür. */
  ensure(name: string, notes: string | null = null): Project {
    return this.findByName(name) ?? this.create({ name, notes });
  }

  list(limit = 100, offset = 0): Project[] {
    return this.db
      .prepare<[number, number], Row>(
        "SELECT * FROM projects ORDER BY created_at DESC, id LIMIT ? OFFSET ?",
      )
      .all(limit, offset)
      .map(toModel);
  }

  setNotes(id: string, notes: string | null): boolean {
    return this.db.prepare("UPDATE projects SET notes = ? WHERE id = ?").run(notes, id).changes > 0;
  }

  remove(id: string): boolean {
    // contents.project_id ON DELETE RESTRICT: içerik varsa SQLite reddeder.
    return this.db.prepare("DELETE FROM projects WHERE id = ?").run(id).changes > 0;
  }

  count(): number {
    const r = this.db
      .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM projects")
      .get();
    return r?.n ?? 0;
  }
}
