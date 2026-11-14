import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import type { PluginBackendContext, PluginTaskSnapshot } from "learnharness-plugin-api";
import {
  answerProblems, buildInstructions, IMPORT_WORKER_ID, importInstructions, importPrompt, importResultSchema,
  LIST_TOOL_NAME, problemDefinition, questionDefinition, validateImportResult, type LabAnswer, type LabPayload,
} from "./contract.ts";
import {
  applyEdits, applyImport, emptyState, formatListing, labEquipmentProblems, LIMITS, parseState, planImport,
  type LabState, type ModelChoice,
} from "./inventory.ts";

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

function record(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid operation input.");
  return input as Record<string, unknown>;
}

export function activate(ctx: PluginBackendContext): () => void {
  const file = path.join(ctx.dataDirectory, "inventory.json");
  let state: LabState;
  /** When saved data cannot be read, nothing is written and no instructions are contributed. */
  let loadError: string | null = null;
  try {
    state = parseState(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    state = emptyState();
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") loadError = `Could not read ${file}: ${(error as Error).message}`;
  }

  const cleanups: (() => void)[] = [];
  let disposed = false;
  const alive = () => { if (disposed || ctx.signal.aborted) throw new Error("Lab equipment plugin is not active."); };

  // ---- Instructions (re-registered whenever the inventory or toggle changes) ----
  let instructionHandles: (() => void)[] = [];
  let instructionKey = "";
  function refreshInstructions() {
    const usable = !loadError && state.labsEnabled && state.items.some(item => item.quantity > 0);
    const teacher = usable ? buildInstructions(state.items, "teacher") : "";
    const practice = usable ? buildInstructions(state.items, "practice") : "";
    const key = teacher + "\u0000" + practice;
    if (key === instructionKey) return;
    for (const unregister of instructionHandles) unregister();
    instructionHandles = [];
    instructionKey = key;
    if (!usable) return;
    instructionHandles.push(ctx.registerInstructions({ agents: ["teacher"], text: teacher }));
    instructionHandles.push(ctx.registerInstructions({ agents: ["practice"], text: practice }));
  }

  // ---- Persistence: one serialized writer, atomic replace ----
  let queue: Promise<unknown> = Promise.resolve();
  function change(mutate: (current: LabState) => LabState, topic = "state-changed"): Promise<LabState> {
    const run = queue.then(async () => {
      alive();
      if (loadError) throw new Error(`${loadError} Fix or move the file, then restart LearnHarness.`);
      const next = mutate(state);
      if (next === state) return state;
      await fs.promises.mkdir(ctx.dataDirectory, { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.promises.writeFile(temporary, JSON.stringify(next, null, 2) + "\n", "utf8");
        await fs.promises.rename(temporary, file);
      } catch (error) {
        await fs.promises.rm(temporary, { force: true });
        throw error;
      }
      state = next;
      if (!disposed) {
        refreshInstructions();
        ctx.events.emit(topic);
      }
      return state;
    });
    queue = run.catch(() => undefined);
    return run;
  }

  // ---- Tools, question and problem types ----
  cleanups.push(ctx.registerTools({
    agents: ["teacher", "practice"],
    create: () => (loadError || !state.labsEnabled) ? [] : [{
      name: LIST_TOOL_NAME,
      label: "Lab equipment",
      description: "List the physical lab equipment the learner owns, with eq-N IDs, quantities and notes/specs. Read-only; use before designing a hands-on lab.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async (_toolCallId: string, _input: unknown, signal?: AbortSignal) => {
        if (signal?.aborted || ctx.signal.aborted) throw new Error("Lab equipment tool cancelled.");
        const items = state.items.filter(item => item.quantity > 0);
        return {
          content: [{ type: "text" as const, text: state.labsEnabled ? formatListing(state.items) : "Physical labs are turned off by the learner." }],
          details: { count: items.length },
        };
      },
    }],
  }));

  // Types stay registered even when labs are off so pending/historical labs keep working.
  cleanups.push(ctx.registerQuestionType({
    ...questionDefinition,
    validateQuestion: context => {
      const problems = labEquipmentProblems(state, (context.input.payload as unknown as LabPayload).equipment);
      return problems.length ? problems : undefined;
    },
    validateAnswer: context => {
      const problems = answerProblems(context.input.payload as unknown as LabPayload, context.answer as unknown as LabAnswer);
      return problems.length ? problems : undefined;
    },
  }));
  cleanups.push(ctx.registerProblemType({
    ...problemDefinition,
    validateProblem: context => {
      const problems = labEquipmentProblems(state, (context.input.payload as unknown as LabPayload).equipment);
      return problems.length ? problems : undefined;
    },
    validateSubmission: context => {
      const problems = answerProblems(context.input.payload as unknown as LabPayload, context.submission as unknown as LabAnswer);
      return problems.length ? problems : undefined;
    },
  }));

  // ---- Import worker ----
  cleanups.push(ctx.workers.register({
    id: IMPORT_WORKER_ID,
    instructions: importInstructions,
    resultSchema: importResultSchema,
    validateResult: validateImportResult,
  }));

  const observers = new Map<string, () => void>();
  function settle(requestId: string, task: Pick<PluginTaskSnapshot, "status" | "result" | "error">) {
    return change(current => {
      const pending = current.pendingImport;
      if (!pending || pending.status !== "running" || pending.requestId !== requestId) return current;
      if (task.status === "succeeded") {
        const parsed = (task.result as { items: { name: string; quantity: number; notes: string }[] }).items;
        return { ...current, pendingImport: { status: "ready", requestId, rows: planImport(current, parsed) } };
      }
      const reason = task.error?.message ?? `Import ${task.status}.`;
      return { ...current, pendingImport: { status: "failed", requestId, error: reason } };
    });
  }
  function watch(requestId: string, taskId: string) {
    if (observers.has(taskId)) return;
    let last = "";
    const unsubscribe = ctx.workers.subscribe(taskId, task => {
      const current = `${task.status}:${task.turns}:${task.activity ?? ""}`;
      if (current !== last && !disposed) { last = current; ctx.events.emit("import-progress"); }
    });
    observers.set(taskId, unsubscribe);
    ctx.workers.wait(taskId, ctx.signal).then(() => settle(requestId, ctx.workers.get(taskId))).catch(() => {
      // Activation ending interrupts the task; activation reconciliation records the outcome.
    }).finally(() => { observers.get(taskId)?.(); observers.delete(taskId); });
  }
  function reconcile() {
    const pending = state.pendingImport;
    if (!pending || pending.status !== "running") return;
    const task = ctx.workers.list().find(candidate => candidate.requestId === pending.requestId);
    if (!task) {
      void change(current => current.pendingImport?.requestId === pending.requestId
        ? { ...current, pendingImport: { status: "failed", requestId: pending.requestId, error: "The import was interrupted before it finished. Parse again." } }
        : current).catch(() => undefined);
    } else if (TERMINAL.has(task.status)) void settle(pending.requestId, task).catch(() => undefined);
    else {
      if (!pending.taskId) void change(current => current.pendingImport?.requestId === pending.requestId
        ? { ...current, pendingImport: { ...pending, taskId: task.id } } : current).catch(() => undefined);
      watch(pending.requestId, task.id);
    }
  }
  if (!loadError) reconcile();

  async function resolveModel(override: ModelChoice | null) {
    const catalog = await ctx.inference.catalog();
    alive();
    const pin = override ? { model: override, thinkingLevel: undefined } : catalog.slots?.cheap;
    if (!pin?.model) throw new Error("Configure the cheap model slot (Settings → Agent → Models) or choose a model for importing.");
    const entry = catalog.models.find(model => model.provider === pin.model.provider && model.id === pin.model.id);
    if (!entry) throw new Error("The selected import model is unavailable. Choose a configured model.");
    const thinkingLevel = pin.thinkingLevel && entry.supportedLevels.includes(pin.thinkingLevel) ? pin.thinkingLevel : undefined;
    return { ...pin.model, ...(thinkingLevel ? { thinkingLevel } : {}) };
  }

  // ---- Frontend operations ----
  function view() {
    const pending = state.pendingImport;
    let progress: { status: string; turns: number; activity?: string } | undefined;
    if (pending?.status === "running" && pending.taskId) {
      try {
        const task = ctx.workers.get(pending.taskId);
        progress = { status: task.status, turns: task.turns, ...(task.activity ? { activity: task.activity } : {}) };
      } catch { /* Task record unavailable; reconciliation reports it. */ }
    }
    return {
      loadError,
      labsEnabled: state.labsEnabled,
      modelOverride: state.modelOverride,
      items: state.items,
      pendingImport: pending,
      progress,
      limits: LIMITS,
    };
  }
  function handle(name: string, handler: (input: Record<string, unknown>) => unknown) {
    cleanups.push(ctx.handle(name, input => { alive(); return handler(record(input ?? {})); }));
  }
  handle("get-state", () => view());
  handle("save-inventory", async input => { await change(current => applyEdits(current, input.items)); return view(); });
  handle("set-labs-enabled", async input => {
    if (typeof input.enabled !== "boolean") throw new Error("enabled must be true or false.");
    await change(current => ({ ...current, labsEnabled: input.enabled as boolean }));
    return view();
  });
  handle("set-model-override", async input => {
    const model = input.model;
    let next: ModelChoice | null = null;
    if (model !== null && model !== undefined) {
      const value = record(model);
      if (typeof value.provider !== "string" || typeof value.id !== "string" || !value.provider || !value.id) throw new Error("Invalid model.");
      next = { provider: value.provider, id: value.id };
    }
    await change(current => ({ ...current, modelOverride: next }));
    return view();
  });
  handle("import-start", async input => {
    if (typeof input.text !== "string" || !/\S/.test(input.text)) throw new Error("Paste a description of your equipment first.");
    if (input.text.length > LIMITS.importText) throw new Error(`The text is longer than ${LIMITS.importText} characters. Import it in parts.`);
    if (state.pendingImport?.status === "running") throw new Error("An import is already running.");
    const model = await resolveModel(state.modelOverride);
    const requestId = randomUUID();
    await change(current => ({ ...current, pendingImport: { status: "running", requestId, taskId: null, startedAt: new Date().toISOString() } }));
    let task: PluginTaskSnapshot;
    try {
      task = ctx.workers.start(IMPORT_WORKER_ID, {
        requestId,
        input: { characters: input.text.length },
        prompt: importPrompt(input.text),
        model,
        purpose: "user",
        maxTurns: 3,
        options: { maxTokens: 8_192 },
        timeoutMs: 180_000,
      });
    } catch (error) {
      await change(current => ({ ...current, pendingImport: { status: "failed", requestId, error: (error as Error).message } }));
      throw error;
    }
    await change(current => current.pendingImport?.requestId === requestId && current.pendingImport.status === "running"
      ? { ...current, pendingImport: { ...current.pendingImport, taskId: task.id } } : current);
    if (TERMINAL.has(task.status)) await settle(requestId, task);
    else watch(requestId, task.id);
    return view();
  });
  handle("import-accept", async input => {
    if (state.pendingImport?.status !== "ready") throw new Error("There is no import preview to accept.");
    const requestId = state.pendingImport.requestId;
    await change(current => {
      if (current.pendingImport?.requestId !== requestId) throw new Error("The import preview changed. Review it again.");
      return { ...applyImport(current, input.rows), pendingImport: null };
    });
    return view();
  });
  handle("import-discard", async () => {
    const pending = state.pendingImport;
    if (pending?.status === "running" && pending.taskId) {
      try { ctx.workers.cancel(pending.taskId); } catch { /* Already finished. */ }
    }
    await change(current => ({ ...current, pendingImport: null }));
    return view();
  });

  refreshInstructions();

  return () => {
    disposed = true;
    for (const unsubscribe of observers.values()) unsubscribe();
    observers.clear();
    for (const unregister of instructionHandles) unregister();
    instructionHandles = [];
    for (const cleanup of cleanups.reverse()) {
      try { cleanup(); } catch { /* Continue releasing other registrations. */ }
    }
  };
}
