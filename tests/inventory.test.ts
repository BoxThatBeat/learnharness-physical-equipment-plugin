import assert from "node:assert/strict";
import { test } from "node:test";
import { Compile } from "typebox/compile";
import { answerProblems, buildInstructions, importResultSchema, problemDefinition, questionDefinition } from "../src/contract.ts";
import {
  applyEdits, applyImport, emptyState, formatListing, formatSummary, labEquipmentProblems, parseState, planImport,
} from "../src/inventory.ts";

const withItems = () => applyEdits(emptyState(), [
  { name: "Breadboard", quantity: 5, notes: "830 tie-points" },
  { name: "LED (red, 5 mm)", quantity: 4, notes: "" },
  { name: "Soldering iron", quantity: 1, notes: "60 W" },
]);

test("edits assign stable IDs that are never reused after deletion", () => {
  const state = withItems();
  assert.deepEqual(state.items.map(item => item.id), ["eq-1", "eq-2", "eq-3"]);
  const removed = applyEdits(state, state.items.filter(item => item.id !== "eq-3"));
  const added = applyEdits(removed, [...removed.items, { name: "Multimeter", quantity: 1, notes: "" }]);
  assert.equal(added.items.at(-1)?.id, "eq-4");
});

test("edits reject unknown IDs, duplicate names and bad quantities", () => {
  const state = withItems();
  assert.throws(() => applyEdits(state, [{ id: "eq-99", name: "X", quantity: 1, notes: "" }]), /unknown item ID/);
  assert.throws(() => applyEdits(state, [{ name: "LED", quantity: 1, notes: "" }, { name: " led ", quantity: 2, notes: "" }]), /duplicates row 1/);
  assert.throws(() => applyEdits(state, [{ name: "LED", quantity: 1.5, notes: "" }]), /whole number/);
  assert.throws(() => applyEdits(state, [{ name: "  ", quantity: 1, notes: "" }]), /name is required/);
});

test("saved state round-trips and newer formats are refused", () => {
  const state = withItems();
  assert.deepEqual(parseState(JSON.parse(JSON.stringify(state))), state);
  assert.throws(() => parseState({ ...state, version: 2 }), /newer than this plugin understands/);
});

test("import planning combines duplicates and marks matches; merging never deletes", () => {
  const state = withItems();
  const rows = planImport(state, [
    { name: "led (red, 5 mm)", quantity: 6, notes: "bag" },
    { name: "Resistor 220 Ω", quantity: 10, notes: "" },
    { name: "Resistor 220 Ω", quantity: 5, notes: "1/4 W" },
  ]);
  assert.deepEqual(rows, [
    { name: "led (red, 5 mm)", quantity: 6, notes: "bag", match: "eq-2" },
    { name: "Resistor 220 Ω", quantity: 15, notes: "1/4 W", match: null },
  ]);
  const merged = applyImport(state, rows);
  assert.equal(merged.items.length, 4);
  assert.deepEqual(merged.items.find(item => item.id === "eq-2"), { id: "eq-2", name: "LED (red, 5 mm)", quantity: 6, notes: "bag" });
  assert.equal(merged.items.find(item => item.id === "eq-1")?.notes, "830 tie-points");
  assert.equal(merged.items.at(-1)?.id, "eq-4");
});

test("lab equipment validation enforces listed IDs, quantities and the toggle", () => {
  const state = withItems();
  assert.deepEqual(labEquipmentProblems(state, [{ itemId: "eq-1", quantity: 1 }, { itemId: "eq-2", quantity: 4 }]), []);
  assert.match(labEquipmentProblems(state, [{ itemId: "eq-2", quantity: 3 }, { itemId: "eq-2", quantity: 2 }])[0]!, /needs 5 but the learner has 4/);
  assert.match(labEquipmentProblems(state, [{ itemId: "eq-9", quantity: 1 }])[0]!, /not in the learner's equipment list/);
  assert.match(labEquipmentProblems({ ...state, labsEnabled: false }, [])[0]!, /turned off/);
});

test("summary is capped and skips zero-quantity items; listing includes notes", () => {
  const state = applyEdits(withItems(), [...withItems().items, { name: "Oscilloscope", quantity: 0, notes: "" }]);
  assert.equal(formatSummary(state.items), "eq-1 Breadboard ×5; eq-2 LED (red, 5 mm) ×4; eq-3 Soldering iron ×1");
  assert.match(formatSummary(state.items, 30), /and 2 more \(call lab_equipment_list/);
  assert.match(formatListing(state.items), /eq-3 Soldering iron ×1 — 60 W/);
  assert.doesNotMatch(formatListing(state.items), /Oscilloscope/);
  assert.match(buildInstructions(state.items, "teacher"), /lab_question/);
  assert.match(buildInstructions(state.items, "practice"), /lab_problem.*conclude/);
});

test("schemas accept a well-formed lab and answer, and reject malformed ones", () => {
  const payload = Compile(questionDefinition.questionSchema);
  const answer = Compile(questionDefinition.answerSchema);
  const lab = { title: "Light an LED", equipment: [{ itemId: "eq-2", quantity: 1 }], safety: [], steps: ["Insert the LED", "Add a resistor"] };
  assert.equal(payload.Check(lab), true);
  assert.equal(payload.Check({ ...lab, equipment: [{ itemId: "LED", quantity: 1 }] }), false);
  assert.equal(payload.Check({ ...lab, steps: [] }), false);
  assert.equal(Compile(problemDefinition.problemSchema).Check(lab), true);
  assert.equal(answer.Check({ completed: [true, false], observations: "It glowed." }), true);
  assert.equal(answer.Check({ completed: [true, false], observations: "   " }), false);
  assert.deepEqual(answerProblems(lab, { completed: [true], observations: "x" }), ["Expected 2 step checkmarks, received 1."]);
  assert.equal(Compile(importResultSchema).Check({ items: [{ name: "LED", quantity: 1, notes: "" }] }), true);
});
