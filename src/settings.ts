import type { PluginButtonProps, PluginFrontendContext, PluginWidgetHandle } from "learnharness-plugin-api";
import type { EquipmentItem, ImportRow, ModelChoice, PendingImport } from "./inventory.ts";

export type StateView = {
  loadError: string | null;
  labsEnabled: boolean;
  modelOverride: ModelChoice | null;
  items: EquipmentItem[];
  pendingImport: PendingImport | null;
  progress?: { status: string; turns: number; activity?: string };
  limits: { items: number; name: number; notes: number; quantity: number; importText: number };
};

type Draft = { id?: string; name: string; quantity: number; notes: string };
type PreviewRow = ImportRow & { include: boolean };

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function mountSettings(ctx: PluginFrontendContext, container: HTMLElement, signal: AbortSignal): () => void {
  const doc = container.ownerDocument;
  const root = el(doc, "div", "lh-lab-settings");
  container.append(root);
  const widgets: PluginWidgetHandle<unknown>[] = [];
  const button = (parent: HTMLElement, props: PluginButtonProps) => {
    const handle = ctx.ui.mountButton(parent, props, { signal });
    widgets.push(handle as PluginWidgetHandle<unknown>);
    return handle;
  };

  let view: StateView | null = null;
  let drafts: Draft[] = [];
  let dirty = false;
  let preview: { requestId: string; rows: PreviewRow[] } | null = null;
  let importText = "";

  // ---- Load error banner ----
  const banner = el(doc, "p", "lh-lab-settings__error");
  banner.setAttribute("role", "alert");
  banner.hidden = true;
  root.append(banner);

  // ---- Toggle ----
  const toggleSlot = el(doc, "div");
  root.append(toggleSlot);
  const toggleRow = (value: boolean) => ({
    key: "labs-enabled",
    type: "toggle" as const,
    label: "Enable physical labs",
    description: "Let the teacher and practice agents propose hands-on labs that use the equipment below.",
    value,
    onChange: async (next: boolean) => { apply(await ctx.call<StateView>("set-labs-enabled", { enabled: next })); },
  });
  const toggle = ctx.ui.mountSettingsRows(toggleSlot, { rows: [toggleRow(true)] }, { signal });
  widgets.push(toggle as PluginWidgetHandle<unknown>);

  // ---- Equipment table ----
  const equipment = el(doc, "section", "lh-lab-settings__section");
  equipment.append(el(doc, "h3", undefined, "Your equipment"));
  equipment.append(el(doc, "p", "lh-lab-settings__hint", "Items with quantity 0 are kept but not offered to the teacher. IDs like eq-3 are how labs refer to items."));
  const table = el(doc, "table", "lh-lab-settings__table");
  const head = el(doc, "thead");
  const headRow = el(doc, "tr");
  for (const title of ["ID", "Name", "Qty", "Notes", ""]) headRow.append(el(doc, "th", undefined, title));
  head.append(headRow);
  const body = el(doc, "tbody");
  table.append(head, body);
  const empty = el(doc, "p", "lh-lab-settings__hint", "No equipment yet. Add items or import them from text below.");
  const equipmentActions = el(doc, "div", "lh-lab-settings__actions");
  const equipmentStatus = el(doc, "span", "lh-lab-settings__status");
  equipmentStatus.setAttribute("role", "status");
  equipment.append(table, empty, equipmentActions);
  root.append(equipment);
  button(equipmentActions, { label: "Add item", variant: "outline", size: "sm", onClick: () => { drafts.push({ name: "", quantity: 1, notes: "" }); markDirty(); renderTable(true); } });
  const saveButton = button(equipmentActions, {
    label: "Save changes", size: "sm", disabled: true,
    onClick: async () => {
      equipmentStatus.textContent = "";
      try {
        const next = await ctx.call<StateView>("save-inventory", { items: drafts.map(({ id, name, quantity, notes }) => ({ ...(id ? { id } : {}), name, quantity, notes })) });
        dirty = false;
        apply(next);
        equipmentStatus.textContent = "Saved.";
      } catch (error) { equipmentStatus.textContent = message(error); }
    },
  });
  const revertButton = button(equipmentActions, { label: "Revert", variant: "ghost", size: "sm", disabled: true, onClick: () => { dirty = false; equipmentStatus.textContent = ""; if (view) apply(view); } });
  equipmentActions.append(equipmentStatus);

  function markDirty() {
    if (!dirty) { dirty = true; saveButton.update({ disabled: false }); revertButton.update({ disabled: false }); }
    equipmentStatus.textContent = "Unsaved changes.";
  }

  function textInput(value: string, max: number, label: string, onInput: (value: string) => void) {
    const input = el(doc, "input", "lh-lab-settings__input");
    input.type = "text";
    input.value = value;
    input.maxLength = max;
    input.setAttribute("aria-label", label);
    input.addEventListener("input", () => onInput(input.value));
    return input;
  }
  function numberInput(value: number, max: number, label: string, onInput: (value: number) => void) {
    const input = el(doc, "input", "lh-lab-settings__input lh-lab-settings__input--qty");
    input.type = "number";
    input.min = "0";
    input.max = String(max);
    input.step = "1";
    input.value = String(value);
    input.setAttribute("aria-label", label);
    input.addEventListener("input", () => onInput(input.value === "" ? Number.NaN : Number(input.value)));
    return input;
  }

  let rowWidgets: PluginWidgetHandle<unknown>[] = [];
  function renderTable(focusLast = false) {
    for (const widget of rowWidgets) widget.dispose();
    rowWidgets = [];
    body.replaceChildren();
    const limits = view?.limits ?? { name: 120, notes: 500, quantity: 100000 };
    drafts.forEach((draft, index) => {
      const row = el(doc, "tr");
      const label = draft.name || `row ${index + 1}`;
      const name = textInput(draft.name, limits.name, `Name of ${label}`, value => { draft.name = value; markDirty(); });
      const quantity = numberInput(draft.quantity, limits.quantity, `Quantity of ${label}`, value => { draft.quantity = value; markDirty(); });
      const notes = textInput(draft.notes, limits.notes, `Notes for ${label}`, value => { draft.notes = value; markDirty(); });
      const remove = el(doc, "td");
      rowWidgets.push(ctx.ui.mountButton(remove, { label: `Remove ${label}`, iconOnly: true, icon: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4l8 8M12 4l-8 8"/></svg>', variant: "ghost", size: "icon-sm", onClick: () => { drafts.splice(index, 1); markDirty(); renderTable(); } }, { signal }) as PluginWidgetHandle<unknown>);
      const cells = [el(doc, "td", "lh-lab-settings__id", draft.id ?? "new"), el(doc, "td"), el(doc, "td"), el(doc, "td")];
      cells[1]!.append(name);
      cells[2]!.append(quantity);
      cells[3]!.append(notes);
      row.append(...cells, remove);
      body.append(row);
      if (focusLast && index === drafts.length - 1) name.focus();
    });
    table.hidden = drafts.length === 0;
    empty.hidden = drafts.length > 0;
  }

  // ---- Import ----
  const importer = el(doc, "section", "lh-lab-settings__section");
  importer.append(el(doc, "h3", undefined, "Import from text"));
  importer.append(el(doc, "p", "lh-lab-settings__hint", "Paste a description of your kit in any format. A model turns it into items you can review before anything is saved. Each parse makes one model request, which may cost money."));
  const modelRow = el(doc, "div", "lh-lab-settings__model");
  const modelLabel = el(doc, "span", "lh-lab-settings__hint");
  const pickerSlot = el(doc, "span");
  modelRow.append(el(doc, "span", undefined, "Model:"), pickerSlot, modelLabel);
  const picker = ctx.ui.mountModelPicker(pickerSlot, {
    value: undefined,
    onChange: async value => { apply(await ctx.call<StateView>("set-model-override", { model: value })); },
  }, { signal });
  widgets.push(picker as PluginWidgetHandle<unknown>);
  const resetModel = button(modelRow, { label: "Use cheap slot", variant: "ghost", size: "xs", onClick: async () => { apply(await ctx.call<StateView>("set-model-override", { model: null })); } });
  const area = el(doc, "textarea", "lh-lab-settings__textarea");
  area.rows = 6;
  area.placeholder = "e.g. 5 half-size breadboards, a bag of LEDs (about 4 red, 2 green), soldering iron (60 W, adjustable), multimeter, 9 V battery + clip, assorted resistors 220 Ω–10 kΩ";
  area.setAttribute("aria-label", "Equipment description to import");
  area.addEventListener("input", () => { importText = area.value; parseButton.update({ disabled: !canParse() }); });
  const importActions = el(doc, "div", "lh-lab-settings__actions");
  const importStatus = el(doc, "span", "lh-lab-settings__status");
  importStatus.setAttribute("role", "status");
  const previewBox = el(doc, "div", "lh-lab-settings__preview");
  importer.append(modelRow, area, importActions, previewBox);
  root.append(importer);
  const canParse = () => /\S/.test(importText) && view?.pendingImport?.status !== "running" && !view?.loadError;
  const parseButton = button(importActions, {
    label: "Parse", size: "sm", disabled: true,
    onClick: async () => {
      importStatus.textContent = "";
      try { apply(await ctx.call<StateView>("import-start", { text: importText })); }
      catch (error) { importStatus.textContent = message(error); }
    },
  });
  const cancelButton = button(importActions, {
    label: "Cancel", variant: "ghost", size: "sm",
    onClick: async () => { apply(await ctx.call<StateView>("import-discard")); },
  });
  importActions.append(importStatus);

  function renderPreview() {
    previewBox.replaceChildren();
    if (!preview || !view) return;
    const limits = view.limits;
    previewBox.append(el(doc, "h4", undefined, `Review ${preview.rows.length} parsed item${preview.rows.length === 1 ? "" : "s"}`));
    previewBox.append(el(doc, "p", "lh-lab-settings__hint", "Matching names update the existing item's quantity (and notes, when given). Nothing is deleted."));
    const previewTable = el(doc, "table", "lh-lab-settings__table");
    const header = el(doc, "tr");
    for (const title of ["Add", "Name", "Qty", "Notes", "Effect"]) header.append(el(doc, "th", undefined, title));
    previewTable.append(el(doc, "thead"), el(doc, "tbody"));
    previewTable.tHead!.append(header);
    const names = new Map(view.items.map(item => [item.id, item]));
    preview.rows.forEach(row => {
      const tr = el(doc, "tr");
      const include = el(doc, "input");
      include.type = "checkbox";
      include.checked = row.include;
      include.setAttribute("aria-label", `Include ${row.name}`);
      include.addEventListener("change", () => { row.include = include.checked; });
      const existing = row.match ? names.get(row.match) : undefined;
      const effect = existing ? `updates ${existing.id} (${existing.quantity} → ${row.quantity})` : "new";
      const cells = [el(doc, "td"), el(doc, "td"), el(doc, "td"), el(doc, "td"), el(doc, "td", "lh-lab-settings__effect", effect)];
      cells[0]!.append(include);
      cells[1]!.append(textInput(row.name, limits.name, `Parsed name ${row.name}`, value => { row.name = value; }));
      cells[2]!.append(numberInput(row.quantity, limits.quantity, `Parsed quantity of ${row.name}`, value => { row.quantity = value; }));
      cells[3]!.append(textInput(row.notes, limits.notes, `Parsed notes for ${row.name}`, value => { row.notes = value; }));
      tr.append(...cells);
      previewTable.tBodies[0]!.append(tr);
    });
    const actions = el(doc, "div", "lh-lab-settings__actions");
    const status = el(doc, "span", "lh-lab-settings__status");
    status.setAttribute("role", "status");
    previewBox.append(previewTable, actions);
    const accept = ctx.ui.mountButton(actions, {
      label: "Accept and merge", size: "sm",
      onClick: async () => {
        if (!preview) return;
        status.textContent = "";
        try {
          const rows = preview.rows.filter(row => row.include).map(({ name, quantity, notes }) => ({ name, quantity, notes }));
          const next = await ctx.call<StateView>("import-accept", { rows });
          area.value = importText = "";
          apply(next);
          importStatus.textContent = `Merged ${rows.length} item${rows.length === 1 ? "" : "s"}.`;
        } catch (error) { status.textContent = message(error); }
      },
    }, { signal });
    const discard = ctx.ui.mountButton(actions, {
      label: "Discard", variant: "ghost", size: "sm",
      onClick: async () => { apply(await ctx.call<StateView>("import-discard")); },
    }, { signal });
    previewWidgets.forEach(widget => widget.dispose());
    previewWidgets = [accept as PluginWidgetHandle<unknown>, discard as PluginWidgetHandle<unknown>];
    actions.append(status);
  }
  let previewWidgets: PluginWidgetHandle<unknown>[] = [];

  // ---- State application ----
  function apply(next: StateView) {
    if (signal.aborted) return;
    view = next;
    banner.hidden = !next.loadError;
    banner.textContent = next.loadError ?? "";
    toggle.update({ rows: [{ ...toggleRow(next.labsEnabled), disabled: Boolean(next.loadError) }] });
    if (!dirty) {
      drafts = next.items.map(item => ({ ...item }));
      saveButton.update({ disabled: true });
      revertButton.update({ disabled: true });
      renderTable();
    }
    picker.update({ value: next.modelOverride ?? undefined });
    modelLabel.textContent = next.modelOverride ? "" : "Using the cheap model slot.";
    resetModel.update({ disabled: !next.modelOverride });
    const pending = next.pendingImport;
    parseButton.update({ disabled: !canParse() });
    cancelButton.update({ disabled: pending?.status !== "running" });
    if (pending?.status === "running") {
      const p = next.progress;
      importStatus.textContent = `Parsing… ${p ? `(${p.status}${p.activity ? `: ${p.activity}` : ""})` : ""}`;
    } else if (pending?.status === "failed") {
      importStatus.textContent = `Import failed: ${pending.error}`;
    } else if (importStatus.textContent?.startsWith("Parsing")) importStatus.textContent = "";
    if (pending?.status === "ready") {
      if (preview?.requestId !== pending.requestId) {
        preview = { requestId: pending.requestId, rows: pending.rows.map(row => ({ ...row, include: true })) };
        importStatus.textContent = "";
        renderPreview();
      }
    } else if (preview) {
      preview = null;
      previewWidgets.forEach(widget => widget.dispose());
      previewWidgets = [];
      renderPreview();
    }
  }

  let generation = 0;
  async function refresh() {
    const mine = ++generation;
    try {
      const next = await ctx.call<StateView>("get-state");
      if (mine === generation) apply(next);
    } catch (error) {
      if (!signal.aborted) { banner.hidden = false; banner.textContent = message(error); }
    }
  }
  const offNotification = ctx.onNotification(event => {
    if (event.topic === "state-changed" || event.topic === "import-progress") void refresh();
  });
  const offResync = ctx.onResync(() => { void refresh(); });
  void refresh();

  return () => {
    generation++;
    offNotification();
    offResync();
    for (const widget of [...widgets, ...rowWidgets, ...previewWidgets]) widget.dispose();
    root.remove();
  };
}
