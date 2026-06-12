# Tree Growth Game — Project Context

This document is the canonical reference for all design and architecture decisions.
Update it as decisions change. Every Claude Code session should read this first.

---

## Project Overview

A season-based strategy game where the player grows a 2D tree on a hex grid. The goal
is to maximize reproduction (viable seeds) over the tree's lifetime. The tree lives in
a simulated environment with weather, soil moisture, sunlight, and structural physics.
The player places cells during a planning phase, then advances the season to watch the
simulation play out. The game starts calm and gradually introduces new threats.

**The core annual rhythm** (this is the heart of the game's fun — protect it):
- **Spring**: plant flowers, grow new branches and leaves, recover from winter
- **Summer**: maximum photosynthesis, but water stress; fruit is maturing and thirsty
- **Fall**: harvest seeds (score!), shed leaves to recover energy before frost
- **Winter**: survive on reserves; prune and restructure (the only safe winter actions)

**Target platforms**: Desktop browser and mobile (touch). All interaction via click/tap.

---

## Tech Stack

- **Language**: TypeScript (strict mode)
- **Bundler**: Vite
- **UI framework**: React — only for HUD/menus surrounding the game canvas
- **Rendering**: HTML5 Canvas API directly — no Phaser, no PixiJS
- **State**: Plain TypeScript objects; no Redux or Zustand
- **Persistence**: localStorage (JSON serialization of sparse cell map)
- **Testing**: Vitest for simulation logic (pure functions, no DOM)
- **Styling**: CSS modules or plain CSS; no Tailwind

**Key architectural rule**: The simulation must be completely decoupled from rendering.
`simulate(gameState, rng): GameState` is a pure function. The Canvas renderer reads
state and draws it; it never mutates state. Pass a seeded RNG into the simulation so
runs are reproducible for debugging.

---

## Repository Structure (target)

```
/src
  /sim          # Pure simulation logic — no DOM dependencies
    cells.ts    # Cell types, constants, helpers
    grid.ts     # Hex grid data structure and neighbor queries
    light.ts    # Light/shadow calculation
    water.ts    # Water diffusion and soil moisture
    energy.ts   # Energy diffusion and photosynthesis
    health.ts   # Health update, rot spread
    structure.ts # Support graph, load/stress calculation
    weather.ts  # Weather generation and season advancement
    simulate.ts # Top-level simulate() function
  /render       # Canvas rendering
    renderer.ts # Main draw loop
    camera.ts   # Pan/zoom/viewport math
    colors.ts   # Cell color mapping
  /ui           # React components (HUD only)
    HUD.tsx
    Inspector.tsx
    GoalTracker.tsx
    SeasonSummary.tsx
    Memorial.tsx
  /game         # Game loop, input handling, planning phase
    input.ts
    planning.ts
    game.ts
  main.tsx      # Entry point
```

---

## Hex Grid

### Orientation
**Pointy-top hexagons** with **axial coordinates (q, r)**.
Never use offset coordinates — neighbor math is painful. Use axial throughout.

Six neighbors of (q, r) in pointy-top axial:
```
(q+1, r), (q-1, r), (q, r+1), (q, r-1), (q+1, r-1), (q-1, r+1)
```

### Storage
Sparse map: `Map<string, Cell>` where key is `"${q},${r}"`. Only cells that exist
are stored. The grid is conceptually infinite; the terrain generator produces soil/rock
cells lazily as the player explores near them.

### Coordinate convention
- **+r = downward** (roots grow in +r direction)
- **-r = upward** (branches and trunk grow in -r direction)
- **±q = left/right**
- Ground surface is near r = 0 (bumpy ±2–3 cells); above ground is air, below is soil/rock
- For "horizontal distance" calculations, use pixel-space x: `x = q + r/2`

### Rendering
Default cell radius: 14px at 1× zoom. Cells are drawn as filled hexagons with a 1px
gap between them. The Canvas viewport supports pan and zoom; on new growth, gently
drift to keep the tree in frame unless the player has manually panned recently.

---

## Cell Model

### Cell types
All woody cells — trunk, branch, twig, root, root tip — share one type: `'tree'`.
Their appearance and behavior are emergent from position, connectivity, and clustering,
not from a named subtype. A tree cell below the ground surface behaves as a root
(absorbs water from adjacent soil); above ground it behaves as wood.

| Type | Description |
|------|-------------|
| `'tree'` | Any living woody cell (trunk, branch, root — identical in data) |
| `'leaf'` | Leaf cluster; photosynthesizes, transpires, terminal (nothing grows from it) |
| `'flower'` | Flower bud; spring only; terminal; becomes fruit if sustained |
| `'fruit'` | Maturing fruit; terminal; +1 seed score if it survives to ripeness |
| `'deadwood'` | Dead woody cell; still structural, minor capillary water flow |
| `'soil'` | Underground non-tree cell; holds moisture |
| `'rock'` | Impenetrable; roots cannot pass through; no water flow |
| (absent) | Air — empty above-ground cells are simply not stored |

**Terminal cells**: leaves, flowers, and fruit are terminal — no cell may be placed
attached only to them. New growth must attach to a `'tree'` cell (staged or real).

### Cell data structure
```typescript
interface Cell {
  q: number;
  r: number;
  type: CellType;
  water: number;       // units, 0 to waterCapacity
  energy: number;      // units, 0 to energyCapacity
  health: number;      // 0.0–1.0
  rot: number;         // 0.0–1.0; 0 for most cells
  age: number;         // seasons alive
  staged?: boolean;    // true during planning phase only
}
```

**Units convention**: water and energy are stored in absolute units (not proportions).
Health and rot are 0–1 proportions. Be consistent everywhere.

### Capacities and flow limits (per cell)
- Water capacity: **10 units** (tree/leaf/flower/fruit); **20 units** (soil)
- Energy capacity: **10 units** (tree/leaf/flower/fruit); soil holds no energy
- **Total inflow cap: 2 units/tick. Total outflow cap: 2 units/tick** (each, for water
  and energy separately). This cap is on the *sum across all neighbors*, and it is the
  entire reason trunk width matters: a 1-cell-wide trunk moves at most 2 units/tick
  upward; a 3-cell-wide trunk moves up to 6. Do not weaken this cap.
- Deadwood: water flow capped at **0.3 units/tick** total (capillary action only);
  no energy flow; no metabolism.

### Energy storage between seasons
The tree's banked energy = sum of energy across all living cells. Maximum storage is
therefore emergent: `living_cell_count × 10`. A bigger tree banks more reserves. Energy
generated beyond what the tree can hold is lost — a deliberate pressure to either grow
or flower rather than hoard.

---

## Simulation

### Tick structure
One season = **60 simulation ticks**, played back at ~12 ticks/sec (≈5 seconds of
animation, skippable). Each tick, in order:

1. **Light pass** — compute light exposure for every above-ground cell
2. **Photosynthesis** — leaf cells generate energy from light
3. **Transpiration & metabolism** — all living cells consume water and energy
4. **Root absorption** — underground tree cells absorb water from adjacent soil
5. **Water diffusion** — one diffusion pass across all connected cells
6. **Energy diffusion** — one diffusion pass across tree/leaf/flower/fruit cells
7. **Health update** — cells with sustained shortage lose health; surplus recovers it
8. **Rot spread** — rot advances probabilistically into adjacent living cells
9. **Soil update** — rain deposition, percolation, evaporation, water table regen
10. **Event check** — storms, frost (only on designated event ticks)

### Light calculation
- Sun rays are cast **per column** (per unique pixel-space x) from the top down
- Ray angle (from vertical) varies by season:
  - Spring: 20°, Summer: 5°, Fall: 20°, Winter: 40°
- Each tree/leaf/flower/fruit cell in a ray's path absorbs 35% of the remaining light
- A leaf cell generates energy = `remaining_light × season_intensity × 0.12` per tick
- Season light intensity multipliers: Spring 0.7, Summer 1.0, Fall 0.5, Winter 0.1
- Cloud cover during rain events: all light × 0.4 for the event's duration

Practical effect: dense canopies self-shade; wide flat canopies outperform tall narrow
ones in summer; the low winter sun makes everything nearly dormant.

### Water diffusion
For every pair of adjacent cells that can exchange water:
- `flow = (a.water - b.water) × 0.15`, from higher to lower
- Clamped by the sender's remaining outflow budget, the receiver's remaining inflow
  budget, and the receiver's remaining capacity
- Applies between: soil↔soil, soil↔tree (below ground), tree↔tree, tree↔leaf/flower/fruit
- Transpiration (leaves consuming water) lowers leaf water, which steepens the gradient
  and pulls water up the tree — suction is emergent, no special-case code needed

### Root absorption
Any underground `'tree'` cell adjacent to soil absorbs water from each adjacent soil
cell at `soil.water × 0.05` per tick (subject to the cell's inflow cap). More adjacent
soil = faster absorption, so thin exploratory root tendrils with lots of soil contact
absorb well, and root tips are emergent rather than a special type.

### Energy diffusion
Same formula and caps as water. Flows only among tree, leaf, flower, and fruit cells.

### Metabolic consumption per tick
| Type | Water | Energy |
|------|-------|--------|
| Tree | 0.05 | 0.015 |
| Leaf | 0.10 (transpiration) | 0.02 |
| Flower | 0.15 | 0.10 |
| Fruit | 0.20 | 0.05 |
| Deadwood | 0 | 0 |

Heat wave: leaf and fruit water consumption × 1.8.
Winter: all consumption × 0.35 (dormancy), but photosynthesis is near zero too.

**M6 balance note**: tree (wood) energy upkeep was lowered from 0.03 to **0.015**, and
winter dormancy deepened from ×0.5 to **×0.35**. At 0.03/×0.5 a small deciduous tree
could not bank enough over summer to survive the fall+winter valley *and* re-leaf in
spring — it collapsed to a permanent 0-energy "zombie" (alive but unable to ever
afford a leaf again). Lower wood upkeep means structure is cheap to maintain and a
healthy canopy yields a growing surplus year over year (guarded by `recovery.test.ts`).

### Health update
Each tick, a cell's health moves toward a target at rate 0.01/tick:
- Target 1.0 if water > 3 AND energy > 2
- Target 0.5 if exactly one of those holds
- Target 0.0 if neither holds
A cell whose health reaches 0 becomes `'deadwood'` (leaves/flowers/fruit instead
simply drop — removed from the map). Slow decline and slow recovery are intentional:
the player should see trouble coming and have time to react, and death should feel
like a slow drama, not a popped balloon.

### Rot
- Each rotted cell (rot > 0) spreads to each adjacent living cell at probability
  0.02/tick (×2 if the target cell's water > 7, ×0.3 if water < 2)
- A cell's rot grows 0.02/tick once infected; at rot = 1.0 the cell becomes deadwood
- Rot is introduced as a threat starting Year 4 (see difficulty curve): a random
  deadwood or storm-wounded cell becomes the infection site
- Deadwood with no living neighbors for 5 consecutive seasons crumbles (removed)
- Counterplay is pruning (below): catch it early and it's free; wait and it costs limbs

---

## Soil and Terrain

### Ground surface
Surface height varies gently: ±2–3 cells of smooth noise across the map, constant for
the whole run. The seed spawns at the center surface.

### Soil depth and rocks
- Soil extends 28–32 cells below the surface (randomized per run), then solid bedrock
- Rock density by depth: 5–15 deep ≈ 10%, 15–25 deep ≈ 25%, below 25 ≈ 60%
- Rocks are scattered individual cells (occasionally small clumps), generated lazily

### Soil moisture
- Each soil cell holds 0–20 units of water
- Rain events deposit water into the top 3–4 soil rows (M6: **0.3 units/tick to the
  top 4 rows** on each rain tick — see `RAIN_DEPOSIT` in `simulate.ts`)
- Moisture diffuses (the standard water diffusion above) — downward percolation is
  emergent from rain landing on top; add a slight downward bias (+0.02) if needed
- Evaporation from the top 2 soil rows: 0.05/tick in summer, 0.01/tick otherwise
  (×1.5 during a drought)
- **Water table**: soil cells at depth ≥ 18 regenerate 0.1 water/tick passively.
  Deep roots are always rewarded — this is the payoff for navigating the rocks.
- Starting soil moisture: ~8 units average, slightly higher near the spawn point

---

## Structural Integrity

### Support graph
Hex-grid trees can contain loops, so "subtree" is not well-defined by shape alone.
Define support explicitly:
- Run BFS from all underground tree cells (the root system) through living + deadwood
  tree cells. Each above-ground cell's **support parent** = its neighbor with the
  smallest BFS distance to ground (ties: prefer the neighbor more directly below).
- `load(cell)` = 1 + sum of loads of all cells whose support parent is this cell,
  plus `lateral_offset² × 0.3`, where lateral_offset = horizontal (pixel-space x)
  distance from the cell to the point where its support path meets the ground.
  The squared term punishes long horizontal branches — as it should.

### Strength and stress
- `strength(cell)` = number of tree/deadwood cells within graph distance 2 at the same
  row (r) — i.e., local cross-section width — × 3
- `stress(cell) = load(cell) / strength(cell)`
- Cells with stress > 0.8 get a subtle red tint at all times (early warning, and a
  live preview during planning so the player sees consequences before confirming)

### Storms and breaking
- Storm thresholds: minor 1.2, moderate 0.9, severe 0.6
- During a storm tick, every cell with stress above the threshold has a 50% chance
  to snap (so identical trees don't always fail identically)
- When a cell snaps: remove it, then remove every cell no longer connected to the
  root system. The fallen wood is gone — it's on the ground now, not part of the tree.
- The playback pauses for a beat and highlights the break ("A storm snapped your
  east branch — 14 cells lost")

---

## Weather System

### Seasons
| Season | Sun angle | Intensity | Rain | Storm chance |
|--------|-----------|-----------|------|--------------|
| Spring | 20° | 0.7 | Medium | Medium |
| Summer | 5° | 1.0 | Low | Low |
| Fall | 20° | 0.5 | Medium | Medium |
| Winter | 40° | 0.1 | Low | Low |

### Weather events within a season
- **Rain event**: 8–15 ticks; deposits soil moisture; clouds reduce light during it
- **Drought**: a season (or two consecutive) with rain probability near zero and
  evaporation × 1.5; always visible in the forecast at least one season ahead
- **Heat wave**: a summer modifier; transpiration × 1.8
- **Storm**: a 1–2 tick event; structural failure check (see above)
- **Frost**: see frost rules below — this is a core mechanic, not a footnote

### Frost and the deciduous cycle (core mechanic)
- **At winter onset (first tick of winter), every leaf cell on the tree dies and
  drops** (removed from map). A leaf you never shed still resorbs **30% of its stored
  energy** back into the adjacent tree cells (`LEAF_FROST_RESORB`); the rest is wasted.
- **Shedding leaves during fall planning resorbs 75% of each leaf's stored energy**
  back into the tree (`LEAF_SHED_RESORB`, nutrient resorption — what real deciduous
  trees do). Resorption is **proportional to the leaf's actual energy**, not a flat
  amount — this makes the canopy a genuinely *recoverable* energy store, so a tree can
  re-leaf in spring instead of starving.
- **Shed timing (critical):** a marked leaf is **not** removed when the season is
  advanced. It photosynthesizes through the entire season and only drops at *season
  end* (`resolveShedding` in `simulate.ts`, run after the last tick, before aging),
  resorbing its end-of-season energy. Marking is therefore **budget-neutral during
  planning** — the energy returns in *next* season's budget, not the current one.
  Earlier the shed happened at advance, *before* the season ran, which forfeited fall's
  photosynthesis and starved the tree to a permanent 0-energy dead end even though the
  in-game milestone tells you to shed. Both "shed in fall" and "keep leaves, let winter
  frost take them at 30%" are now viable, with fall-shedding the better play. Guarded by
  `recovery.test.ts` (both strategies grow their winter reserves year over year).
- **Spring frost** (possible in early years' forecasts, more common later): kills all
  cells placed in the immediately preceding planning phase. The forecast warns of
  frost risk; planting early in a frost-risk spring is a gamble.
- **Winter growth**: any cell staged during winter planning dies at the first frost
  tick. The UI warns loudly. Winter planning exists mainly for pruning and reshaping.

### Forecasting
- **This season**: exact conditions
- **Next season**: reliable general forecast ("dry", "storms likely", "frost risk")
- **Two seasons out**: vague trend ("warming", "unsettled")
- Beyond: unknown. Droughts and severe storms always appear in the next-season
  forecast — surprise catastrophes are frustrating; forecasted ones are gameplay.

**Implementation (M6)**: weather is fully deterministic from a per-run `worldSeed`
(stored on `GameState`, stable for the whole run) mixed with `(year, season)` —
see `sim/weather.ts` `generateWeather()`. Because the forecast simply calls the same
function for upcoming seasons, the forecast is guaranteed to match what is later
simulated, and reloading never rerolls the future. The simulation's stochastic RNG
(`rngSeed`) is independent of weather generation. The season being simulated is the
one the player *planned* (the pre-advance season), carried into `simulateSeason` via
the `SeasonWeather` object — `applySeasonAdvance` rolls the displayed label forward,
but the sim reads season behaviour from the weather, not the label. Drought chance
from Year 4 is **0.18** (never in winter). Spring frost is forecast-modelled (winter
always reads "frost risk") but its cell-kill is deferred past M6; winter-onset leaf
kill and winter-growth (age-0) frost death are implemented.

### Difficulty curve
- **Year 1**: gentle. Good rain, no storms, no rot, no pests. Winter 1 still requires
  the leaf-shed lesson and surviving on reserves.
- **Year 2**: storms enabled (minor/moderate).
- **Year 4**: droughts possible; rot introduced.
- **Year 6**: heat waves; leaf pests (a patch of leaves loses photosynthesis
  efficiency and spreads leaf-to-leaf; counterplay is shedding affected leaves).
- **Year 9+**: severe storms; longer droughts; multiple simultaneous threats.
  Difficulty keeps scaling indefinitely — old age should be genuinely hard, and the
  question "how long can this tree keep producing seeds?" is the late game.

---

## Planning Phase

### Energy budget
- Planning budget = the tree's total banked energy (sum across living cells)
- Costs: tree cell **1**, leaf cell **1**, flower **3**
- New cells enter the world with water 2 and energy 1 (included in the cost)
- When the season advances, total cost is deducted from cells proportionally

### Staging
- Tap an empty cell adjacent to any tree cell (staged or real) to stage growth there —
  chaining staged cells to extend a branch several cells in one phase is allowed
- Above the surface: stages a tree cell (Branch mode) or leaf (Leaf mode)
- Below the surface in soil: stages a tree cell (root); soil cell is consumed
- In rock: rejected with a brief shake/feedback
- Leaves, flowers, and fruit are terminal: nothing can attach to them
- Staged cells render at 50% opacity with a **dashed white outline drawn around the
  perimeter of each contiguous staged group** (no dividers between adjacent staged cells)
- Tap a staged cell to unstage it (energy refunded immediately). If that disconnects
  other staged cells from the tree, they unstage automatically with refunds.
- Tap a live leaf to mark it for shedding (shed icon overlay); tap again to cancel.
  Shedding resolves at season advance and refunds 0.5 energy per leaf.

### Modes
A small mode toggle in the HUD: **Branch / Leaf / Flower**. Flower mode appears only
in spring planning phases, and only after the "Reach 30 cells" milestone.

### Flower placement rules
- Spring planning only
- Must attach to a tree cell with no tree neighbor above it (a branch tip)
- Adjacent cells must have health > 0.6 — sickly wood can't support blooms

### Advancing the season
- "Advance Season" button confirms all staged actions and runs the simulation
- Disabled (with explanatory tooltip) if the staged configuration is invalid
- During the first 4 years, if >30% of the energy budget is unspent, show a gentle
  one-line nudge — except before winter, when hoarding is exactly right
- After playback, show a **season summary**: events that occurred, energy generated,
  water status, cells lost/gained, goal progress. Tap to dismiss.

---

## Pruning

- Available during the planning phase only
- Tap any existing (non-staged) cell to open the **inspector** (bottom sheet on
  mobile, floating panel on desktop): type, water, energy, health, rot, age, stress
- "Prune" button in the inspector:
  - Healthy cell (health ≥ 0.3): costs **2 energy** (wound sealing)
  - Dying cell (health < 0.3), deadwood, or rotted: **free**
- Pruning removes the cell and every cell that loses its connection to the root
  system as a result — the inspector shows a count and highlights the doomed region
  before you confirm ("Prune — 9 cells will be removed")
- Pruning that would isolate the entire canopy from the roots gets an extra
  confirmation step
- Winter is mechanically the ideal pruning season (nothing else useful to do, and
  reshaping before spring growth) — let players discover this rather than telling them

---

## Cell Rendering — Color Map

Cell color encodes health and type at a glance:

| State | Color |
|-------|-------|
| Healthy tree cell (above ground) | Warm brown `#7B5230` |
| Healthy tree cell (root) | Deep brown `#5C3A1A` |
| Healthy leaf | Fresh green `#4CAF50` |
| Water-stressed leaf | Yellow-green `#A8C060` |
| Energy-stressed leaf | Dark dull green `#2D6E2D` |
| Unhealthy tree cell | Desaturates toward gray as health falls |
| Deadwood | Gray-brown `#8B7355` |
| Rotted | Dark gray `#5A5A5A`, mottled |
| Flower | Pale pink `#FFAAB0` |
| Fruit | Orange-red `#E8703A` |
| Soil | Tan `#C4A46B`, darkening with moisture |
| Rock | Dark gray `#6B6B6B` |

Stress > 0.8: subtle red tint overlay. Inspected cell: white outline.
Staged cells: 50% opacity + dashed group outline.

---

## UI / HUD

React chrome over a full-viewport Canvas.

### Always visible
- Season + year ("Spring, Year 3") and month-range subtitle ("Mar–May")
- This season's weather (icons) and next season's forecast (greyed, labeled)
- Energy available ("⚡ 47")
- Current goal + progress
- Seed score ("🌰 4")
- Mode toggle (Branch / Leaf / Flower) and Advance Season button

### On demand
- Cell inspector (tap a cell)
- Goal log: slide-out panel of completed milestones with short evocative entries
  ("Your tree survived its first winter") — never raw system text
- Minimap: corner overview with viewport rectangle; appears once the tree exceeds
  ~1.5× the viewport

---

## Goals, Score, and the End of a Tree

### Score
Lifetime viable seeds produced. Continuous, always visible, the thing players try
to beat next run.

### Milestones (revealed one at a time)
1. Grow your first leaf
2. Survive your first season
3. Grow 10 cells
4. Shed your leaves before winter
5. Survive your first winter
6. Reach 30 cells (unlocks Flower mode)
7. Grow your first flower
8. Mature your first fruit — your first seed!
9. Tap the deep water table (root at depth ≥ 18)
10. Survive a drought
11. Survive a storm without losing a single cell
12. Produce 5 seeds in one year
13. Reach 100 cells
14. Recover from rot without losing a major branch
15. Produce 25 lifetime seeds
... keep generating; milestones never run out

### Death and the Memorial
When the last living cell dies, the run ends with a **Memorial screen**: the tree's
final silhouette, its age in years, peak size, lifetime seeds, milestones earned, and
its cause of death in plain words ("Died in the drought of Year 12, age 11, having
raised 17 seeds"). One button: "Plant a new seed." Death is an ending, not a failure
state — the memorial should feel like a eulogy, not a game-over screen.

---

## Flowers, Fruit, and the Annual Reproductive Cycle

This yearly arc is the strategic core of the mid/late game:

1. **Spring**: player places flower buds (3 energy each) on healthy branch tips.
   Each flower consumes water and energy all spring. Weak trees can't afford many.
2. **Spring→Summer transition**: each surviving flower with health > 0.5 becomes fruit
   automatically (pollination is automatic).
3. **Summer**: fruit consumes 0.2 water/tick — right when water is scarcest. A fruit
   whose cell drops below water 1 for 10 consecutive ticks **aborts** (drops, no seed).
   Overplanting flowers in spring and losing the fruit in a dry summer is the central
   lesson of the mid-game.
4. **Fall onset**: every surviving fruit ripens — **+1 seed each** — then drops.

The player's yearly question: *how many fruit can my roots actually carry through
August?* Everything else in the game — root depth, trunk width, canopy size, energy
reserves — feeds into that answer.

---

## Starting State

1. Player sees the terrain (bumpy surface, soil, a few visible shallow rocks)
2. A single seed cell sits at the center surface, half-buried: type `'tree'`,
   water 5, energy 8, health 1.0
3. First planning phase, early **Spring, Year 1**: enough energy for a few cells.
   The natural first moves — a leaf above, a root below — teach the whole game.
4. Light hint overlay for the first 2–3 seasons; dismissible; never shown again

---

## Save / Load

- Auto-save to localStorage after every season advance
- Serialize: `{ cells: Cell[], season, year, rngSeed, worldSeed, goals, score }`
  (M7: `sim/save.ts`, key `treegame.save.v1`)
- Persist the RNG seed and state so reloading doesn't reroll the future
- **Terrain and weather are NOT serialized** — both are pure deterministic functions
  (terrain of (q,r); weather of (worldSeed, year, season)), and any soil the sim
  modified is promoted into `cells`. Persisting `worldSeed` is enough to replay the
  future identically, so there's no `weatherState` blob.
- One save slot; the Memorial clears it (Memorial itself is M10)
- Also keep a tiny persistent "hall of memorials" record (best score, longest life)
  across runs — cheap to store, gives returning players a reason to beat themselves
  (deferred to M10 with the Memorial)

**M7 implementation notes**
- Inspector (`ui/Inspector.tsx`) shows type, water, energy, health, rot, age plus a
  plain-language status line ("Water-stressed", "Low on energy", "Thriving", …) so the
  color map is legible. **Stress is intentionally absent until M8** adds the support graph.
- Pruning (`game/prune.ts`) applies immediately to the game state; the wound-sealing
  cost is accrued on `PlanningState.pruneCostAccrued` and deducted at season advance.
  Removal set = the cell plus everything that loses root-connectivity (BFS through
  wood); a whole-canopy sever requires a second confirm.
- Goals (`game/goals.ts`) reveal one at a time (lowest-index incomplete is the current
  objective); completion is checked after each season advance and surfaced in the
  season summary + goal log. Flower/fruit milestones (7–8) can't complete until M10.

---

## Decisions Deferred (do not implement yet)

- Multiple soil types (clay, sand, loam)
- Rain runoff across bumpy terrain
- Day/night cycles
- Multiplayer / shared tree gallery
- Seed inheritance / meta-progression between runs (beyond the hall of memorials)
- Wind direction affecting storm damage asymmetrically
- Bark beetles (structural pest) — design exists, build leaf pests first
- Fire / wildfire events
- Sound design

---

## MVP Build Order

Build in sequence; don't advance until the current milestone works and feels good.

### Milestone 1 — Hex grid foundation
- Vite + TypeScript + React setup
- Canvas, pointy-top hex rendering, axial coordinates
- Smooth pan (drag) and zoom (pinch/scroll)
- Tap a cell → log (q, r); verify coordinate math with a colored test pattern

### Milestone 2 — Terrain and camera
- Procedural terrain: bumpy surface, soil, rocks scaling with depth, lazy generation
- Camera centered on spawn; soil moisture rendered as color variation

### Milestone 3 — Placement and planning
- Seed cell at spawn
- Stage/unstage cells with energy counter; Branch/Leaf toggle; chained staging
- Group dashed outlines for staged regions
- Advance Season button (just commits staged cells, no sim yet)

### Milestone 4 — Water simulation
- Root absorption, water diffusion with in/out caps, metabolism (water only)
- Soil percolation, evaporation, water table
- 60-tick playback animation, skippable

### Milestone 5 — Energy, light, and health
- Per-column light with seasonal sun angle; photosynthesis
- Energy diffusion; full metabolism; health update; deadwood conversion
- Leaf transpiration pulling water upward (verify the suction gradient works)

### Milestone 6 — Seasons, weather, frost
- Four-season cycle, rain events, forecast HUD
- Winter-onset leaf kill + fall shedding with energy refund
- Season summary screen

### Milestone 7 — Goals, inspector, pruning, saves
- Cell inspector; pruning with connectivity-aware removal preview
- First 8 milestones; goal log
- Save/load with RNG state; unspent-energy nudge

### Milestone 8 — Structure and storms
- Support graph, load/stress, live stress tint (including during planning)
- Storm events with probabilistic breaking and playback highlight
- Storms enabled from Year 2

### Milestone 9 — Rot
- Infection sites, spread, free pruning of dead/dying cells, deadwood crumbling

### Milestone 10 — Flowers, fruit, score, memorial
- Flower mode (spring only), fruit maturation and abort logic
- Seed score; Memorial screen; hall of memorials

---

## Notes for Claude Code

- Small, focused functions. Each simulation step (light, water, energy, health, rot,
  soil) is its own pure function called by `simulate()` — each independently testable.
- Vitest tests required for at minimum: neighbor math, water diffusion (3-cell case),
  flow caps actually limiting throughput through a 1-wide vs 2-wide trunk, light
  occlusion, support-graph load, and connectivity removal after a break/prune.
- No `Date.now()` or bare `Math.random()` inside `/sim` — seeded RNG passed in.
- Canvas at 60fps during playback, idle-cheap during planning (render on change).
- No `<form>` elements in React — button onClick handlers only.
- Top-level game component owns state; pass down via props.
- Balance numbers in this file are starting points, not gospel — tune freely, but
  record any changed constants back into this document.
