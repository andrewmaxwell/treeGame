# Tree Growth Game — Backlog

Prioritized roughly by **bang-for-the-buck** (gameplay improvement ÷ effort).
Edit freely: reorder rows, change priorities, add/remove items. We'll knock these
out one at a time. See `CLAUDE.md` for the canonical design.

Sources: playtest feedback (brother, June 2026) + the "Known UX gaps" and
"Decisions Deferred" sections of `CLAUDE.md`.

## Next up (agreed direction)

- **Diagnostic upgrades** — per-height band breakdown (water/health by altitude) + a
  smarter verdict so the report stops saying "balanced" when a tree is actually dying.

- **Rock destruction** — _Value: Med · Effort: Low-Med_
  Implement rock destruction requiring 20 energy per rock.
  Touches: `game/actions.ts`, `terrain/rock management.ts`.

- **Milestone rewards** — _Value: Med · Effort: Low-Med_
  Add new cells as rewards for hitting milestones.
  Touches: `game/milestones.ts`, `game/cell management.ts`.

- **Horizontal growth limit** — _Value: Med · Effort: Low-Med_
  Limit plant width horizontally, focusing on depth. Increment size per year/season.
  Touches: `game/growth.ts`, `terrain/terrain generation.ts`.

- **Infinite water stores** — _Value: High · Effort: Med-High_ — 🔨 **scaffolding in progress (branch `0.0.2`)**
  Replace ground wetness with infinite water stores requiring creative root growth.
  The `'ground water'` cell type exists and behaves as an infinite source in the sim
  (`GROUND_WATER_CAP = 200` save-safe sentinel), but it spawns only at `depth >= 100`, so it
  is **currently unreachable**. Meanwhile the old water-table regen was kept but heavily
  nerfed (`0.1 → 0.01/tick`, cap halved) and marked `// TODO: Playtest`. Remaining work:
  lower the spawn depth into reachable terrain and re-tune, then retire the water-table line.
  See `CLAUDE.md` "In-Progress / Experimental Features".
  Touches: `sim/terrain.ts`, `sim/simulate.ts`.

- **Resource intensity optimization** — _Value: High · Effort: High_
  Identify and optimize resource-intensive parts of the game.
  Touches: `game/simulation.ts`, `game/performance analysis.ts`.

- **Bird predation** — _Value: Med-High · Effort: Low-Med_
  Implement bird predation for plants above 50ft, eating or moving leaves/branches.
  Touches: `game/environmental factors.ts`, `game/plant interaction.ts`.

- **Water reserve cells** — _Value: High · Effort: Low-Med_
  Create cells storing up to 200+ water with no absorption capability.
  Touches: `game/cell types.ts`, `terrain/water management.ts`.

- **Energy reserve cells** — _Value: High · Effort: Low-Med_
  Create cells storing up to 200+ energy with no photosynthesis capability.
  Touches: `game/cell types.ts`, `game/energy management.ts`.

- **Water/Energy+ reserve cells** — _Value: High · Effort: Low-Med_
  Combine three water or energy reserve cells into one that doubles resource storage.
  Touches: `game/cell interactions.ts`, `terrain/root growth.ts`.

- **Straws** — _Value: High · Effort: Low-Med_
  Implement straws to move water and energy more efficiently between points.
  Touches: `game/cell types.ts`, `terrain/energy distribution.ts`.

- **Re-enforced branches** — _Value: High · Effort: Low-Med_ — 🔨 **scaffolding in progress (branch `0.0.2`)**
  Create reinforced branches that handle greater load stress, costing extra resources.
  The `'reenforced wood'` cell type and all its sim plumbing exist (½ moment/stress,
  0.075 water upkeep, no leaves/flowers by design), but it is **not placeable yet** — no
  `PlacementMode`, cost, or HUD toggle creates one, so it's currently inert. Remaining work
  is the placement path + cost. See `CLAUDE.md` "In-Progress / Experimental Features".
  Touches: `game/planning.ts`, `ui/HUD.tsx`, `App.tsx`.

- **Energy view improvements** — _Value: Med-High · Effort: Low-Med_
  Improve the energy view button to highlight cells brightly and enhance visibility.
  Touches: `render/renderer.ts`, `game/energy management.ts`.

- **Auto-clear deadwood** (one-tap or automatic crumble) — further trims the late-game
  prune chore your brother flagged.

## Open question — height incentive / crawlers

You picked "crawlers viable but worse," but the harness says that's **not achievable** with
the current systems: a low/wide canopy is naturally _great_ at reproduction (wide, well-
watered, low storm-moment) and energy-scarcity (the water coupling) doesn't touch it because
its leaves are well-watered. So the crawler is either **dominant** (gate low) or **dead**
(walled by `MIN_LEAF_HEIGHT = 3`) — no middle ground. A real soft height incentive needs the
deferred **multi-tree shade competition** (the actual in-world reason to grow tall). Options:
keep the wall (current), add an artificial low-canopy penalty (hacky), or build competition.

## Backlog (next)

5. **Replacement clarity** — _Value: Med · Effort: Med_
   Staging wood/leaf over an existing cell is supported (`game/planning.ts`)
   but just renders the staged cell at 50% opacity over the old one — no signal
   a _swap_ is happening. Add a distinct "replacing" visual (ghost/strike the
   replaced cell under the staged one, or a swap icon).
   Touches: `render/renderer.ts`.

6. **Playback animations** — _Value: High · Effort: Med-High_
   Biggest "feel" win. Grow-in pop for new cells, falling-leaf effect at the
   autumn drop, water/energy pulse up the trunk (pairs with #1), leaf shimmer.
   Today the only motion is the progress bar + live 💧/⚡ totals.
   Touches: `render/renderer.ts`, playback loop in `game/GameCanvas.tsx`.

7. **Camera follows growth** — _Value: Med · Effort: Med_
   CLAUDE.md specifies a gentle drift to keep new growth in frame unless the
   player panned recently; not implemented (initial fit only).
   Touches: `render/camera.ts`, `game/GameCanvas.tsx`.

8. **Spring frost cell-kill** — _Value: Med · Effort: Low-Med_
   Forecast is already modelled ("frost risk"); the actual kill of cells placed
   in the preceding planning phase was deferred past M6. Completes a designed
   mechanic and makes early-spring planting the intended gamble.
   Touches: `sim/simulate.ts`, `sim/weather.ts`.

---

## Lower priority / polish

9. **Soil-moisture halo fix** — _Value: Low · Effort: Med_
   Only simulated soil is promoted+darkened, so a darker patch traces the root
   system ("roots darken the soil"). Cosmetic. Fix = consistent soil-moisture
   field or blend the promoted region into the default.

10. **Minimap** — _Value: Low · Effort: Med_
    Corner overview with viewport rectangle once the tree exceeds ~1.5×
    viewport. Specified, not built. Only matters once trees get large.

11. **Memorial screen** — _Value: Med · Effort: Med_
    Designed but deferred: end-of-run eulogy (final silhouette, age, peak size,
    lifetime seeds, milestones, plain-language cause of death). Death as an
    ending, not a game-over.

12. **Hall of memorials** — _Value: Low · Effort: Med_
    Cross-run best-score / longest-life record. Depends on #11.

---

## Deferred features (bigger, design exists)

13. **Rot** — _Value: Med · Effort: High_
    Infection sites, rot spread, free pruning of dead/dying cells, deadwood
    crumbling, the "recover from rot" milestone. The `rot` field, `spreadRot`
    stub, and free pruning scaffolding already exist — just not driven.

14. **Leaf pests** — _Value: Low-Med · Effort: High_
    A patch of leaves loses photosynthesis and spreads leaf-to-leaf; counterplay
    is shedding affected leaves. Was slated for Year 6.

---

## Playtest items recommended for DECLINE

- **Root fragility — single long roots more fragile than thick roots.**
  Roots never break by design (storms skip underground; the support graph is
  _grounded_ at the roots). Adding root stress/uprooting fights the established
  "a tree blows down at the trunk, it isn't uprooted" decision, and deep
  taproots are realistically strong. Recommend shelve.

- **Dropped seeds have a % chance to root into new trees.**
  Off-thesis: the game is one tree scored by lifetime seeds. Germination would
  touch terrain, camera, light competition, and the win condition. Great
  _sequel_ idea; out of scope here. Recommend decline.

---

## Done

- **"More turns per season."** — ✅ Built as **half-season checkpoints** (M11): a season
  simulates in two 30-tick halves with a planning checkpoint between (reading (b)/(c) — pause
  mid-season and act, more frequent shorter planning), keeping the four-season rhythm. See
  `CLAUDE.md` "Tick structure" → "Half-season checkpoints". Open follow-up if wanted: a
  per-half balance pass (faster yearly growth is a mild easing the headless harness doesn't
  model, since it still drives full seasons).

- **Pruning leaves.** — ✅ Fixed (M11): leaves are no longer pruneable (`isPruneable`); the
  inspector shows their stats but no prune button, and bulk-prune skips them. Flower/fruit
  pruning is now **free**; wound-sealing cost applies only to healthy wood. See `CLAUDE.md`
  "Pruning".

- **Auto-build** — _Value: High · Effort: Low-Med_
  Shift + click + drag to auto build everything under your mouse. Clicking one at a time is inefficient.

- **Rock gradient** — _Value: Med · Effort: Low-Med_
  Around 20 feet, rocks become overbearing. Replace with a gradient for deeper growth.
  Update included and additional depth condition and reducing the default probability