import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { PluginBackendContext, PluginInstructions, PluginQuestionTypeDefinition, PluginTools } from "learnharness-plugin-api";
import { activate } from "../src/backend.ts";

type Outcome = { status: "succeeded"; result: unknown } | { status: "failed"; error: { code: string; message: string } };

/** Minimal fake of the public backend context; enough to drive the plugin's own logic. */
function fakeHost(dataDirectory: string) {
  const instructions = new Map<number, PluginInstructions>();
  const handlers = new Map<string, (input: unknown) => unknown>();
  const emitted: string[] = [];
  let tools: PluginTools | undefined;
  let question: PluginQuestionTypeDefinition | undefined;
  let nextInstruction = 0;
  const tasks = new Map<string, { id: string; requestId: string; status: string; turns: number; result?: unknown; error?: unknown; settle: () => void; done: Promise<void> }>();
  const controller = new AbortController();
  let pendingOutcome: Outcome = { status: "succeeded", result: { items: [] } };
  const ctx = {
    dataDirectory,
    signal: controller.signal,
    cleanup() {},
    events: { emit(topic: string) { emitted.push(topic); }, on() { return () => {}; } },
    registerInstructions(value: PluginInstructions) { const id = nextInstruction++; instructions.set(id, value); return () => { instructions.delete(id); }; },
    registerTools(value: PluginTools) { tools = value; return () => { tools = undefined; }; },
    registerQuestionType(value: PluginQuestionTypeDefinition) { question = value; return () => {}; },
    registerProblemType() { return () => {}; },
    handle(name: string, handler: (input: unknown) => unknown) { handlers.set(name, handler); return () => { handlers.delete(name); }; },
    inference: { async catalog() { return { slots: { cheap: { model: { provider: "test", id: "cheap" } } }, models: [{ provider: "test", id: "cheap", supportedLevels: [] }] }; } },
    workers: {
      register() { return () => {}; },
      start(_id: string, options: { requestId: string }) {
        let settle!: () => void;
        const done = new Promise<void>(resolve => { settle = resolve; });
        const task = { id: `task-${tasks.size + 1}`, requestId: options.requestId, status: "running", turns: 0, settle, done };
        tasks.set(task.id, task);
        return { ...task };
      },
      list() { return [...tasks.values()]; },
      get(id: string) { return tasks.get(id)!; },
      subscribe() { return () => {}; },
      async wait(id: string) { await tasks.get(id)!.done; return { id, ...pendingOutcome }; },
      cancel(id: string) { const task = tasks.get(id)!; task.status = "cancelled"; task.error = { code: "cancelled", message: "Cancelled." }; task.settle(); },
    },
  };
  return {
    ctx: ctx as unknown as PluginBackendContext,
    call: (name: string, input: unknown = {}) => Promise.resolve(handlers.get(name)!(input)) as Promise<any>,
    instructions: () => [...instructions.values()],
    tools: () => tools?.create({ chatId: "c", agent: "teacher" }) ?? [],
    question: () => question!,
    finishTask(outcome: Outcome) {
      pendingOutcome = outcome;
      for (const task of tasks.values()) if (task.status === "running") { Object.assign(task, outcome); task.settle(); }
    },
    emitted,
  };
}

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lab-equipment-"));
const flush = () => new Promise(resolve => setTimeout(resolve, 20));

test("saving equipment persists atomically and contributes instructions and the list tool", async () => {
  const dir = temp();
  const host = fakeHost(dir);
  const dispose = activate(host.ctx);
  assert.equal(host.instructions().length, 0, "no instructions with an empty inventory");
  const view = await host.call("save-inventory", { items: [{ name: "Breadboard", quantity: 5, notes: "" }, { name: "LED", quantity: 4, notes: "red" }] });
  assert.deepEqual(view.items.map((item: { id: string }) => item.id), ["eq-1", "eq-2"]);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "inventory.json"), "utf8"));
  assert.equal(saved.items.length, 2);
  assert.deepEqual(fs.readdirSync(dir), ["inventory.json"], "no temporary files left behind");
  const contributed = host.instructions();
  assert.deepEqual(contributed.map(item => item.agents), [["teacher"], ["practice"]]);
  assert.match(contributed[0]!.text, /eq-1 Breadboard ×5; eq-2 LED ×4/);
  const [tool] = host.tools();
  const result = await tool!.execute("call", {}, undefined as never);
  assert.match((result.content[0] as { text: string }).text, /eq-2 LED ×4 — red/);
  assert.ok(host.emitted.includes("state-changed"));

  await host.call("set-labs-enabled", { enabled: false });
  assert.equal(host.instructions().length, 0);
  assert.equal(host.tools().length, 0);
  const validation = host.question().validateQuestion!({ chatId: "c", variant: "teach", contractVersion: 1, input: { question: "q", type: "check", nodeId: "n", payload: { title: "t", equipment: [{ itemId: "eq-1", quantity: 1 }], safety: [], steps: ["a"] } } } as never);
  assert.match(validation![0]!, /turned off/);
  dispose();

  // Restart: data is reloaded, toggle preserved.
  const again = fakeHost(dir);
  activate(again.ctx);
  const reloaded = await again.call("get-state");
  assert.equal(reloaded.labsEnabled, false);
  assert.equal(reloaded.items.length, 2);
});

test("question validation rejects labs that need more than the learner has", async () => {
  const host = fakeHost(temp());
  activate(host.ctx);
  await host.call("save-inventory", { items: [{ name: "LED", quantity: 4, notes: "" }] });
  const input = (quantity: number) => ({ chatId: "c", variant: "teach", contractVersion: 1, input: { question: "q", type: "check", nodeId: "n", payload: { title: "t", equipment: [{ itemId: "eq-1", quantity }], safety: [], steps: ["a"] } } });
  assert.equal(host.question().validateQuestion!(input(4) as never), undefined);
  assert.match(host.question().validateQuestion!(input(6) as never)![0]!, /needs 6 but the learner has 4/);
});

test("import parses through a worker into a preview, then merges on accept", async () => {
  const host = fakeHost(temp());
  activate(host.ctx);
  await host.call("save-inventory", { items: [{ name: "LED", quantity: 1, notes: "" }] });
  const started = await host.call("import-start", { text: "4 LEDs and 5 breadboards" });
  assert.equal(started.pendingImport.status, "running");
  await assert.rejects(host.call("import-start", { text: "again" }), /already running/);
  host.finishTask({ status: "succeeded", result: { items: [{ name: "led", quantity: 4, notes: "red" }, { name: "Breadboard", quantity: 5, notes: "" }] } });
  await flush();
  const ready = await host.call("get-state");
  assert.equal(ready.pendingImport.status, "ready");
  assert.deepEqual(ready.pendingImport.rows.map((row: { match: string | null }) => row.match), ["eq-1", null]);
  const merged = await host.call("import-accept", { rows: ready.pendingImport.rows.map(({ name, quantity, notes }: { name: string; quantity: number; notes: string }) => ({ name, quantity, notes })) });
  assert.equal(merged.pendingImport, null);
  assert.deepEqual(merged.items, [
    { id: "eq-1", name: "LED", quantity: 4, notes: "red" },
    { id: "eq-2", name: "Breadboard", quantity: 5, notes: "" },
  ]);
});

test("failed imports are reported and can be discarded", async () => {
  const host = fakeHost(temp());
  activate(host.ctx);
  await host.call("import-start", { text: "stuff" });
  host.finishTask({ status: "failed", error: { code: "no_result", message: "No result." } });
  await flush();
  const failed = await host.call("get-state");
  assert.deepEqual(failed.pendingImport, { status: "failed", requestId: failed.pendingImport.requestId, error: "No result." });
  assert.equal((await host.call("import-discard")).pendingImport, null);
});

test("unreadable or newer data is never overwritten", async () => {
  const dir = temp();
  const file = path.join(dir, "inventory.json");
  fs.writeFileSync(file, JSON.stringify({ version: 9, items: [] }));
  const host = fakeHost(dir);
  activate(host.ctx);
  const view = await host.call("get-state");
  assert.match(view.loadError, /newer than this plugin understands/);
  await assert.rejects(host.call("save-inventory", { items: [] }), /Fix or move the file/);
  assert.equal(fs.readFileSync(file, "utf8"), JSON.stringify({ version: 9, items: [] }));
  assert.equal(host.instructions().length, 0);
});
