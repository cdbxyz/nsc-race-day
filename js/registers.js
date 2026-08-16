/* registers.js — the club's boats, helms and classes.
 *
 * Reference data lives in Supabase and is cached on the phone, but it is also
 * creatable on the beach: a visitor turns up, a new boat needs a class, and
 * none of that can wait for signal. Everything here goes through localWrite,
 * so a boat created with no signal syncs like any other row.
 */

import * as db from "./db.js";

/* ---- classes ------------------------------------------------------------ */

export async function listClasses() {
  const classes = await db.getAll("classes");
  return classes.sort((a, b) => a.name.localeCompare(b.name));
}

export async function createClass({ name, basePy, crewSize = 1 }) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) throw new Error("A class needs a name.");
  const py = Number(basePy);
  if (!Number.isFinite(py) || py <= 0) throw new Error("A class needs a base PY.");

  const existing = (await listClasses()).find(
    (c) => c.name.toLowerCase() === trimmed.toLowerCase()
  );
  if (existing) throw new Error(`${existing.name} is already in the register.`);

  const row = {
    id: db.newId(),
    name: trimmed,
    base_py: Math.round(py),
    crew_size: Number(crewSize) === 2 ? 2 : 1,
    created_at: db.nowIso(),
  };
  await db.localWrite("classes", row);
  return row;
}

export async function updateClass(id, { name, basePy, crewSize }) {
  const current = await db.get("classes", id);
  if (!current) throw new Error("That class is not in the register.");
  const row = {
    ...current,
    name: String(name ?? current.name).trim(),
    base_py: Math.round(Number(basePy ?? current.base_py)),
    crew_size: crewSize == null ? (current.crew_size ?? 1) : Number(crewSize) === 2 ? 2 : 1,
  };
  await db.localWrite("classes", row);
  return row;
}

/**
 * Parse a pasted "class,base_py" list. Pure, so the awkward cases are testable.
 *
 * Forgiving about what a volunteer will actually paste: a header row, blank
 * lines, semicolons or tabs instead of commas, spaces around values, and
 * quoted names containing a comma.
 *
 * @returns {{rows: Array<{name:string, base_py:number}>, errors: string[]}}
 */
export function parseClassCsv(text) {
  const rows = [];
  const errors = [];
  const seen = new Set();

  const lines = String(text ?? "").split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;

    // Split on the LAST separator, so "Laser 2000, Mk2,1122" keeps its comma.
    const match = /^(.*)[,;\t]\s*([^,;\t]+)$/.exec(line);
    if (!match) {
      errors.push(`Line ${index + 1}: expected "class name, PY" — got "${line}"`);
      return;
    }

    let name = match[1].trim().replace(/^"(.*)"$/, "$1").trim();
    const pyText = match[2].trim();

    // Skip a header row rather than reporting it as an error.
    if (/^(class|class name|name)$/i.test(name) && /^(py|base_?py)$/i.test(pyText)) return;

    if (!name) {
      errors.push(`Line ${index + 1}: no class name`);
      return;
    }
    const py = Number(pyText);
    if (!Number.isFinite(py) || py <= 0) {
      errors.push(`Line ${index + 1}: "${pyText}" is not a PY`);
      return;
    }

    const key = name.toLowerCase();
    if (seen.has(key)) {
      errors.push(`Line ${index + 1}: ${name} appears more than once`);
      return;
    }
    seen.add(key);
    rows.push({ name, base_py: Math.round(py) });
  });

  return { rows, errors };
}

/**
 * Bulk-create classes from pasted CSV. Classes already in the register are
 * skipped rather than duplicated, so the paste can safely be repeated.
 */
export async function seedClassesFromCsv(text) {
  const { rows, errors } = parseClassCsv(text);
  const existing = new Map(
    (await listClasses()).map((c) => [c.name.toLowerCase(), c])
  );

  const created = [];
  const skipped = [];
  for (const row of rows) {
    if (existing.has(row.name.toLowerCase())) {
      skipped.push(row.name);
      continue;
    }
    const created_row = {
      id: db.newId(),
      name: row.name,
      base_py: row.base_py,
      crew_size: 1,
      created_at: db.nowIso(),
    };
    await db.localWrite("classes", created_row);
    created.push(created_row);
  }
  return { created, skipped, errors };
}

/* ---- boats -------------------------------------------------------------- */

export async function listBoats() {
  const [boats, classes] = await Promise.all([db.getAll("boats"), db.getAll("classes")]);
  const byId = new Map(classes.map((c) => [c.id, c]));
  return boats
    .filter((b) => b.active !== false)
    .map((b) => ({ ...b, klass: byId.get(b.class_id) ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function createBoat({ name, sailNo, classId }) {
  const trimmed = String(name ?? "").trim();
  const sail = String(sailNo ?? "").trim();
  if (!trimmed && !sail) throw new Error("A hull needs a name or a sail number.");
  if (!classId) throw new Error("A boat needs a class — that is where its PY comes from.");
  if (/\+/.test(trimmed)) {
    // The workaround this redesign exists to remove.
    throw new Error("Boats are hulls, not pairings. Record the crew on the entry instead.");
  }

  const row = {
    id: db.newId(),
    name: trimmed || null,
    sail_no: String(sailNo ?? "").trim() || null,
    class_id: classId,
    active: true,
    created_at: db.nowIso(),
  };
  await db.localWrite("boats", row);
  return row;
}

export async function updateBoat(id, { name, sailNo, classId }) {
  const current = await db.get("boats", id);
  if (!current) throw new Error("That boat is not in the register.");
  const row = {
    ...current,
    name: String(name ?? current.name).trim(),
    sail_no: String(sailNo ?? current.sail_no ?? "").trim() || null,
    class_id: classId ?? current.class_id,
  };
  await db.localWrite("boats", row);
  return row;
}

/** Retire a boat without destroying its history. */
export async function retireBoat(id) {
  const current = await db.get("boats", id);
  if (!current) return;
  await db.localWrite("boats", { ...current, active: false });
}

/* ---- people --------------------------------------------------------------
 * One register for everybody. A person helms one week and crews the next, so
 * there is deliberately no second list — `helms` is the members register.
 * ----------------------------------------------------------------------- */

export const listMembers = () => listHelms();
export const createMember = (args) => createHelm(args);

export async function listHelms() {
  const helms = await db.getAll("helms");
  return helms.sort((a, b) => a.name.localeCompare(b.name));
}

export async function createHelm({ name }) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) throw new Error("A helm needs a name.");

  const existing = (await listHelms()).find(
    (h) => h.name.toLowerCase() === trimmed.toLowerCase()
  );
  if (existing) return existing; // same person, not a duplicate record

  const row = { id: db.newId(), name: trimmed, created_at: db.nowIso() };
  await db.localWrite("helms", row);
  return row;
}
