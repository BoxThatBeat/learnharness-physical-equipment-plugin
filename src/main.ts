import type { PluginFrontendContext, PluginProblemRenderer, PluginQuestionRenderer } from "learnharness-plugin-api";
import { PROBLEM_TYPE_ID, QUESTION_TYPE_ID, type LabAnswer, type LabPayload } from "./contract.ts";
import { asProblemHandle, mountAnsweredBody, mountLabEditor, mountQuestionBody, type NameLookup } from "./lab-view.ts";
import { mountSettings, type StateView } from "./settings.ts";

export function activate(ctx: PluginFrontendContext): () => void {
  // Equipment names for rendering eq-N IDs; refreshed when the inventory changes.
  let names: Promise<ReadonlyMap<string, string>> | null = null;
  const lookup: NameLookup = () => {
    names ??= ctx.call<StateView>("get-state").then(view => new Map(view.items.map(item => [item.id, item.name])));
    names.catch(() => { names = null; });
    return names;
  };
  const offNotification = ctx.onNotification(event => { if (event.topic === "state-changed") names = null; });
  const offResync = ctx.onResync(() => { names = null; });

  const unregisterQuestion = ctx.registerQuestionRenderer({
    id: QUESTION_TYPE_ID,
    supportedContractVersions: [1],
    mountQuestion(container, props) {
      return mountQuestionBody(container, ctx.ui, props.input.question, props.input.payload, lookup, props.signal);
    },
    mountAnswerEditor(container, props) {
      return mountLabEditor(container, {
        payload: props.input.payload, initial: props.answer, active: props.active, signal: props.signal, onChange: props.onChange,
      });
    },
    mountAnswered(container, props) {
      const question = mountQuestionBody(container, ctx.ui, props.input.question, props.input.payload, lookup, props.signal);
      const answer = mountAnsweredBody(container, props.input.payload, props.answer, props.signal);
      return () => { try { answer(); } finally { question(); } };
    },
  } satisfies PluginQuestionRenderer<LabPayload, LabAnswer>);

  const unregisterProblem = ctx.registerProblemRenderer({
    id: PROBLEM_TYPE_ID,
    supportedContractVersions: [1],
    mountSubmissionEditor(container, props) {
      return asProblemHandle(mountLabEditor(container, {
        payload: props.input.payload, initial: props.submission, active: props.active, signal: props.signal,
        onChange: props.onChange, kit: { names: lookup },
      }));
    },
    mountSubmitted(container, props) {
      return mountAnsweredBody(container, props.input.payload, props.submission, props.signal);
    },
  } satisfies PluginProblemRenderer<LabPayload, LabAnswer>);

  const unregisterSettings = ctx.registerSettings((container: HTMLElement, signal: AbortSignal) => mountSettings(ctx, container, signal));

  return () => {
    try { unregisterSettings(); }
    finally {
      try { unregisterProblem(); }
      finally { try { unregisterQuestion(); } finally { offNotification(); offResync(); } }
    }
  };
}
