# Tree Growth Game — Backlog

Prioritized roughly by **bang-for-the-buck** (gameplay improvement ÷ effort).
Edit freely: reorder rows, change priorities, add/remove items. We'll knock these
out one at a time. See `CLAUDE.md` for the canonical design.

Sources: playtest feedback (brother, June 2026) + the "Known UX gaps" and
"Decisions Deferred" sections of `CLAUDE.md`.

---

## Near-term sprint (recommended order)

These four knock out most of the playtest complaints at low–medium effort.
**✅ All four shipped** (water/energy overlay toggle, altitude ruler, clearer
next-season label, bulk speed-prune mode). Guarded by `prune.test.ts` +
`colors.test.ts`; full suite green.

1. ✅ **Resource-flow overlay** — *Value: High · Effort: Med*
   Toggleable overlay tinting cells by water and/or energy level, ideally with
   flow direction up the trunk. Makes the whole sim legible: conduction caps,
   trunk-width bottlenecks, thirsty fruit. **Also delivers the brother's
   "thick roots less effective at water extraction" point** — that's already
   true in the sim (only soil-adjacent root cells absorb; a thick root blob's
   interior touches no soil), it's just invisible today.
   Touches: `render/renderer.ts`, `render/colors.ts`, HUD toggle.

2. ✅ **Depth/height ruler** — *Value: Med · Effort: Low*
   Faint horizontal tick marks every 10 cells along a screen edge, labeled
   (+10/+20 up, −10/−20 down), drawn in world-space so they scroll with the
   camera. Removes the "count to depth 18 / height 10" friction.
   Touches: `render/renderer.ts`.

3. ✅ **Clearer next-season label** — *Value: Med · Effort: Low*
   The HUD already shows `Next: Summer · {forecast}` (`ui/HUD.tsx`), but it's
   small and greyed. Emphasize it and spell out *why it matters*
   ("Next: Summer — hot & dry, water stress"). Consider de-emphasizing the
   "Mar–May" month subtitle, which may add to the confusion.
   Touches: `ui/HUD.tsx`, `ui/HUD.module.css`.

4. ✅ **Multiselect / drag pruning** — *Value: Med-High · Effort: Med*
   (Shipped as tap-to-select bulk-prune mode — drag-paint could be a later
   refinement, but tap-toggle is the mobile-safe core.)
   Pruning is one-cell-at-a-time today (`game/prune.ts`) and gets tedious.
   `applyBreakage` already removes a *set* of cells, so this is mostly an
   input/UI job: drag-to-select or shift-multiselect, then one confirm with a
   combined removal preview.
   Touches: `game/GameCanvas.tsx`, `game/prune.ts`, inspector UI.

---

## Recently shipped (post-playtest)

- ✅ **Save-file diagnostic** (`src/game/diagnose.ts`) — dense health report logged to
  the browser console on load + `treegameDiagnose()` helper + `cli/diagnose.ts`. The
  way to share a run as copyable text instead of a screenshot.
- ✅ **Winter wood die-off fix** — dry structural wood now floors at half-health
  (`WOOD_DRY_HEALTH`) instead of decaying to deadwood; thirst never kills wood (only
  rot/storms/pruning do). Killed the deciduous "pile of dead wood every winter" that
  scaled with tree size. Validated in `cli/winter.ts`; strategy balance unchanged.
- ✅ **Auto-leaves** — the canopy auto-grows (free) on well-lit hexes ≥3 above the spawn
  ground; the player only shapes wood (and flowers). Removed Leaf mode, Fill Leaves, and
  the entire shed mechanic (incl. the "leaves stay until end of sim" confusion). The
  `MIN_LEAF_HEIGHT` gate kills the ground-crawler the free leaves would otherwise revive
  (harness re-validated: crawler ~1, balanced ~23). Canvas previews the canopy in green.
- ✅ **Carbon–water coupling (energy-scarcity fix)** — photosynthesis now scales with leaf
  water, so a canopy you can't water can't print energy. Kills the runaway surplus (273-cell
  tree banking ~900 with nothing to spend it on); over-building now craters its own income
  and self-corrects (`cli/bigtree.ts`). Disciplined growers unaffected; balance/recovery
  re-validated.
- ✅ **Prune-whole-tree guard** — can't prune your single-cell / entire tree out of existence.

## Next up (agreed direction)

- **Diagnostic upgrades** — per-height band breakdown (water/health by altitude) + a
  smarter verdict so the report stops saying "balanced" when a tree is actually dying.
- **Auto-clear deadwood** (one-tap or automatic crumble) — further trims the late-game
  prune chore your brother flagged.

## Open question — height incentive / crawlers

You picked "crawlers viable but worse," but the harness says that's **not achievable** with
the current systems: a low/wide canopy is naturally *great* at reproduction (wide, well-
watered, low storm-moment) and energy-scarcity (the water coupling) doesn't touch it because
its leaves are well-watered. So the crawler is either **dominant** (gate low) or **dead**
(walled by `MIN_LEAF_HEIGHT = 3`) — no middle ground. A real soft height incentive needs the
deferred **multi-tree shade competition** (the actual in-world reason to grow tall). Options:
keep the wall (current), add an artificial low-canopy penalty (hacky), or build competition.

## Backlog (next)

5. **Replacement clarity** — *Value: Med · Effort: Med*
   Staging wood/leaf over an existing cell is supported (`game/planning.ts`)
   but just renders the staged cell at 50% opacity over the old one — no signal
   a *swap* is happening. Add a distinct "replacing" visual (ghost/strike the
   replaced cell under the staged one, or a swap icon).
   Touches: `render/renderer.ts`.

6. **Playback animations** — *Value: High · Effort: Med-High*
   Biggest "feel" win. Grow-in pop for new cells, falling-leaf effect at the
   autumn drop, water/energy pulse up the trunk (pairs with #1), leaf shimmer.
   Today the only motion is the progress bar + live 💧/⚡ totals.
   Touches: `render/renderer.ts`, playback loop in `game/GameCanvas.tsx`.

7. **Camera follows growth** — *Value: Med · Effort: Med*
   CLAUDE.md specifies a gentle drift to keep new growth in frame unless the
   player panned recently; not implemented (initial fit only).
   Touches: `render/camera.ts`, `game/GameCanvas.tsx`.

8. **Spring frost cell-kill** — *Value: Med · Effort: Low-Med*
   Forecast is already modelled ("frost risk"); the actual kill of cells placed
   in the preceding planning phase was deferred past M6. Completes a designed
   mechanic and makes early-spring planting the intended gamble.
   Touches: `sim/simulate.ts`, `sim/weather.ts`.

---

## Lower priority / polish

9. **Soil-moisture halo fix** — *Value: Low · Effort: Med*
   Only simulated soil is promoted+darkened, so a darker patch traces the root
   system ("roots darken the soil"). Cosmetic. Fix = consistent soil-moisture
   field or blend the promoted region into the default.

10. **Minimap** — *Value: Low · Effort: Med*
    Corner overview with viewport rectangle once the tree exceeds ~1.5×
    viewport. Specified, not built. Only matters once trees get large.

11. **Memorial screen** — *Value: Med · Effort: Med*
    Designed but deferred: end-of-run eulogy (final silhouette, age, peak size,
    lifetime seeds, milestones, plain-language cause of death). Death as an
    ending, not a game-over.

12. **Hall of memorials** — *Value: Low · Effort: Med*
    Cross-run best-score / longest-life record. Depends on #11.

---

## Deferred features (bigger, design exists)

13. **Rot** — *Value: Med · Effort: High*
    Infection sites, rot spread, free pruning of dead/dying cells, deadwood
    crumbling, the "recover from rot" milestone. The `rot` field, `spreadRot`
    stub, and free pruning scaffolding already exist — just not driven.

14. **Leaf pests** — *Value: Low-Med · Effort: High*
    A patch of leaves loses photosynthesis and spreads leaf-to-leaf; counterplay
    is shedding affected leaves. Was slated for Year 6.

---

## Playtest items recommended for DECLINE

- **Root fragility — single long roots more fragile than thick roots.**
  Roots never break by design (storms skip underground; the support graph is
  *grounded* at the roots). Adding root stress/uprooting fights the established
  "a tree blows down at the trunk, it isn't uprooted" decision, and deep
  taproots are realistically strong. Recommend shelve.

- **Dropped seeds have a % chance to root into new trees.**
  Off-thesis: the game is one tree scored by lifetime seeds. Germination would
  touch terrain, camera, light competition, and the win condition. Great
  *sequel* idea; out of scope here. Recommend decline.

---

## Needs info

- **"More turns per season (like 3 turns each)."** — *Ask the brother what he
  meant.* Could be: (a) ran out of energy after ~3 placements (balance/
  onboarding fix, not a turn system); (b) wants to pause the 60-tick sim and
  act mid-season (real loop change); or (c) wants more, shorter seasons overall
  (cadence rework). Don't prioritize until clarified — the three readings have
  wildly different effort.
