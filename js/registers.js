/* registers.js — the club's members, classes and combinations.
 *
 * Reference data lives in Supabase and is cached on the phone, but it is also
 * creatable on the beach: a visitor turns up, a new class is needed, and none
 * of that can wait for signal. Everything here goes through localWrite, so a
 * combination created with no signal syncs like any other row.
 *
 * There is no boats table. Named hulls were dropped in 017: they added a
 * decision at every sign-on for a club that thinks in pairings, and what an
 * OOD actually needs is a sail number, which is a fact about one race and
 * lives on the entry.
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

/* ---- combinations --------------------------------------------------------
 *
 * Helm (+ crew) in a class: the identity that persists at this club. Held as
 * a real table rather than derived from entry history, because a derived list
 * is empty on the first morning of the fortnight — the busiest sign-on of the
 * year — and the club already knows its regular pairings.
 *
 * Self-maintaining as well as editable: every entry upserts its combination,
 * so a pairing nobody thought to write down still appears after its first
 * race.
 * ----------------------------------------------------------------------- */

/** Identity, with null crew treated as a value rather than a missing field. */
export function combinationKey({ helmId, crewId = null, classId }) {
  return `${helmId}|${crewId ?? ""}|${classId}`;
}

export function keyOf(row) {
  return combinationKey({
    helmId: row.helm_id,
    crewId: row.crew_id ?? null,
    classId: row.class_id,
  });
}

/**
 * Every active combination, in the order sign-on should offer them: the
 * pairings that race most often first, then the ones that raced most
 * recently. A brand-new combination has raced nothing and sorts last, which
 * is right — it is already on screen because someone just created it.
 */
export async function listCombinations({ includeRetired = false } = {}) {
  const [rows, members, classes] = await Promise.all([
    db.getAll("combinations"),
    db.getAll("helms"),
    db.getAll("classes"),
  ]);
  const helmById = new Map(members.map((m) => [m.id, m]));
  const classById = new Map(classes.map((c) => [c.id, c]));

  return rows
    .filter((row) => includeRetired || row.active !== false)
    .map((row) => ({
      ...row,
      helm: helmById.get(row.helm_id) ?? null,
      crew: row.crew_id ? helmById.get(row.crew_id) ?? null : null,
      klass: classById.get(row.class_id) ?? null,
    }))
    /* A combination whose helm or class has gone from the register cannot be
       displayed or signed on, so it is not offered. The row survives for the
       history it belongs to. */
    .filter((row) => row.helm && row.klass)
    .sort(
      (a, b) =>
        (b.times_raced ?? 0) - (a.times_raced ?? 0) ||
        String(b.last_raced ?? "").localeCompare(String(a.last_raced ?? "")) ||
        a.helm.name.localeCompare(b.helm.name)
    );
}

/** Find an existing combination by identity, retired ones included. */
export async function findCombination({ helmId, crewId = null, classId }) {
  const rows = await db.getAllByIndex("combinations", "by_helm", helmId);
  const key = combinationKey({ helmId, crewId, classId });
  return rows.find((row) => keyOf(row) === key) ?? null;
}

export async function createCombination({
  helmId,
  crewId = null,
  classId,
  defaultSailNo = "",
}) {
  if (!helmId) throw new Error("A combination needs a helm.");
  if (!classId) throw new Error("A combination needs a class — that is where the PY comes from.");
  if (crewId && crewId === helmId) throw new Error("The helm cannot also be the crew.");

  /* Never two rows for one pairing: a duplicate would split its handicap
     history exactly the way a duplicate member does. An existing retired row
     is brought back rather than replaced. */
  const existing = await findCombination({ helmId, crewId, classId });
  if (existing) {
    const revived = {
      ...existing,
      active: true,
      default_sail_no: String(defaultSailNo ?? existing.default_sail_no ?? "").trim() || null,
    };
    await db.localWrite("combinations", revived);
    return revived;
  }

  const row = {
    id: db.newId(),
    helm_id: helmId,
    crew_id: crewId ?? null,
    class_id: classId,
    default_sail_no: String(defaultSailNo ?? "").trim() || null,
    times_raced: 0,
    last_raced: null,
    active: true,
    created_at: db.nowIso(),
  };
  await db.localWrite("combinations", row);
  return row;
}

export async function updateCombination(id, { defaultSailNo, active } = {}) {
  const current = await db.get("combinations", id);
  if (!current) throw new Error("That combination is not in the register.");
  const row = { ...current };
  if (defaultSailNo !== undefined) {
    row.default_sail_no = String(defaultSailNo ?? "").trim() || null;
  }
  if (active !== undefined) row.active = Boolean(active);
  await db.localWrite("combinations", row);
  return row;
}

/** Retire a combination without destroying the history it belongs to. */
export async function retireCombination(id) {
  return updateCombination(id, { active: false });
}

export async function reviveCombination(id) {
  return updateCombination(id, { active: true });
}

/**
 * Record that this pairing raced.
 *
 * Called on every entry, so the sign-on order reflects what the club actually
 * sails rather than what somebody once typed. Creates the row if it is new,
 * which is how a combination nobody seeded still appears after its first race.
 *
 * `at` is the race date rather than now: entering a race retrospectively must
 * not make an old pairing look like the most recent one.
 */
export async function recordCombinationRaced({
  helmId,
  crewId = null,
  classId,
  sailNo = "",
  at = null,
}) {
  const when = at ?? db.nowIso();
  const existing = await findCombination({ helmId, crewId, classId });

  if (!existing) {
    const created = await createCombination({ helmId, crewId, classId, defaultSailNo: sailNo });
    const raced = {
      ...created,
      times_raced: 1,
      last_raced: when,
    };
    await db.localWrite("combinations", raced);
    return raced;
  }

  const row = {
    ...existing,
    times_raced: (existing.times_raced ?? 0) + 1,
    // Signing a retired pairing on is how you un-retire it.
    active: true,
    last_raced:
      String(when).localeCompare(String(existing.last_raced ?? "")) > 0
        ? when
        : existing.last_raced,
    /* A pairing with no remembered number takes the one just used; one that
       has a number keeps it, because a single borrowed boat should not
       rewrite what they normally sail. */
    default_sail_no: existing.default_sail_no || String(sailNo ?? "").trim() || null,
  };
  await db.localWrite("combinations", row);
  return row;
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
