# Tree Growth Game — Backlog

Prioritized roughly by **bang-for-the-buck** (gameplay improvement ÷ effort).
Edit freely: reorder rows, change priorities, add/remove items. We'll knock these
out one at a time. See `CLAUDE.md` for the canonical design.

Sources: playtest feedback (brother, June 2026) + the "Known UX gaps" and
"Decisions Deferred" sections of `CLAUDE.md`.

## Next up (agreed direction)

- **Diagnostic upgrades** — per-height band breakdown (water/health by altitude) + a
  smarter verdict so the report stops saying "balanced" when a tree is actually dying.
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
