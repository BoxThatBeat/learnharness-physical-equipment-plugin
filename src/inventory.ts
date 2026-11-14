/** Pure inventory model: validation, stable IDs, import merge and prompt summaries.
 * No I/O here so it can be unit-tested and shared by backend and frontend. */

export const STATE_VERSION = 1;
export const LIMITS = {
  items: 500,
  name: 120,
  notes: 500,
  quantity: 100_000,
  importText: 20_000,
  summaryChars: 1_500,
} as const;

export type ModelChoice = { provider: string; id: string };

export type EquipmentItem = {
  /** Stable, never reused: lab payloads refer to items by this ID. */
  id: string;
  name: string;
  quantity: number;
  notes: string;
};

/** One row of an editable list sent from Settings; `id` is absent for new rows. */
export type ItemDraft = { id?: string; name: string; quantity: number; notes: string };

/** One parsed import row. `match` is the existing item it would update, or null for new. */
export type ImportRow = { name: string; quantity: number; notes: string; match: string | null };

export type PendingImport =
  | { status: "running"; requestId: string; taskId: string | null; startedAt: string }
  | { status: "ready"; requestId: string; rows: ImportRow[] }
  | { status: "failed"; requestId: string; error: string };

export type LabState = {
  version: typeof STATE_VERSION;
  labsEnabled: boolean;
  modelOverride: ModelChoice | null;
  nextId: number;
  items: EquipmentItem[];
  pendingImport: PendingImport | null;
};

export function emptyState(): LabState {
  return { version: STATE_VERSION, labsEnabled: true, modelOverride: null, nextId: 1, items: [], pendingImport: null };
}

export function normalizeName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate one row's fields; returns readable problems, never cleans silently beyond trimming name/notes. */
export function itemProblems(row: { name: unknown; quantity: unknown; notes: unknown }, label: string): string[] {
  const problems: string[] = [];
  if (typeof row.name !== "string" || !row.name.trim()) problems.push(`${label}: name is required.`);
  else if (row.name.trim().length > LIMITS.name) problems.push(`${label}: name is longer than ${LIMITS.name} characters.`);
  if (typeof row.quantity !== "number" || !Number.isInteger(row.quantity) || row.quantity < 0 || row.quantity > LIMITS.quantity) {
    problems.push(`${label}: quantity must be a whole number from 0 to ${LIMITS.quantity}.`);
  }
  if (typeof row.notes !== "string") problems.push(`${label}: notes must be text.`);
  else if (row.notes.trim().length > LIMITS.notes) problems.push(`${label}: notes are longer than ${LIMITS.notes} characters.`);
  return problems;
}

function fail(problems: string[]): never {
  throw new Error(problems.slice(0, 5).join(" ") + (problems.length > 5 ? ` (${problems.length - 5} more problems)` : ""));
}

function readModel(value: unknown): ModelChoice | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || typeof value.provider !== "string" || typeof value.id !== "string" || !value.provider || !value.id) {
    throw new Error("Saved model override is malformed.");
  }
  return { provider: value.provider, id: value.id };
}

function readRows(value: unknown): ImportRow[] {
  if (!Array.isArray(value)) throw new Error("Saved import preview is malformed.");
  return value.map((row, index) => {
    if (!isRecord(row)) throw new Error("Saved import preview is malformed.");
    const problems = itemProblems(row as ImportRow, `Preview row ${index + 1}`);
    if (problems.length) fail(problems);
    if (row.match !== null && typeof row.match !== "string") throw new Error("Saved import preview is malformed.");
    return { name: (row.name as string).trim(), quantity: row.quantity as number, notes: (row.notes as string).trim(), match: row.match as string | null };
  });
}

function readPending(value: unknown): PendingImport | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || typeof value.requestId !== "string") throw new Error("Saved import state is malformed.");
  if (value.status === "running") {
    return {
      status: "running", requestId: value.requestId,
      taskId: typeof value.taskId === "string" ? value.taskId : null,
      startedAt: typeof value.startedAt === "string" ? value.startedAt : new Date(0).toISOString(),
    };
  }
  if (value.status === "ready") return { status: "ready", requestId: value.requestId, rows: readRows(value.rows) };
  if (value.status === "failed") return { status: "failed", requestId: value.requestId, error: String(value.error ?? "Import failed.") };
  throw new Error("Saved import state is malformed.");
}

/** Parse saved state. Refuses newer formats rather than rewriting them. */
export function parseState(raw: unknown): LabState {
  if (!isRecord(raw)) throw new Error("Saved lab equipment data is not an object.");
  if (typeof raw.version !== "number") throw new Error("Saved lab equipment data has no version.");
  if (raw.version > STATE_VERSION) {
    throw new Error(`Saved lab equipment data uses format ${raw.version}, newer than this plugin understands (${STATE_VERSION}). Update the plugin; the file was not changed.`);
  }
  if (raw.version !== STATE_VERSION) throw new Error(`Unsupported lab equipment data format ${raw.version}.`);
  if (!Array.isArray(raw.items)) throw new Error("Saved equipment list is malformed.");
  const ids = new Set<string>();
  const items = raw.items.map((item, index): EquipmentItem => {
    if (!isRecord(item) || typeof item.id !== "string" || !/^eq-\d+$/.test(item.id) || ids.has(item.id)) {
      throw new Error(`Saved item ${index + 1} has a missing or duplicate ID.`);
    }
    ids.add(item.id);
    const problems = itemProblems(item as EquipmentItem, `Saved item ${index + 1}`);
    if (problems.length) fail(problems);
    return { id: item.id, name: (item.name as string).trim(), quantity: item.quantity as number, notes: (item.notes as string).trim() };
  });
  const highest = items.reduce((max, item) => Math.max(max, Number(item.id.slice(3))), 0);
  const nextId = typeof raw.nextId === "number" && Number.isSafeInteger(raw.nextId) && raw.nextId > highest ? raw.nextId : highest + 1;
  return {
    version: STATE_VERSION,
    labsEnabled: raw.labsEnabled !== false,
    modelOverride: readModel(raw.modelOverride),
    nextId,
    items,
    pendingImport: readPending(raw.pendingImport),
  };
}

/** Replace the whole list from Settings. Existing IDs keep identity; new rows get fresh IDs. */
export function applyEdits(state: LabState, drafts: unknown): LabState {
  if (!Array.isArray(drafts)) throw new Error("Expected a list of items.");
  if (drafts.length > LIMITS.items) throw new Error(`At most ${LIMITS.items} items are supported.`);
  const known = new Map(state.items.map(item => [item.id, item]));
  const seenIds = new Set<string>();
  const seenNames = new Map<string, number>();
  const problems: string[] = [];
  let nextId = state.nextId;
  const items: EquipmentItem[] = [];
  drafts.forEach((draft, index) => {
    const label = `Row ${index + 1}`;
    if (!isRecord(draft)) { problems.push(`${label}: malformed row.`); return; }
    const rowProblems = itemProblems(draft as ItemDraft, label);
    if (rowProblems.length) { problems.push(...rowProblems); return; }
    let id: string;
    if (draft.id === undefined || draft.id === null || draft.id === "") id = `eq-${nextId++}`;
    else if (typeof draft.id !== "string" || !known.has(draft.id)) { problems.push(`${label}: unknown item ID.`); return; }
    else if (seenIds.has(draft.id)) { problems.push(`${label}: duplicate item ID.`); return; }
    else id = draft.id;
    seenIds.add(id);
    const name = (draft.name as string).trim();
    const key = normalizeName(name);
    const earlier = seenNames.get(key);
    if (earlier !== undefined) { problems.push(`${label}: "${name}" duplicates row ${earlier}.`); return; }
    seenNames.set(key, index + 1);
    items.push({ id, name, quantity: draft.quantity as number, notes: (draft.notes as string).trim() });
  });
  if (problems.length) fail(problems);
  return { ...state, nextId, items };
}

/** Combine duplicate parsed rows and mark which existing item each would update. */
export function planImport(state: LabState, parsed: { name: string; quantity: number; notes: string }[]): ImportRow[] {
  const byName = new Map(state.items.map(item => [normalizeName(item.name), item.id]));
  const rows = new Map<string, ImportRow>();
  for (const entry of parsed) {
    const name = entry.name.trim();
    if (!name) continue;
    const key = normalizeName(name);
    const notes = entry.notes.trim();
    const existing = rows.get(key);
    if (existing) {
      existing.quantity = Math.min(LIMITS.quantity, existing.quantity + entry.quantity);
      if (notes && !existing.notes.includes(notes)) existing.notes = [existing.notes, notes].filter(Boolean).join("; ").slice(0, LIMITS.notes);
    } else {
      rows.set(key, { name, quantity: entry.quantity, notes: notes.slice(0, LIMITS.notes), match: byName.get(key) ?? null });
    }
  }
  return [...rows.values()].slice(0, LIMITS.items);
}

/** Merge accepted preview rows: same normalized name updates quantity (and notes when given); others are added. Never deletes. */
export function applyImport(state: LabState, accepted: unknown): LabState {
  if (!Array.isArray(accepted)) throw new Error("Expected a list of import rows.");
  const problems = accepted.flatMap((row, index) => isRecord(row) ? itemProblems(row as ImportRow, `Import row ${index + 1}`) : [`Import row ${index + 1}: malformed row.`]);
  if (problems.length) fail(problems);
  const rows = planImport(state, accepted as ImportRow[]);
  const items = state.items.map(item => ({ ...item }));
  const index = new Map(items.map(item => [item.id, item]));
  let nextId = state.nextId;
  for (const row of rows) {
    const target = row.match ? index.get(row.match) : undefined;
    if (target) {
      target.quantity = row.quantity;
      if (row.notes) target.notes = row.notes;
    } else {
      items.push({ id: `eq-${nextId++}`, name: row.name, quantity: row.quantity, notes: row.notes });
    }
  }
  if (items.length > LIMITS.items) throw new Error(`Merging would exceed ${LIMITS.items} items.`);
  return { ...state, nextId, items };
}

function describe(item: EquipmentItem): string {
  return `${item.id} ${item.name} ×${item.quantity}`;
}

/** Compact one-line-per-item summary for the system prompt, capped to keep turns cheap. */
export function formatSummary(items: readonly EquipmentItem[], limit: number = LIMITS.summaryChars): string {
  const available = items.filter(item => item.quantity > 0);
  const parts: string[] = [];
  let used = 0;
  for (const item of available) {
    const part = describe(item);
    if (used + part.length + 2 > limit) {
      parts.push(`… and ${available.length - parts.length} more (call lab_equipment_list for the full list)`);
      break;
    }
    parts.push(part);
    used += part.length + 2;
  }
  return parts.join("; ");
}

/** Full listing returned by the lab_equipment_list tool. */
export function formatListing(items: readonly EquipmentItem[]): string {
  const available = items.filter(item => item.quantity > 0);
  if (!available.length) return "The learner has not listed any available lab equipment.";
  return available.map(item => `- ${describe(item)}${item.notes ? ` — ${item.notes}` : ""}`).join("\n");
}

export type LabEquipmentUse = { itemId: string; quantity: number };

/** Check that a lab only uses listed equipment in available quantities. */
export function labEquipmentProblems(state: Pick<LabState, "labsEnabled" | "items">, equipment: readonly LabEquipmentUse[]): string[] {
  if (!state.labsEnabled) return ["Physical labs are turned off in the Lab equipment plugin settings. Do not pose labs."];
  const byId = new Map(state.items.map(item => [item.id, item]));
  const problems: string[] = [];
  const totals = new Map<string, number>();
  for (const use of equipment) totals.set(use.itemId, (totals.get(use.itemId) ?? 0) + use.quantity);
  for (const [itemId, quantity] of totals) {
    const item = byId.get(itemId);
    if (!item) problems.push(`${itemId} is not in the learner's equipment list. Call lab_equipment_list and use listed IDs only.`);
    else if (quantity > item.quantity) problems.push(`${itemId} (${item.name}): the lab needs ${quantity} but the learner has ${item.quantity}.`);
  }
  return problems;
}
