# Lab equipment (LearnHarness plugin)

Tell LearnHarness which physical equipment you own (breadboards, LEDs, a soldering
iron, …) so the teacher and practice agents can include hands-on labs that use only
that kit.

## What it does

- **Settings → Lab equipment** has three parts:
  - An **Enable physical labs** toggle.
  - An editable equipment table with name, quantity and notes.
  - **Import from text**: paste a free-form description of your kit and press Parse.
    A model turns it into items, which you review and edit before merging. Merging
    matches items by name: it updates quantities (and notes, when given) and adds new
    items. It never deletes anything.
- **Teacher and practice prompts** get a short note that labs are optional, plus a
  compact inventory summary (`eq-1 Breadboard ×5; …`). The prompt changes only after
  you save; only later turns see it.
- **The `lab_equipment_list` tool** gives the full list with notes. It is read-only and
  makes no model call.
- **The `lab_question` tool (teacher)** and **`lab_problem` tool (practice)** pose a
  structured lab: a title, the equipment needed (by `eq-N` ID and quantity), safety
  notes and steps. You tick off the steps you completed and write what you observed.
  - Labs that use unlisted equipment, or more than you have, are rejected before
    they're shown.
  - Practice labs are assessed and closed by the host's own `conclude` tool.

Items with quantity 0 stay in your list but are hidden from the agents. Item IDs are
never reused, so old labs keep pointing at the right item.

Turning labs off removes the instructions and the list tool from new turns, and new
labs are refused. Labs already in your history still display and can still be answered.

## Data

`<plugin data>/inventory.json` (in the sibling `data/` folder) holds the equipment, the
toggle, the import model override and any pending import preview.

- Writes are atomic.
- If the file is unreadable, or uses a newer format, the plugin leaves it untouched,
  turns itself off and shows the error in Settings.

## Import model and cost

Import uses the host's **cheap** model slot, unless you pick a model in the import
section. Each Parse makes one model request (purpose `user`), which may cost money.
Nothing runs unless you press Parse. The pasted text is treated as data; at most 20,000
characters are accepted per Parse.

## Install from GitHub

Requires LearnHarness 0.6.1 or later, and Node.js with npm for the build. Clone into
the plugins directory shown in **Settings → Community plugins**. The folder must be
named `lab-equipment`, to match the manifest ID.

```sh
git clone https://github.com/BoxThatBeat/learnharness-physical-equipment-plugin.git "<plugins directory>/lab-equipment"
cd "<plugins directory>/lab-equipment"
npm ci
npm run build
```

Refresh the Community plugins list and enable **Lab equipment**. To update later, run
`git pull && npm ci && npm run build`, then restart LearnHarness.

## Develop elsewhere

```sh
npm ci            # or npm install
npm run typecheck
npm test
npm run build     # writes dist/
npm run install:local -- "<plugins directory from Settings → Community plugins>"
```

Then refresh the plugin list and enable **Lab equipment**. Restart LearnHarness after
updating code that is already loaded. Updating replaces only `dist/`; `data/` is kept.

`.sdk/` is the type-only LearnHarness plugin SDK (API v1, from app 0.6.1).

## License

AGPL-3.0-only (see `LICENSE`). The bundled `.sdk/` types and
`scripts/install-plugin-local.mjs` come from the LearnHarness plugin authoring kit,
which is AGPL-3.0.
