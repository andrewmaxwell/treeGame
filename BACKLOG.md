# Tree Growth Game — Backlog

Prioritized roughly by **bang-for-the-buck** (gameplay improvement ÷ effort).
Edit freely: reorder rows, change priorities, add/remove items. We'll knock these
out one at a time. See `CLAUDE.md` for the canonical design; completed work is
condensed under "Done" at the bottom (full detail lives in `CLAUDE.md`).

Sources: playtest feedback (brother, June 2026) + the "Known UX gaps" and
"Decisions Deferred" sections of `CLAUDE.md`.

## Next up (open, near-term)

- **Energy-view polish** — the ⚡ overlay should highlight cells more brightly / legibly.
  Touches: `render/colors.ts`, `render/renderer.ts`. (See also #5 playback animations.)

## Open question — height incentive / crawlers

You picked "crawlers viable but worse," but the harness says that's **not achievable** with
the current systems: a low/wide canopy is naturally _great_ at reproduction (wide, well-
watered, low storm-moment) and energy-scarcity (the water coupling) doesn't touch it because
its leaves are well-watered. So the crawler is either **dominant** (gate low) or **dead**
(walled by `MIN_LEAF_HEIGHT = 3`) — no middle ground. A real soft height incentive needs the
deferred **multi-tree shade competition** (the actual in-world reason to grow tall). Options:
keep the wall (current), add an artificial low-canopy penalty (hacky), or build competition.

## Backlog (next)

1. **Playback animations** — ✅ **mostly done** (_remaining: trunk resource-pulse_).
   Shipped: **grow-in pop** for new wood/leaves, a **falling-leaf** particle drop at the autumn
   shed / storm loss, and a subtle **leaf shimmer** so mid-season playback reads as alive — all
   render-only (the sim stays pure), driven by diffing displayed frames + `performance.now()`.
   See `render/renderer.ts` (`SceneAnim`/`GROW_MS`/`popScale`/`drawLeafShimmer`) and
   `game/GameCanvas.tsx` (`animRef`/`spawnParticle`/`drawParticles`). **Still open:** the
   water/energy **pulse up the trunk** (a moving height-banded highlight or true flow viz) —
   deferred as the fiddliest of the four. Touches: `render/renderer.ts`, `game/GameCanvas.tsx`.

2. **Performance (streaming playback / worker)** — _Value: High · Effort: High_
   The two dominant bottlenecks are already fixed (render-loop overlay caching, a 4×
   `computeStructure` rewrite, diffusion-alloc cleanup, zoomed-out draw — see `CLAUDE.md`
   "Performance"). What remains: the season advance is still a multi-second freeze at ~10k
   cells because the sim keeps a full deep `Map` snapshot per tick. Clean fix = **stream
   playback** (simulate tick N while displaying N−1) or move the sim to a **Web Worker**.
   Still-open smaller candidates: dirty-rect redraws, throttle light calc every N ticks,
   integer hex keys. Re-check with `npx tsx src/cli/perf.ts`.
   Touches: `sim/simulate.ts`, `game/GameCanvas.tsx`, `render/renderer.ts`.

3. **Rock destruction** — _Value: Med · Effort: Low-Med_
   Spend 20 energy during planning to remove a rock cell, opening it for root growth.
   Steep enough to be a late-game tool (ruinous on a 20-energy tree, meaningful on a
   200-energy tree). Fits the existing planning/energy framework with no new systems.
   Touches: `game/planning.ts`, `game/GameCanvas.tsx` (input), HUD cost preview.

4. **Spring frost cell-kill** — _Value: Med · Effort: Low-Med_
   Forecast is already modelled ("frost risk"); the actual kill of cells placed in the
   preceding planning phase was deferred past M6. Completes a designed mechanic and
   makes early-spring planting the intended gamble.
   Touches: `sim/simulate.ts`, `sim/weather.ts`.

5. **Camera follows growth** — _Value: Med · Effort: Med_
   `CLAUDE.md` specifies a gentle drift to keep new growth in frame unless the player
   panned recently; not implemented (initial fit only).
   Touches: `render/camera.ts`, `game/GameCanvas.tsx`.

6. **Replacement clarity** — _Value: Med · Effort: Med_
   Staging wood over an existing leaf is supported but just renders the staged cell at
   50% opacity over the old one — no signal a _swap_ is happening. Add a distinct
   "replacing" visual (ghost/strike the replaced cell, or a swap icon).
   Touches: `render/renderer.ts`.

7. **Milestone rewards** — _Value: Med · Effort: Med_
   Currently milestones are pure achievements. Add a tangible reward on completion —
   a one-time energy grant, a permanent upkeep discount, or a new cell type unlock.
   The flower unlock on "Reach 30 cells" is the existing precedent. Design the reward
   to feel like the milestone pays off, not like something to min-max.
   Touches: `game/goals.ts`, HUD, possibly `sim/cells.ts` for new types.

8. **Reinforced wood polish** _(follow-up to the shipped feature)_ — _Value: Low · Effort: Low_
   Tune the 2⚡ cost / 30-cell unlock gate against the harness, and give reinforced wood a
   distinct placement-hint colour so its staged spots read differently from normal wood.
   Touches: `game/planning.ts`, `render/renderer.ts`.

---

## Lower priority / polish

9. **Soil-moisture halo fix** — _Value: Low · Effort: Med_
   Only simulated soil is promoted+darkened, so a darker patch traces the root system
   ("roots darken the soil"). Cosmetic. Fix = consistent soil-moisture field or blend
   the promoted region into the default.

10. **Minimap** — _Value: Low · Effort: Med_
    Corner overview with viewport rectangle once the tree exceeds ~1.5× viewport.
    Specified, not built. Only matters once trees get large.

11. **Memorial screen** — _Value: Med · Effort: Med_
    Designed but deferred: end-of-run eulogy (final silhouette, age, peak size,
    lifetime seeds, milestones, plain-language cause of death). Death as an ending,
    not a game-over.

12. **Hall of memorials** — _Value: Low · Effort: Med_
    Cross-run best-score / longest-life record. Depends on #11.

---

## Deferred features (bigger, design exists)

13. **Aquifer nodes — clustered variant** — _Value: Low · Effort: Med_
    The core aquifer idea shipped as `'ground water'` (rare infinite scattered cells). What
    remains _optional_: **clustered** multi-cell aquifers (vs single cells) and a finite
    high-regen variant distinct from the infinite pockets. See `CLAUDE.md` "Shipped cell
    types" and "Soil depth and rocks".

14. **New cell types: water reserve & energy reserve** — _Value: Med · Effort: Med_
    _Cistern_: holds 200+ water, can't absorb from soil, must be charged by vascular flow.
    Drought buffer; cost 3–4 energy; initially one per tree (or milestone-unlocked).
    _Heartwood cache_: mirror for energy — banks 200+ energy, charged by diffusion, lets
    you save toward a big spring planting without hitting the cell-count storage cap.
    Both need balance validation in the harness before shipping. (Stretch idea: let three
    reserve cells of a kind merge into one double-capacity cell, as a late-game upgrade.)

15. **Conduit cell (straw)** — _Value: Med · Effort: Med_ _(pending clarification)_
    A woody cell with higher flow cap (≈5 units/tick vs 2) but near-zero storage (capacity
    1). Lets you build a vascular highway without thickening the entire trunk. Exact
    behaviour TBD — see the clarification question sent to your brother (passive high-cap
    conductor vs directed point-to-point pipe are very different to implement).

16. **Birds / canopy disturbance** — _Value: Med · Effort: High_
    Trees above ~50 cells height attract birds: can displace leaves, eat a fruit
    (maturity → 0), or snap a twig. Year 8+ difficulty layer. Build after leaf pests
    (mechanically similar leaf displacement).

17. **Horizontal growth limit with annual expansion** — _Value: Low-Med · Effort: Med_
    _(pending clarification)_ Cap how far left/right the player can place cells, expanding
    the radius each year. Focuses early play on vertical depth; forces trunk structure
    before canopy sprawl. Needs design answers (hard wall vs penalty zone, expansion rate,
    visual treatment) before building.

18. **Rot** — _Value: Med · Effort: High_
    Infection sites, rot spread, free pruning of dead/dying cells, the 5-season deadwood
    linger, the "recover from rot" milestone. The `rot` field, `spreadRot` stub, free
    pruning, and immediate `crumbleDeadwood` already exist — the spread/infection isn't
    driven yet.

19. **Leaf pests** — _Value: Low-Med · Effort: High_
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

(Condensed — see `CLAUDE.md` for full implementation notes.)

- **Ground water** — very rare deep infinite-supply pockets (depth ≥ 25, a fraction of a
  percent even deep — a true "jackpot"), with the deep water-table regen restored as the
  reliable "floor". `tap-spring` milestone + diagnostic line. Last of the `0.0.2` scaffolding.
  (`sim/terrain.ts`, `sim/simulate.ts`, `game/goals.ts`, `game/diagnose.ts`; tests in
  `sim/terrain.test.ts`, `game/goals.test.ts`.)
- **Diagnostic upgrades** — per-altitude vertical profile (water & health by band), an
  "Avg living health" headline, and a smarter verdict that flags decline / "starves with
  height" / graying instead of falsely reporting "balanced". (`game/diagnose.ts`,
  `game/diagnose.test.ts`.)
- **Drag-to-stage on mobile** — single-finger long-press flips a touch into build-drag
  (haptic), reusing the desktop `buildDragRef` path; clean cancel on pan/pinch/end.
  (`game/GameCanvas.tsx`.)
- **Auto-clear deadwood** — `crumbleDeadwood` removes non-load-bearing dead stubs at season
  end via the shared `applyBreakage` rule. (`sim/simulate.ts`.)
- **Reinforced wood** — a `"reinforced"` `PlacementMode` (2⚡, ½ structural stress, no
  leaves/flowers), gated behind the 30-cell milestone with a HUD toggle. (`game/planning.ts`,
  `ui/HUD.tsx`, `App.tsx`.)
- **Half-season checkpoints (M11)** — a season simulates in two 30-tick halves with a planning
  checkpoint between, keeping the four-season rhythm. ("More turns per season.")
- **Pruning leaves (M11)** — leaves are no longer pruneable; flower/fruit pruning is free;
  wound-sealing cost applies only to healthy wood.
- **Auto-build (desktop)** — Shift + drag stages every valid cell under the cursor in one
  gesture (`buildDragRef` in `game/GameCanvas.tsx`).
- **Rock density gradient** — `rockProbability` is a smooth logistic sigmoid instead of a step
  function, so density rises gradually with depth (no hard wall). (`sim/terrain.ts`.)
