# Tree Growth Game — Backlog

Prioritized roughly by **bang-for-the-buck** (gameplay improvement ÷ effort).
Edit freely: reorder rows, change priorities, add/remove items. We'll knock these
out one at a time. See `CLAUDE.md` for the canonical design.

Sources: playtest feedback (brother, June 2026) + the "Known UX gaps" and
"Decisions Deferred" sections of `CLAUDE.md`.

## Next up (agreed direction)

The near-term, non-duplicated priorities. The fuller wishlist (deferred cell types,
environmental threats, etc.) lives in the numbered "Backlog (next)" and "Deferred features"
sections below — items that previously appeared in both lists have been consolidated there,
with real file paths, to stop the two lists drifting apart.

- **Finish the two `0.0.2` scaffolding features.** Both have full sim plumbing but are
  unreachable in play (see `CLAUDE.md` "In-Progress / Experimental Features"):
  - _Reinforced wood_ — add the **placement path**: a `PlacementMode`, an energy cost, and a
    HUD toggle that stages a `'reenforced wood'` cell. The structure/upkeep/colour handlers
    already exist (½ moment/stress, 0.075 water upkeep, no leaves/flowers by design); without
    a placement path none of them ever fire. Touches: `game/planning.ts`, `ui/HUD.tsx`, `App.tsx`.
  - _Ground water_ — lower `groundWaterProbability`'s spawn depth (currently `>= 100`, far
    below the ~28–35-cell soil column, so a root can't reach it) into reachable terrain and
    re-tune (it's an infinite source, `GROUND_WATER_CAP = 200` sentinel). Then retire the
    nerfed water-table regen (`0.1 → 0.01/tick`, cap halved, marked `// TODO: Playtest`).
    Touches: `sim/terrain.ts`, `sim/simulate.ts`.
- **Drag-to-stage on mobile.** Desktop Shift+drag is **already built** (`buildDragRef` in
  `game/GameCanvas.tsx`, shares tap-to-stage validity via a `visited` set). The touch
  equivalent is not: add a long-press timer that flips a single-touch drag into build mode so
  mobile gets the same one-gesture branch planting. Touches: `game/GameCanvas.tsx`.
- **Diagnostic upgrades** — per-height band breakdown (water/health by altitude) + a smarter
  verdict so the report stops saying "balanced" when a tree is actually dying.
  Touches: `game/diagnose.ts`.
- **Energy-view polish** — the ⚡ overlay should highlight cells more brightly / legibly.
  Touches: `render/colors.ts`, `render/renderer.ts`. (See also numbered #11 playback animations.)
- **Auto-clear deadwood** (one-tap or automatic crumble) — trims the late-game prune chore
  your brother flagged. Pairs with the deferred Rot work (#23), which adds deadwood crumbling.

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
   Touches: `sim/simulate.ts` (light/water/energy passes all live here), `render/renderer.ts`.

6. **Rock density gradient** — _Value: Med · Effort: Low_
   Partially addressed (deep tiers softened — see "Done → Rock gradient (partial)"), but
   `rockProbability` is **still a step function** (0 / 0.1 / 0.25 / 0.35 / 0.45 by depth band).
   Replace it with a smooth sigmoid so density rises gradually and the player can always push
   a bit deeper before hitting a wall. Keep overall rock frequency roughly unchanged.
   Touches: `sim/terrain.ts`.

7. **Rock destruction** — _Value: Med · Effort: Low-Med_
   Spend 20 energy during planning to remove a rock cell, opening it for root growth.
   Steep enough to be a late-game tool (ruinous on a 20-energy tree, meaningful on a
   200-energy tree). Fits the existing planning/energy framework with no new systems.
   Touches: `game/planning.ts`, `game/GameCanvas.tsx` (input), HUD cost preview.

8. **Reinforced branch** — _Value: Med · Effort: Low_
   A wood variant that costs more energy (vs 1) but has 2× strength in the structure
   calculation — same moment, half the stress. Useful for fruiting cantilevers and
   storm-exposed limbs. **Most of this already exists** as the `'reenforced wood'` scaffolding
   (see "Next up → Finish the two `0.0.2` scaffolding features"); the remaining work is the
   placement path, not the structure model.
   Touches: `game/planning.ts`, `ui/HUD.tsx`, `App.tsx`.

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
    Both need balance validation in the harness before shipping. (Stretch idea: let three
    reserve cells of a kind merge into one double-capacity cell, as a late-game upgrade.)

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

- **Auto-build (desktop)** — ✅ Built: Shift + drag stages every valid cell under the cursor
  in one gesture (`buildDragRef` in `game/GameCanvas.tsx`). **Mobile long-press drag is still
  pending** — tracked under "Next up → Drag-to-stage on mobile" above.

- **Rock gradient (partial)** — ⚠️ Partially done: the deep tiers were softened (an extra
  25–35 depth band added, deepest density lowered 60% → 45% in `rockProbability`,
  `sim/terrain.ts`), which eases the "rocks overbearing around 20 feet" complaint. But it's
  **still a step function**, not the smooth sigmoid the design calls for — the true gradient
  fix remains open as numbered #6 "Rock density gradient" below.