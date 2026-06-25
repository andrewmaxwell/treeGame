# Tree Growth Game — Backlog

Prioritized roughly by **bang-for-the-buck** (gameplay improvement ÷ effort).
Edit freely: reorder rows, change priorities, add/remove items. We'll knock these
out one at a time. See `CLAUDE.md` for the canonical design.

Sources: playtest feedback (brother, June 2026) + the "Known UX gaps" and
"Decisions Deferred" sections of `CLAUDE.md`.

## Next up (agreed direction)

- **Drag-to-stage** — Shift+drag (or long-press drag on mobile) stages every valid cell
  the cursor passes over in one gesture. Clicking cell-by-cell to plan a long branch is
  painful; playtesters called it "death." Same validity rules as tap-to-stage; stops +
  shakes on invalid cells without cancelling the drag. Touches: `game/input.ts`,
  `game/planning.ts`, `game/GameCanvas.tsx`.
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

5. **Performance** — _Value: High · Effort: Med_
   Playtesters report noticeable slowdown on large trees. Candidates (profile first):
   skip unchanged cells in the diffusion pass; dirty-rect Canvas redraws; throttle the
   light calculation to every N ticks during playback; replace hex-key string allocation
   (`"${q},${r}"`) with an integer key if it's a hot path.
   Touches: `sim/simulate.ts`, `render/renderer.ts`, likely `sim/light.ts`.

6. **Rock density gradient** — _Value: Med · Effort: Low_
   The step from 10% → 25% at depth 15 feels abrupt ("rocks become overbearing around
   20 feet"). Replace the step function with a smooth sigmoid so density rises gradually
   and the player can always push a bit deeper before hitting a wall. Overall rock
   frequency unchanged.
   Touches: `sim/grid.ts` or terrain generation in `sim/simulate.ts`.

7. **Rock destruction** — _Value: Med · Effort: Low-Med_
   Spend 20 energy during planning to remove a rock cell, opening it for root growth.
   Steep enough to be a late-game tool (ruinous on a 20-energy tree, meaningful on a
   200-energy tree). Fits the existing planning/energy framework with no new systems.
   Touches: `game/planning.ts`, `game/input.ts`, HUD cost preview.

8. **Reinforced branch** — _Value: Med · Effort: Low_
   A wood variant that costs 3 energy (vs 1) but has 2× strength in the structure
   calculation — same moment, half the stress. Useful for fruiting cantilevers and
   storm-exposed limbs. Simple extension of the existing structure model.
   Touches: `sim/cells.ts`, `sim/structure.ts`, `game/planning.ts`, `render/colors.ts`.

9. **Replacement clarity** — _Value: Med · Effort: Med_
   Staging wood over an existing leaf is supported but just renders the staged cell at
   50% opacity over the old one — no signal a _swap_ is happening. Add a distinct
   "replacing" visual (ghost/strike the replaced cell, or a swap icon).
   Touches: `render/renderer.ts`.

10. **Milestone rewards** — _Value: Med · Effort: Med_
    Currently milestones are pure achievements. Add a tangible reward on completion —
    a one-time energy grant, a permanent upkeep discount, or a new cell type unlock.
    The flower unlock on "Reach 30 cells" is the existing precedent. Design the reward
    to feel like the milestone pays off, not like something to min-max.
    Touches: `game/goals.ts`, HUD, possibly `sim/cells.ts` for new types.

11. **Playback animations** — _Value: High · Effort: Med-High_
    Biggest "feel" win. Grow-in pop for new cells, falling-leaf effect at the autumn
    drop, water/energy pulse up the trunk, leaf shimmer. Today the only motion is the
    progress bar + live 💧/⚡ totals.
    Touches: `render/renderer.ts`, playback loop in `game/GameCanvas.tsx`.

12. **Camera follows growth** — _Value: Med · Effort: Med_
    CLAUDE.md specifies a gentle drift to keep new growth in frame unless the player
    panned recently; not implemented (initial fit only).
    Touches: `render/camera.ts`, `game/GameCanvas.tsx`.

13. **Spring frost cell-kill** — _Value: Med · Effort: Low-Med_
    Forecast is already modelled ("frost risk"); the actual kill of cells placed in the
    preceding planning phase was deferred past M6. Completes a designed mechanic and
    makes early-spring planting the intended gamble.
    Touches: `sim/simulate.ts`, `sim/weather.ts`.

---

## Lower priority / polish

14. **Soil-moisture halo fix** — _Value: Low · Effort: Med_
    Only simulated soil is promoted+darkened, so a darker patch traces the root system
    ("roots darken the soil"). Cosmetic. Fix = consistent soil-moisture field or blend
    the promoted region into the default.

15. **Minimap** — _Value: Low · Effort: Med_
    Corner overview with viewport rectangle once the tree exceeds ~1.5× viewport.
    Specified, not built. Only matters once trees get large.

16. **Memorial screen** — _Value: Med · Effort: Med_
    Designed but deferred: end-of-run eulogy (final silhouette, age, peak size,
    lifetime seeds, milestones, plain-language cause of death). Death as an ending,
    not a game-over.

17. **Hall of memorials** — _Value: Low · Effort: Med_
    Cross-run best-score / longest-life record. Depends on #16.

---

## Deferred features (bigger, design exists)

18. **Underground aquifer nodes** — _Value: Med · Effort: Med_
    Discrete underground pockets that regenerate water at a high rate (or are infinite),
    placed procedurally and visible as a distinct soil colour. Finding one with your roots
    is a navigation puzzle reward — rock density and random layout make paths non-trivial.
    More interesting than the uniform depth-≥18 water table. See `CLAUDE.md` "Decisions
    Deferred."

19. **New cell types: water reserve & energy reserve** — _Value: Med · Effort: Med_
    *Cistern*: holds 200+ water, can't absorb from soil, must be charged by vascular flow.
    Drought buffer; cost 3–4 energy; initially one per tree (or milestone-unlocked).
    *Heartwood cache*: mirror for energy — banks 200+ energy, charged by diffusion, lets
    you save toward a big spring planting without hitting the cell-count storage cap.
    Both need balance validation in the harness before shipping.

20. **Conduit cell (straw)** — _Value: Med · Effort: Med_ _(pending clarification)_
    A woody cell with higher flow cap (≈5 units/tick vs 2) but near-zero storage (capacity
    1). Lets you build a vascular highway without thickening the entire trunk. Exact
    behaviour TBD — see the clarification question sent to your brother (passive high-cap
    conductor vs directed point-to-point pipe are very different to implement).

21. **Birds / canopy disturbance** — _Value: Med · Effort: High_
    Trees above ~50 cells height attract birds: can displace leaves, eat a fruit
    (maturity → 0), or snap a twig. Year 8+ difficulty layer. Build after leaf pests
    (mechanically similar leaf displacement).

22. **Horizontal growth limit with annual expansion** — _Value: Low-Med · Effort: Med_
    _(pending clarification)_ Cap how far left/right the player can place cells, expanding
    the radius each year. Focuses early play on vertical depth; forces trunk structure
    before canopy sprawl. Needs design answers (hard wall vs penalty zone, expansion rate,
    visual treatment) before building.

23. **Rot** — _Value: Med · Effort: High_
    Infection sites, rot spread, free pruning of dead/dying cells, deadwood crumbling,
    the "recover from rot" milestone. The `rot` field, `spreadRot` stub, and free pruning
    scaffolding already exist — just not driven.

24. **Leaf pests** — _Value: Low-Med · Effort: High_
    A patch of leaves loses photosynthesis and spreads leaf-to-leaf; counterplay is
    shedding affected leaves. Was slated for Year 6.

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