import type {
  PluginFrontendContext, PluginProblemEditorHandle, PluginProblemSubmissionState,
  PluginQuestionAnswerState, PluginQuestionEditorHandle, PluginQuestionEditorKey,
} from "learnharness-plugin-api";
import { isAnswerReady, type LabAnswer, type LabPayload } from "./contract.ts";

export type NameLookup = () => Promise<ReadonlyMap<string, string>>;
type Ui = Pick<PluginFrontendContext["ui"], "mountMarkdown">;

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Run a mount body, removing its root on abort or explicit cleanup exactly once. */
function scoped(container: HTMLElement, className: string, signal: AbortSignal, build: (root: HTMLElement) => (() => void) | void): () => void {
  const root = el(container.ownerDocument, "div", className);
  container.append(root);
  let inner: (() => void) | void;
  let done = false;
  const dispose = () => {
    if (done) return;
    done = true;
    signal.removeEventListener("abort", dispose);
    try { inner?.(); } finally { root.remove(); }
  };
  if (signal.aborted) { dispose(); return dispose; }
  signal.addEventListener("abort", dispose, { once: true });
  try { inner = build(root); } catch (error) { dispose(); throw error; }
  return dispose;
}

/** Title, equipment (names resolved asynchronously; IDs shown until then or if deleted) and safety notes. */
export function renderKit(root: HTMLElement, payload: LabPayload, names: NameLookup, signal: AbortSignal): void {
  const doc = root.ownerDocument;
  const kit = el(doc, "div", "lh-lab__kit");
  kit.append(el(doc, "div", "lh-lab__title", payload.title));
  kit.append(el(doc, "div", "lh-lab__label", "You will need"));
  const list = el(doc, "ul", "lh-lab__equipment");
  const labels = payload.equipment.map(use => {
    const item = el(doc, "li");
    const label = el(doc, "span", undefined, use.itemId);
    item.append(el(doc, "span", "lh-lab__qty", `${use.quantity} ×`), label);
    list.append(item);
    return { use, label };
  });
  kit.append(list);
  if (payload.safety.length) {
    const safety = el(doc, "div", "lh-lab__safety");
    safety.setAttribute("role", "note");
    safety.append(el(doc, "div", "lh-lab__label", "Safety"));
    const notes = el(doc, "ul");
    for (const note of payload.safety) notes.append(el(doc, "li", undefined, note));
    safety.append(notes);
    kit.append(safety);
  }
  root.append(kit);
  void names().then(map => {
    if (signal.aborted) return;
    for (const { use, label } of labels) {
      const name = map.get(use.itemId);
      label.textContent = name ?? `${use.itemId} (no longer in your list)`;
    }
  }).catch(() => { /* Keep IDs visible. */ });
}

export function mountQuestionBody(container: HTMLElement, ui: Ui, question: string, payload: LabPayload, names: NameLookup, signal: AbortSignal): () => void {
  return scoped(container, "lh-lab", signal, root => {
    const prompt = el(root.ownerDocument, "div", "lh-lab__prompt");
    root.append(prompt);
    const markdown = ui.mountMarkdown(prompt, { text: question }, { signal });
    renderKit(root, payload, names, signal);
    return () => markdown.dispose();
  });
}

/** Read-only record of a completed lab. */
export function mountAnsweredBody(container: HTMLElement, payload: LabPayload, answer: LabAnswer, signal: AbortSignal): () => void {
  return scoped(container, "lh-lab lh-lab--answered", signal, root => {
    const doc = root.ownerDocument;
    const done = answer.completed.filter(Boolean).length;
    root.append(el(doc, "div", "lh-lab__label", `Steps completed: ${done} of ${payload.steps.length}`));
    const steps = el(doc, "ol", "lh-lab__steps");
    payload.steps.forEach((step, index) => {
      const item = el(doc, "li", answer.completed[index] ? "is-done" : "is-skipped");
      item.append(el(doc, "span", "lh-lab__mark", answer.completed[index] ? "✓" : "–"), el(doc, "span", undefined, step));
      item.setAttribute("aria-label", `${answer.completed[index] ? "Completed" : "Not completed"}: ${step}`);
      steps.append(item);
    });
    root.append(steps, el(doc, "div", "lh-lab__label", "Observations"), el(doc, "p", "lh-lab__observations", answer.observations));
  });
}

type EditorState = PluginQuestionAnswerState | PluginProblemSubmissionState;

function readAnswer(state: EditorState, steps: number): LabAnswer {
  if (state.status === "empty") return { completed: Array(steps).fill(false), observations: "" };
  const value = state.value as Partial<LabAnswer> | null;
  const completed = Array.isArray(value?.completed) ? value.completed : [];
  return {
    completed: Array.from({ length: steps }, (_, index) => completed[index] === true),
    observations: typeof value?.observations === "string" ? value.observations : "",
  };
}

type EditorOptions = {
  payload: LabPayload;
  initial: EditorState;
  active: boolean;
  signal: AbortSignal;
  onChange(state: EditorState): void;
  /** Practice cards show only the host statement, so the editor shows the kit itself. */
  kit?: { names: NameLookup };
};

/** Checklist + observations editor shared by teaching questions and practice problems. */
export function mountLabEditor(container: HTMLElement, options: EditorOptions): PluginQuestionEditorHandle {
  const { payload, signal } = options;
  const doc = container.ownerDocument;
  let disposed = false;
  let active = options.active;
  let current = readAnswer(options.initial, payload.steps.length);

  const root = el(doc, "div", "lh-lab lh-lab--editor");
  if (options.kit) renderKit(root, payload, options.kit.names, signal);
  root.append(el(doc, "div", "lh-lab__label", "Steps — tick what you completed"));
  const list = el(doc, "ol", "lh-lab__steps");
  const boxes = payload.steps.map((step, index) => {
    const item = el(doc, "li");
    const label = el(doc, "label", "lh-lab__check");
    const box = el(doc, "input");
    box.type = "checkbox";
    box.checked = current.completed[index] ?? false;
    box.addEventListener("change", () => {
      if (!active || disposed) return;
      current = { ...current, completed: current.completed.map((value, at) => at === index ? box.checked : value) };
      publish();
    });
    label.append(box, el(doc, "span", undefined, step));
    item.append(label);
    list.append(item);
    return box;
  });
  const observationsLabel = el(doc, "label", "lh-lab__label", "What did you observe or measure?");
  const area = el(doc, "textarea", "lh-lab__textarea");
  area.rows = 4;
  area.value = current.observations;
  area.placeholder = "e.g. The LED lit up only when the long leg faced +5 V; it was dimmer with the 1 kΩ resistor.";
  area.id = `lh-lab-observations-${Math.random().toString(36).slice(2)}`;
  observationsLabel.htmlFor = area.id;
  area.addEventListener("input", () => {
    if (!active || disposed) return;
    current = { ...current, observations: area.value };
    publish();
  });
  root.append(list, observationsLabel, area);
  container.append(root);

  function setActive(next: boolean) {
    active = next;
    for (const box of boxes) box.disabled = !next;
    area.readOnly = !next;
  }
  function publish() {
    if (disposed || signal.aborted) return;
    if (!current.observations && !current.completed.some(Boolean)) options.onChange({ status: "empty" });
    else options.onChange({ status: isAnswerReady(current.observations) ? "ready" : "unready", value: { completed: [...current.completed], observations: current.observations } });
  }
  function apply(next: LabAnswer) {
    current = next;
    next.completed.forEach((value, index) => { const box = boxes[index]; if (box && box.checked !== value) box.checked = value; });
    if (area.value !== next.observations) area.value = next.observations;
  }
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener("abort", dispose);
    root.remove();
  };
  setActive(active);
  if (signal.aborted) dispose();
  else {
    signal.addEventListener("abort", dispose, { once: true });
    publish();
  }

  return {
    update(next) {
      if (disposed) return;
      setActive(next.active);
      const incoming = readAnswer(next.answer, payload.steps.length);
      if (incoming.observations !== current.observations || incoming.completed.some((value, index) => value !== current.completed[index])) apply(incoming);
    },
    focus() { if (!disposed && active) area.focus(); },
    handleKeyDown(key: PluginQuestionEditorKey) {
      if (disposed || !active || signal.aborted) return "pass";
      if (key === "Shift+Enter" && doc.activeElement === area) {
        area.setRangeText("\n", area.selectionStart, area.selectionEnd, "end");
        current = { ...current, observations: area.value };
        publish();
        return "handled";
      }
      return "pass";
    },
    appendTranscript(text: string) {
      if (disposed || !active || !text) return;
      const separator = area.value && !/\s$/.test(area.value) ? " " : "";
      area.value += separator + text;
      current = { ...current, observations: area.value };
      publish();
    },
    dispose,
  };
}

/** Adapt the shared editor to the practice-problem handle vocabulary. */
export function asProblemHandle(handle: PluginQuestionEditorHandle): PluginProblemEditorHandle {
  return {
    ...handle,
    update(next) { handle.update({ answer: next.submission, active: next.active }); },
  };
}
