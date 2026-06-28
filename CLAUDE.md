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

| Type                | Description                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'tree'`            | Any living woody cell (trunk, branch, root — identical in data)                                                                                                                                               |
| `'leaf'`            | Leaf cluster; photosynthesizes, transpires, terminal (nothing grows from it)                                                                                                                                  |
| `'flower'`          | Flower bud; spring only; terminal; becomes fruit if sustained                                                                                                                                                 |
| `'fruit'`           | Maturing fruit; terminal; +1 seed score if it survives to ripeness                                                                                                                                            |
| `'deadwood'`        | Dead woody cell; still structural, minor capillary water flow                                                                                                                                                 |
| `'reinforced wood'` | Stronger wood (½ moment/stress) but higher water upkeep and no leaves/flowers. Placeable via "Reinforce" mode (2⚡) once the 30-cell milestone unlocks.                                                       |
| `'soil'`            | Underground non-tree cell; holds moisture                                                                                                                                                                     |
| `'rock'`            | Impenetrable; roots cannot pass through; no water flow                                                                                                                                                        |
| `'ground water'`    | Rare deep **infinite** water pocket (`GROUND_WATER_CAP = 200` sentinel); a root beside one drinks to cap each tick without depleting it. A navigation reward — see "Soil depth and rocks" and "Ground water". |
| (absent)            | Air — empty above-ground cells are simply not stored                                                                                                                                                          |

**Terminal cells**: leaves, flowers, and fruit are terminal — no cell may be placed
attached only to them. New growth must attach to a `'tree'` cell (staged or real).

### Cell data structure

```typescript
interface Cell {
  q: number;
  r: number;
  type: CellType;
  water: number; // units, 0 to waterCapacity
  energy: number; // units, 0 to energyCapacity
  health: number; // 0.0–1.0
  rot: number; // 0.0–1.0; 0 for most cells
  age: number; // seasons alive
  maturity?: number; // fruit only: 0.0–1.0 ripeness; ≥1.0 ripens to a seed, ≤0 aborts
  staged?: boolean; // true during planning phase only
}
```

**Units convention**: water and energy are stored in absolute units (not proportions).
Health and rot are 0–1 proportions. Be consistent everywhere.

### Capacities and flow limits (per cell)

- Water capacity: **10 units** (tree/leaf/flower/fruit); **20 units** (soil)
- Energy capacity: **10 units** (tree/leaf/flower/fruit); soil holds no energy
- **Total inflow cap: 2 units/tick. Total outflow cap: 2 units/tick** (each, for water
  and energy separately). This cap is on the _sum across all neighbors_, and it is the
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
animation, skippable).

**Half-season checkpoints (M11).** A season is simulated in **two 30-tick halves** with a
planning checkpoint between them (`GameState.seasonHalf`: 0 = before the first half, 1 = the
mid-season checkpoint). This lets the player make **smaller batches of changes with less
drastic change between them** — 8 planning phases/year instead of 4 — without disturbing the
four-season rhythm: weather, frost, fruit-set, and harvest all stay anchored to season
boundaries. The season-onset events (tick 0, below) fire in part 0; the end-of-season
resolution (autumn drop / fruit set / aging) fires after part 1. Part 1 also re-runs
`growAutoLeaves` as a top-up so wood placed at the checkpoint leafs out immediately. `seasonHalf`
is serialized, so a mid-season save resumes correctly; each half draws an **independent RNG
stream** from the same persisted `rngSeed` (part 1 mixes in a salt) so a mid-season reload
replays identically, and the season→season seed chain is unchanged from the pre-M11 single
advance. `runSeasonPart(state, rng, weather, part)` runs one half; `runSeason` (full 60 ticks)
is kept for the sim tests and the headless harness. `applyPlanCommit` commits a plan without
advancing the season label (used by part 0 and by `applySeasonAdvance`, which then rolls the
label forward and resets the half). **Balance note:** photosynthesis refills energy between the
halves, so a tree gets more growth opportunities per year (mild easing); biology per tick is
unchanged. The headless harness still drives full seasons, so re-validate balance in-game.

At **tick 0** of a season, season-boundary events fire first (in this order): winter frost
(`winterFrost`), fall fruit harvest (`ripenFruit`), then — for spring/summer/fall — the
canopy auto-grows (`growAutoLeaves`; see "Auto-leaves"). Then each tick, in order:

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
- A leaf cell generates energy = `remaining_light × season_intensity × PHOTO_COEFF ×
heightLightFactor` per tick. **`PHOTO_COEFF` was retuned 0.12 → 0.24** (M9 playtest): at
  0.12 a leaf shaded even modestly (most of a canopy self-shades at 35% absorption/cell)
  netted barely above its 0.02 upkeep, so a normal tree never banked the surplus that
  flowering needs and every run collapsed to a 0-energy, health-0.5 "zombie."
- **Height-light factor (the reason to grow tall).** A leaf's light is scaled by its height
  above the surface: `LIGHT_GROUND_FACTOR` (**0.22**) at ground level, ramping to 1.0 by
  `LIGHT_FULL_HEIGHT` (10) cells up. Without it, sprawling a flat mat along the surface (no
  self-shading — side-by-side leaves are in different sun-columns — every leaf in full sun,
  short water paths) was a _dominant degenerate strategy_: the harness `groundCrawler`
  scored ~4× a normal tree and never died. The height factor converts that into the
  intended core trade-off — grow tall for light, but then you need trunk WIDTH to water the
  lifted canopy (the conduction cap). `LIGHT_GROUND_FACTOR` is calibrated against the harness
  jointly with wood upkeep: too high revives the ground-crawler; too low stalls a small tree's
  recovery snowball (`cli/recover.ts`). **Retuned 0.40 → 0.22 in M9 Round 3** when wood upkeep
  dropped to 0.005 (cheap wood made the flat sprawl viable again, so the light penalty had to
  firm up). At 0.22 a mid-height balanced canopy (height 5–7 → factor 0.6–0.76) is barely
  touched while only true ground-huggers (height 0–1) are punished — `groundCrawler` stays the
  worst strategy (harness: balanced ~17, tall/flower ~9, crawler ~6). See `sim/simulate.ts`.
- Season light intensity multipliers: Spring 0.7, Summer 1.0, Fall 0.5, Winter 0.1
- Cloud cover during rain events: all light × 0.4 for the event's duration

Practical effect: dense canopies self-shade; wide flat canopies outperform tall narrow
ones in summer; the low winter sun makes everything nearly dormant.

### Water diffusion

For every pair of adjacent cells that can exchange water:

- `flow = (a.water - b.water) × DIFFUSE_RATE`, from higher to lower. **`DIFFUSE_RATE` was
  retuned 0.15 → 0.5** (M9 playtest, applies to water AND energy): at 0.15 conduction was
  gradient-RESISTANCE-limited, so any tree taller than ~6 rows starved its own canopy no
  matter how wide the trunk — the 2-units/tick flow cap (which is what's supposed to make
  width matter) was never the actual limit. At 0.5 a link saturates the cap quickly, so
  trunk WIDTH governs throughput (as intended) while a tall trunk can still water its
  canopy. Quantified in `src/cli/experiments.ts`.
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

| Type     | Water                | Energy |
| -------- | -------------------- | ------ |
| Tree     | 0.05                 | 0.005  |
| Leaf     | 0.10 (transpiration) | 0.02   |
| Flower   | 0.15                 | 0.10   |
| Fruit    | 0.20                 | 0.05   |
| Deadwood | 0                    | 0      |

**Stomatal closure (M9 Round 4):** a water-stressed leaf/fruit throttles its transpiration —
`water consumption × stomataFactor(cell.water)`, where `stomataFactor` is 1 at water ≥
`STOMA_FULL` (2) and ramps to `STOMA_MIN` (0.15) as water → 0. As a canopy dries, its demand
falls with its supply, so it **stabilises at low-but-alive water under drought** instead of
transpiring itself to 0 and dropping. This gives a tall canopy a fighting chance in a dry
spell (before it, deep roots were _not_ an effective canopy-drought defence — the deep water
is consumed climbing the trunk and the water table itself depletes, so sustained drought
gutted the canopy with no counterplay). Truly extreme sustained drought (soil genuinely
empty) can still kill — counterplay is deep roots + not over-building height. `STOMA_FULL = 2`
so only genuinely dry cells throttle transpiration; a normal canopy (water 3–9) is untouched,
leaving fair-weather balance unchanged. Validated in `cli/water.ts` (drought canopy survival)
and the `play.ts`/`recover.ts` sweeps.

**Carbon–water coupling (M10 energy-economy fix):** photosynthesis is **also** scaled by the
leaf's own water — `gain × photoWaterFactor(cell.water)`, 1.0 at water ≥ `PHOTO_WATER_FULL`
(2.5), ramping to `PHOTO_WATER_MIN` (0.15) as water → 0. This makes the **water system**
(trunk width + roots, the conduction cap) the real ceiling on energy income: a canopy you
can't water can't print energy, so you **can't out-build your hydraulics**. (This reverses the
M9 Round 3 decision to keep carbon purely light-driven. That decision was made to protect
_manual_ recovering canopies that ran lowish on water; it's safe to couple now that the canopy
**auto-grows fresh and free each spring** — a small recovering tree's canopy sits near its
roots and stays well-watered, so coupling throttles only genuinely _over-extended_ canopies,
not recovery.) **Why it was needed:** with free auto-leaves, a purely light-driven canopy let
a bone-dry over-built tree (273 cells, leaf water ~0.3) still bank ~900 energy with nothing to
spend it on — energy stopped being scarce. Now over-building dries the canopy and craters its
own income (harness `cli/bigtree.ts`: an all-in builder's banked energy peaks ~230 and
collapses as it over-extends, instead of running away), while a disciplined grower stays
well-watered and unaffected. Validated against the full `play.ts` sweep (balance unchanged:
balanced ~21 wins, crawler dead) and `recover.ts` (snowball intact).

Heat wave: leaf and fruit water consumption × 1.8.
Winter: all consumption × 0.35 (dormancy), but photosynthesis is near zero too.

**M6 balance note**: tree (wood) energy upkeep was lowered from 0.03 to **0.015**, and
winter dormancy deepened from ×0.5 to **×0.35**. At 0.03/×0.5 a small deciduous tree
could not bank enough over summer to survive the fall+winter valley _and_ re-leaf in
spring — it collapsed to a permanent 0-energy "zombie" (alive but unable to ever
afford a leaf again). Lower wood upkeep means structure is cheap to maintain and a
healthy canopy yields a growing surplus year over year (guarded by `recovery.test.ts`).

**M9 Round 3 balance note**: tree (wood) energy upkeep lowered again, 0.015 → **0.005**.
This is safe _only because_ wood health no longer depends on energy (see "Health update")
— upkeep now taxes only banked energy, never survival. At 0.015 the fall valley (full
metabolism, canopy still up) drained a small tree's entire summer surplus every year, so a
pruned or recovering tree could _sustain_ a small canopy but never re-bank a fall-surviving
reserve to grow past it — a subsistence trap (alive, adding only the spring-vigor floor's
worth of cells per year, forever). At 0.005 a modest canopy banks a surplus that **snowballs**
— a brutally-pruned stump genuinely recovers (validated in `cli/recover.ts`: from-seed
minimal play sees the spring budget climb 8→12→18→29→49…). Structure is now genuinely cheap.
The lower upkeep made a ground-hugging sprawl cheap again, so it was re-paired with a firmer
`LIGHT_GROUND_FACTOR` (0.40 → 0.22) to keep the crawler suppressed — see Light calculation.

### Health update

Each tick, a cell's health moves toward a target at rate 0.01/tick. The target is
**type-aware** (M9 Round 3 fix):

- **Wood (`'tree'` — trunk AND roots): WATER-driven, and thirst NEVER kills it.** Target
  1.0 if water > 3 (`WOOD_WATER_OK`), else `WOOD_DRY_HEALTH` (**0.5**) — a dry floor, not 0.
  Wood dies **only** from rot, storms, or pruning; dry structural wood just idles dormant at
  half-health and re-greens when the canopy waters it again. Wood is mostly dead structural
  scaffolding with living water-conducting sapwood — it does **not** need energy to stay
  healthy. Energy is purely the growth/reproduction currency (the planning budget), free to
  pool in the canopy where photosynthesis makes it; a root at energy 0 in wet soil is
  perfectly healthy. **Why the dry-floor (post-M9 playtest fix):** the old rule decayed wood
  at `water ≤ 0.5` toward target 0.0 → deadwood. But a deciduous tree goes **bare every
  winter**, and with no canopy there is no transpiration to pull water up, so the upper
  structure of any sizeable tree inevitably dried to ~0 and the rule converted it to deadwood
  **every single year** — a _size-punishing_ death with no counterplay (taller tree = more
  upper wood shed each winter) and the source of the late-game "pile of dead wood to prune"
  chore. Real branches don't die over a normal dormant winter. Flooring at 0.5 keeps the real
  consequences (dry wood is visibly half-grey and can't anchor a flower, which needs > 0.6)
  while the canopy challenge still bites where it should — **leaves** still need water AND
  energy and still die. Validated in `cli/winter.ts` (a tall tree accrues 12–24 dry-wood
  cells per winter, deadwood stays 0) and the `cli/play.ts` strategy sweep (balance
  unchanged: balanced still beats tall/flower/crawler). **Why wood decoupled from energy in
  the first place (M9 Round 3):** previously every wood cell needed `energy > 2`,
  so energy made at the leaves (top) had to diffuse all the way DOWN to the roots — it never
  did, and every tree (any tall one especially) sat pinned at health ~0.5 with chronically
  energy-starved roots, a water-starved canopy, and a starved middle. Both unrealistic ("why
  does my structural trunk need sugar?") and not fun — players cut down perfectly recoverable
  trees because the whole thing looked sick. Decoupling wood health from energy fixes it and
  keeps the _good_ spatial challenge: getting WATER up to a lifted canopy (trunk width vs
  height).
- **Leaf / flower / fruit (metabolically active terminals): need BOTH.** Target 1.0 if
  water > 3 AND energy > 2, 0.5 if exactly one holds, 0.0 if neither. Preserves the real
  challenges: watering a lifted canopy, and feeding a fruit out on a far limb.
  A cell whose health reaches 0 becomes `'deadwood'` (leaves/flowers/fruit instead
  simply drop — removed from the map). Slow decline and slow recovery are intentional:
  the player should see trouble coming and have time to react, and death should feel
  like a slow drama, not a popped balloon. (Guarded by `updateHealth` tests for both the
  water-driven-wood and both-needed-leaf cases.)

### Rot

- Each rotted cell (rot > 0) spreads to each adjacent living cell at probability
  0.02/tick (×2 if the target cell's water > 7, ×0.3 if water < 2)
- A cell's rot grows 0.02/tick once infected; at rot = 1.0 the cell becomes deadwood
- Rot is introduced as a threat starting Year 4 (see difficulty curve): a random
  deadwood or storm-wounded cell becomes the infection site
- Deadwood with no living neighbors for 5 consecutive seasons crumbles (removed) — _the
  5-season linger is a rot-era refinement; see "Auto-clear deadwood" below for the
  currently-shipped immediate variant_
- Counterplay is pruning (below): catch it early and it's free; wait and it costs limbs

**Auto-clear deadwood (shipped QoL).** `crumbleDeadwood` (`sim/simulate.ts`) runs once at
season end (folded into the end-of-season resolution alongside autumn drop / fruit set /
aging): any deadwood cell with **no living neighbour** (no wood/leaf/flower/fruit beside it)
is a non-load-bearing dead stub and crumbles immediately. Deadwood touching a living cell
stays (it may be a branch base), so the common case strands nothing; removal goes through the
shared `applyBreakage` connectivity rule, so the rare case is handled correctly — a living
branch suspended _solely_ on a multi-cell dead bridge whose middle has only dead neighbours
falls when that middle crumbles, exactly as in a storm. This removes the late-game "pile of
deadwood to prune" chore (the M10 winter-wood fix already stopped manufacturing most of it;
deadwood stays rare until rot lands). It does **not** yet implement the 5-consecutive-seasons
linger above — for a QoL auto-clear, removing the stub promptly is the point. Guarded by
`simulate.test.ts` (`crumbleDeadwood`).

---

## Soil and Terrain

### Ground surface

Surface height varies gently: ±2–3 cells of smooth noise across the map, constant for
the whole run. The seed spawns at the center surface.

### Soil depth and rocks

- Soil extends 28–32 cells below the surface (randomized per run), then solid bedrock
- Rock density rises **smoothly with depth** via a logistic sigmoid (`rockProbability` in
  `sim/terrain.ts`): `ROCK_MAX / (1 + exp(-ROCK_STEEPNESS·(depth − ROCK_MID_DEPTH)))` with
  `ROCK_MAX = 0.45`, `ROCK_MID_DEPTH = 20`, `ROCK_STEEPNESS = 0.125`. Near the surface it's
  ~3–6%, ramping continuously to the 0.45 deep asymptote (depth 10 ≈ 0.10, 20 ≈ 0.22,
  30 ≈ 0.35). **This replaced the old step function** (0/0.1/0.25/0.35/0.45 by depth band),
  which playtesters found too abrupt ("rocks become overbearing around 20 feet" — the
  10%→25% jump at depth 15). The sigmoid was tuned so overall rock frequency is roughly
  unchanged (avg over a 0–32 soil column ≈ 0.18, matching the old bands) — only the gradient
  changed, so the player can always push a bit deeper before hitting an impenetrable wall.
- Rocks are scattered individual cells (occasionally small clumps), generated lazily
- **Ground water** (`'ground water'`): **very rare**, scattered, **infinite-supply** pockets
  deep in the rock — the high-value deep-root jackpot. Density (`groundWaterProbability` in
  `sim/terrain.ts`) is **0 above depth `GW_MIN_DEPTH` = 25**, then ramps up very gently and
  logistically (`GW_MAX = 0.015`, `GW_MID_DEPTH = 50`, `GW_STEEPNESS = 0.1`). `GW_MID_DEPTH`
  sits well below normal reach, so at realistic depths the curve is in its low tail and pockets
  stay a fraction of a percent: ~0.15% at depth 25–29, ~0.3% at 35–39, ~0.46% at 40–44 (only
  approaching the 1.5% asymptote at extreme depth). Finding one therefore demands a genuinely
  deep, wide root commitment (a 30-cell root mat at depth ~32 hits one ~7% of the time; ~19%
  with a 40-wide mat at depth 40, through heavy rock). Uses an **independent hash channel
  (seed 3)** so placement is uncorrelated with rock (seed 1) / soil moisture (seed 2). A root
  beside one drinks up to its inflow cap (2/tick) every tick forever without depleting the
  source (`absorbWater`), making that root zone drought-proof — see the `'ground water'` cell
  entry and "Ground water" under Shipped cell types. The deep water table below is the reliable
  **floor** (always rewards normal deep digging); ground water is the **jackpot** layered on
  top (the "jackpot + floor" model). The `tap-spring` milestone credits the first root grown
  beside one.

### Soil moisture

- Each soil cell holds 0–20 units of water
- Rain events deposit water into the top 3–4 soil rows (M6: **0.3 units/tick to the
  top 4 rows** on each rain tick — see `RAIN_DEPOSIT` in `simulate.ts`)
- Moisture diffuses (the standard water diffusion above) — downward percolation is
  emergent from rain landing on top; add a slight downward bias (+0.02) if needed
- Evaporation from the top 2 soil rows: 0.05/tick in summer, 0.01/tick otherwise
  (×1.5 during a drought)
- **Water table**: soil cells at depth ≥ 18 regenerate 0.1 water/tick passively (cap
  `SOIL_WATER_CAP` = 20). Deep roots are always rewarded — this is the reliable **floor**
  payoff for navigating the rocks (the rarer ground-water pockets are the jackpot on top).
  Restored to this design value once ground water shipped; it had been temporarily nerfed to
  0.01/tick + half-cap as a placeholder.
- Starting soil moisture: ~8 units average, slightly higher near the spawn point

---

## Structural Integrity

### Support graph

Hex-grid trees can contain loops, so "subtree" is not well-defined by shape alone.
Define support explicitly:

- Run BFS from all underground tree cells (the root system) through living + deadwood
  tree cells. Each above-ground cell's **support parent** = its neighbor with the
  smallest BFS distance to ground (ties: prefer the neighbor more directly below).

### Strength and stress (load-sharing bending model)

**History.** The original `load = 1 + lateral²·0.3` model was non-local and aggressive.
It was replaced by a single-support-**parent** model (`moment = |sumX − cnt·x|` routed down
one parent), which was local and balance-aware but had a **fatal distribution bug**: routing
all of a cell's load through ONE support parent meant a branch landing on the middle of a
thick trunk funnelled its entire load down a single column — that one cell lit up red while
its identical neighbours stayed cold ("some random cells under a lot more stress than their
neighbours"). The current model (`sim/structure.ts`) fixes this by **sharing load across all
parallel paths**, and adds a wind load case.

The tree is treated as a discrete truss; for each wood cell we integrate the internal
**bending moment** like a beam (`dM = V·ds`) for two independent load cases, then divide by
the local cross-section:

- **Gravity** (always): every cell has weight (`GRAVITY_WEIGHT`: wood 1, fruit 2.5,
  flower 0.5, leaf 0). A load stepping DOWN by `Δx` horizontally adds `Vg·Δx` to the moment
  — so a vertical run adds nothing (pure compression) and only a horizontal **cantilever**
  builds gravity moment (largest at the limb's attachment, ~0 at the tip). Moments are
  signed during accumulation, so opposed/​balanced branches cancel; a lone long branch does
  not.
- **Wind** (a fixed reference breeze, always on — see the M-series wind decision): every
  above-ground cell catches a horizontal force (`WIND_AREA`: wood 0.5, leaf 0.35, flower 0.4,
  fruit 0.6 — a **leafy crown is a sail**, so a tall canopy loads its trunk). A load stepping
  DOWN by `Δh` in height adds `Vw·Δh`. Wind pushes one way so these do NOT cancel: a tall
  trunk accrues a large overturning moment at its base regardless of balance. Direction-free
  in 2D (magnitude depends only on heights). This is the tall-skinny-tree case.
- **The distribution fix (two parts):** (1) load is pushed down split EQUALLY among every
  neighbour closer to ground (parallel paths share); (2) the accumulation runs one
  distance-layer at a time, and within each layer **`equalizeLayer` averages the accumulated
  shear+moment among connected same-distance cells** — a cross-section shares load as a rigid
  unit, so no edge cell with a single downward parent can hoard its neighbours' load. A
  1-wide member (cantilever, skinny trunk) is one cell per layer, so it is untouched.
- `strength(cell)` = same-row wood within graph distance 2 × 3 (horizontal cross-section =
  a vertical member's girth; min 3). A long branch's own cells read as "wide" and thus strong
  — correct, since branches don't snap mid-span; their moment is borne by the _narrow trunk
  at the junction_, where the red shows. Combined with load-sharing this gives ≈ beam theory's
  more-than-linear thickness benefit (a thick trunk goes evenly, gently stressed).
- `stress = (gravityMoment·MOMENT_W + windMoment·WIND_W + Vg·LOAD_W) / strength`, with
  `MOMENT_W = 0.2`, `WIND_W = 0.03`, `LOAD_W = 0.03` (the small axial term keeps a huge
  balanced canopy on a thin trunk from being totally storm-proof). Reinforced wood halves its
  stress. Calibrated against the storm thresholds (below) and `STRESS_WARN` so a normal
  balanced tree stays clear of the red line while long cantilevers and spindly tall trunks
  climb into storm-break range. See `structure.test.ts` and the `cli/structure.ts` harness
  (`npx tsx src/cli/structure.ts`): a height-12 1-wide trunk bases ≫ `STRESS_WARN`; the same
  height 5-wide is ~0.4 and even; a heavy branch on a thick trunk's middle spreads with no
  hot cell; a real grown tree's peak sits at the trunk base with no wild same-row outlier.
- This is still **local**: a cell's moment comes only from the wood above it, so thickening
  the trunk lower never changes an upper cell's stress.
- **Pixel-space caveat:** a constant-`q` stack leans left on screen (x = q + r/2), so it
  genuinely accrues gravity moment and reddens; a "visually straight up" zig-zag trunk stays
  near zero gravity moment (wind still loads it). The leaning trunk _looks_ leaning — honest,
  but worth knowing.
- Cells with stress > 0.8 (`STRESS_WARN`) get a subtle red tint at all times (early
  warning, and a live preview during planning over real + staged cells).

### Storms and breaking

- Storm thresholds: minor 1.2, moderate 0.9, severe 0.6
- During a storm tick, every cell with stress above the threshold has a 50% chance
  to snap (so identical trees don't always fail identically)
- When a cell snaps: remove it, then remove every cell no longer connected to the
  root system. The fallen wood is gone — it's on the ground now, not part of the tree.
- The playback pauses for a beat and highlights the break ("A storm snapped your
  east branch — 14 cells lost")

**M8 implementation** (`sim/structure.ts`):

- `computeStructure(cells)` returns per wood-cell `moment` (combined gravity+wind bending
  demand), `strength`, `stress` maps. Distance-to-ground = multi-source BFS from underground
  (root) wood cells through tree + deadwood. Load is then integrated down layer-by-layer,
  shared across all parallel paths and laterally equalized within each cross-section. See
  "Strength and stress" above for the load-sharing bending model (gravity + wind).
- `applyBreakage(cells, removed)` is the shared connectivity rule for _both_ storm
  snaps and pruning: from the removed set, also drop any wood the roots can no longer
  reach and any terminal left without a wood neighbour. `prune.computeRemovalSet`
  delegates to it (a one-cell breakage), so prune and storm damage can never disagree.
- Storms live on `SeasonWeather.storm` (deterministic, rolled _after_ rain so existing
  forecasts are byte-identical). Enabled Year 2+; severity scales with the difficulty
  curve (severe only Year 9+). `runSeason()` returns `{ frames, storms }` (and
  `simulateSeason()` is the frames-only wrapper the sim tests use); the storm check
  runs as tick-order step 10. Roots (underground) never snap — a tree blows down at the
  trunk, it isn't uprooted. The HUD flashes a banner + camera shake + brief playback
  pause on each break; the season summary reports the outcome.
- Live stress tint: cells with stress > 0.8 (`STRESS_WARN`) get a red overlay at all
  times, including a planning preview over real + staged cells. The Inspector shows a
  "Load stress" row (flagged "storm risk" past the line).
- Milestones added: "Survive a drought" and "Weather a storm without losing a single
  cell" (both now reachable; the flower/fruit goals still sit unreachable until M9).

---

## Weather System

### Seasons

| Season | Sun angle | Intensity | Rain   | Storm chance |
| ------ | --------- | --------- | ------ | ------------ |
| Spring | 20°       | 0.7       | Medium | Medium       |
| Summer | 5°        | 1.0       | Low    | Low          |
| Fall   | 20°       | 0.5       | Medium | Medium       |
| Winter | 40°       | 0.1       | Low    | Low          |

### Weather events within a season

- **Rain event**: 8–15 ticks; deposits soil moisture; clouds reduce light during it
- **Drought**: a season (or two consecutive) with rain probability near zero and
  evaporation × 1.5; always visible in the forecast at least one season ahead
- **Heat wave**: a summer modifier; transpiration × 1.8
- **Storm**: a 1–2 tick event; structural failure check (see above)
- **Frost**: see frost rules below — this is a core mechanic, not a footnote

### Frost and the deciduous cycle (core mechanic)

- **The canopy auto-grows in spring/summer/fall and auto-drops at fall's end.** It grows at
  each growing season's first tick (`growAutoLeaves`, see "Auto-leaves") and drops at the
  END of fall (`resolveAutumnDrop` in `simulate.ts`, after fall's last tick, before aging)
  — the deciduous reset. **Every leaf resorbs `LEAF_SHED_RESORB` (75%)** of its stored
  energy into the adjacent wood. The leaves photosynthesised all fall first; the tree is
  **bare entering winter**, then re-leafs itself the following spring.
- **No manual leaf control at all (M10).** Leaves are auto-grown and auto-dropped; the
  player never places or sheds them. (This subsumed the earlier M9 "auto-shed" fix and
  removed the leftover tap-to-shed mechanic, the `shedMarked` plumbing, and `resolveShedding`
  entirely.) `LEAF_FROST_RESORB` remains the backstop rate in `winterFrost` for any terminal
  somehow present at winter onset. The `shed-leaves` milestone completes on your first
  simulated fall (`seasonSimulated === 'fall'`).
- **Why the drop is at fall-end, not winter-onset (important fix):** previously the
  canopy survived into the winter _planning_ phase and was frost-killed at winter's
  first sim tick. That meant the winter budget counted leaf energy that was about to be
  destroyed — the player saw "⚡13 in winter" then "⚡3 in spring" and reasonably read it
  as a bug. Dropping the canopy entering winter makes the winter budget honestly equal
  the tree's overwintering reserves; winter→spring now changes only by dormancy upkeep.
  It also lifts spring budgets (the 30% resorb is banked in wood, not lost), so the tree
  grows noticeably faster year to year. `winterFrost` remains a backstop for any
  leaf/flower/fruit somehow present at winter onset (e.g. a directly-constructed test
  state) and for killing age-0 winter growth.
- Resorption is **proportional to the leaf's actual energy** (not flat), so the canopy
  is a genuinely _recoverable_ store and the tree re-leafs in spring instead of starving.
- **Off-season shed marking is budget-neutral during planning** — the resorbed energy
  returns in _next_ season's budget, not the current one. Guarded by `recovery.test.ts`.
- **Spring frost** (possible in early years' forecasts, more common later): kills all
  cells placed in the immediately preceding planning phase. The forecast warns of
  frost risk; planting early in a frost-risk spring is a gamble.
- **Winter growth**: any _above-ground_ cell staged during winter planning dies at the
  first frost tick (`winterFrost` kills age-0 cells with `r < surfaceR`). **Underground
  roots are insulated and survive** — so winter's constructive actions are extending the
  root system and pruning. Planning rejects above-ground placement in winter
  (`rejected_winter`) and `getValidPlacements` only offers underground spots; the HUD hint
  says so. (Playtest fix — players asked why winter even let them grow leaves that just
  die, and whether roots should be allowed. Now: no leaves, yes roots.)

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
one the player _planned_ (the pre-advance season), carried into `simulateSeason` via
the `SeasonWeather` object — `applySeasonAdvance` rolls the displayed label forward,
but the sim reads season behaviour from the weather, not the label. Drought chance
from Year 4 is **0.18** (never in winter). Spring frost is forecast-modelled (winter
always reads "frost risk") but its cell-kill is deferred past M6; winter-onset leaf
kill and winter-growth (age-0) frost death are implemented.

### Difficulty curve

- **Year 1**: gentle. Good rain, no storms, no rot, no pests. Winter 1 still requires
  the leaf-shed lesson and surviving on reserves.
- **Year 2**: storms enabled (minor/moderate).
- **Year 4**: droughts possible. (Rot is deferred — see Decisions Deferred.)
- **Year 6**: heat waves. (Leaf pests deferred with rot.)
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
- **Spring vigor floor (`SPRING_VIGOR` = 3):** in spring the budget is
  `max(bankedEnergy, 3)`. Leaves are the only energy source but a leaf costs 1 energy
  to grow — so a leafless tree that has drained to 0 (e.g. a new player who spent the
  seed's reserve on wood) could _never_ afford a leaf again: an unrecoverable softlock
  while still alive (roots keep the wood at health 0.5 forever). The floor mints energy
  only into leaves you actually plant (the existing "no payers → no deduction" path),
  so it's a spring-flush recovery lifeline, not a farmable hoard. Healthy trees
  (banked ≫ 3) are unaffected. The HUD also shows a spring re-leaf prompt when the
  canopy is bare. Guarded by `recovery.test.ts` ("starved to 0 … recovers via floor").

### Staging

- The player stages **wood** (and, in spring, **flowers**). **Leaves are NOT placed by
  hand** — the canopy auto-grows during the simulation (see "Auto-leaves" below).
- Tap an empty cell adjacent to any tree cell (staged or real) to stage growth there —
  chaining staged cells to extend a branch several cells in one phase is allowed
- Above the surface: stages a branch (wood). Below the surface in soil: stages a root
  (wood); soil cell is consumed. Underground root placements get a **high-contrast warm
  outline** (the faint above-ground hint is invisible over tan soil — playtesters didn't
  realise they could dig roots down). A branch may also be staged over an existing leaf
  (it grows up through the canopy, replacing that leaf).
- In rock: rejected with a brief shake/feedback
- Leaves, flowers, and fruit are terminal: nothing can attach to them
- Staged cells render at 50% opacity with a **dashed white outline drawn around the
  perimeter of each contiguous staged group** (no dividers between adjacent staged cells)
- Tap a staged cell to unstage it (energy refunded immediately). If that disconnects
  other staged cells from the tree, they unstage automatically with refunds.

### Auto-leaves (M10)

Leaf placement had no real strategy beyond "don't grow in deep shade" — which is the
engine's own light math — so hand-placing (and the "🍃 Fill leaves" button, and shed-
marking) was pure tedium. Leaves now **auto-grow**:

- At each growing season's **tick 0** (`growAutoLeaves` in `sim/simulate.ts`), the tree
  puts out leaves on every open above-ground hex adjacent to wood that is (a) at least
  `MIN_LEAF_HEIGHT` (3) cells above the **spawn ground** and (b) **net-positive** — its
  light income clears `AUTO_LEAF_MIN_GEN`. Greedy, recomputing self-shading each pass, so
  it converges to a productive lit shell rather than a deep water-hungry stack.
- Leaves are **free** (the player only spends energy on wood and flowers). The planning
  canvas **previews** where the canopy will grow (faint green) as you shape wood, so the
  height/width trade-off stays legible.
- **`MIN_LEAF_HEIGHT` is the anti-crawler rule and is load-bearing.** Free auto-leaves
  would otherwise let a flat ground-hugging sprawl carpet itself in unlimited full-sun,
  un-self-shaded, short-water-path leaves (the "ground crawler") — in the harness it
  out-scored a real tree ~5×. Gating on height _above the spawn ground_ (not the per-column
  surface, which is bumpy ±2-3 and the crawler exploited) makes the crawler non-viable
  (harness: score ~1) while a balanced grower wins (~23) and a fresh seed (energy 8) can
  still build a height-3 trunk turn one and bootstrap. Validated in `cli/play.ts`
  (strategy sweep) and `sim/simulate.test.ts` (`growAutoLeaves`).
- The deciduous cycle is unchanged otherwise: the canopy auto-drops at fall's end
  (`resolveAutumnDrop`, 75% resorb) and the tree is bare entering winter.

### Modes

A small mode toggle in the HUD: **Wood / Reinforce / Flower**. The toggle appears once any
non-default mode unlocks — both the **Reinforce** and **Flower** buttons unlock at the "Reach
30 cells" milestone, but **Reinforce** persists in every season (structure is always relevant)
while **Flower** shows only in spring. Before 30 cells (and outside spring, with no Reinforce
unlocked yet — i.e. never, since both unlock together) everything the player places is plain
wood, so no toggle is shown.

- **Wood** (`'tree'`, 1⚡): branches above ground, roots below.
- **Reinforce** (`'reinforced wood'`, 2⚡): ½ structural moment/stress — for fruiting
  cantilevers and storm-exposed limbs — but higher water upkeep (0.075 vs 0.05/tick) and it
  grows **no leaves or flowers** (the auto-canopy skips it, and flowers can't anchor on it).
  Stages exactly like wood otherwise (chains, replaces a leaf, valid growth anchor). The
  placement path is the only thing M-series added; the sim handlers (`structure.ts` halving,
  upkeep, colour `#4e2b00`, inspector label) pre-existed from the `0.0.2` scaffolding.

### Flower placement rules (relaxed in M9 playtest)

- Spring planning only, and only after the "Reach 30 cells" milestone
- **Cost 3 energy** (wood/leaf cost 1)
- Placeable on an empty above-ground hex **or on top of a leaf it replaces** (blooms grow
  among the leaves), adjacent to a wood cell with **health > 0.6** (`FLOWER_ANCHOR_HEALTH`)
- Flowers are terminal
- **Why the old rule was scrapped:** it required a strict "branch tip" (no wood above) AND
  an _empty_ neighbour AND one-per-tip. But a healthy canopy fills every tip hex with
  leaves, so there was almost never anywhere to bloom — playtesters (and the headless
  harness: healthy tips present, zero valid placements) hit "the flower button is on but I
  can't place anywhere." The rule is now "a bloom needs healthy wood and a spot among the
  leaves," gated by the 3-energy cost rather than geometry. When flower mode is on with no
  valid spot, the HUD explains why.
  See "Flowers, Fruit, and the Annual Reproductive Cycle" for the full lifecycle.

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
- **What's pruneable (`isPruneable` in `game/prune.ts`):** wood, deadwood, flowers, fruit.
  **Leaves are NOT pruneable** (M11) — they're auto-grown and auto-dropped (M10), so removing
  one is a pointless trap (it regrows free next spring). The inspector shows a leaf's stats
  but no prune button (with a one-line note); bulk-prune mode won't select leaves. Leaves
  still drop as **free collateral** when the wood they hang on is pruned (via `applyBreakage`).
- "Prune" button cost (`pruneCost`):
  - Healthy wood (health ≥ 0.3): costs **2 energy** (wound sealing)
  - Dying wood (health < 0.3), deadwood, or rotted: **free**
  - **Flowers and fruit: free** (M11) — soft tissue isn't a wound to seal, and dropping a
    doomed thirsty fruit to free up a limb's water is legitimate counterplay, not a penalty
- Pruning removes the cell and every cell that loses its connection to the root
  system as a result — the inspector shows a count and highlights the doomed region
  before you confirm ("Prune — 9 cells will be removed")
- Pruning that would isolate the entire canopy from the roots gets an extra
  confirmation step
- Pruning that would remove the **entire living tree** (every cell, e.g. the lone seed)
  is **blocked** — the Prune button disables with an explanation (`removesEntireTree` in
  `game/prune.ts`, guarded in both the inspector and bulk-prune mode). Use "Plant a new
  seed" to start over. (Playtest bug: you could prune a single-cell tree out of existence.)
- Winter is mechanically the ideal pruning season (nothing else useful to do, and
  reshaping before spring growth) — let players discover this rather than telling them

---

## Cell Rendering — Color Map

Cell color encodes health and type at a glance:

| State                            | Color                                                     |
| -------------------------------- | --------------------------------------------------------- |
| Healthy tree cell (above ground) | Warm brown `#7B5230`                                      |
| Healthy tree cell (root)         | Deep brown `#5C3A1A`                                      |
| Healthy leaf                     | Fresh green `#4CAF50`                                     |
| Water-stressed leaf              | Yellow-green `#A8C060`                                    |
| Energy-stressed leaf             | Dark dull green `#2D6E2D`                                 |
| Unhealthy tree cell              | Desaturates toward gray as health falls                   |
| Deadwood                         | Gray-brown `#8B7355`                                      |
| Rotted                           | Dark gray `#5A5A5A`, mottled                              |
| Flower                           | Pale pink `#FFAAB0`                                       |
| Fruit (unripe → ripe)            | Green-tinged → orange-red `#E8703A`, ramped by `maturity` |
| Soil                             | Tan `#C4A46B`, darkening with moisture                    |
| Rock                             | Dark gray `#6B6B6B`                                       |

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
- Mode toggle (Wood / Reinforce / Flower — Reinforce & Flower unlock at 30 cells; flower only
  in spring) and Advance Season button

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

1. Grow a branch tall enough to leaf out (reworded M11 — leaves auto-grow, so the player's
   action is growing the wood up; "Grow your first leaf" was misleading)
2. Survive your first season
3. Grow 10 cells
4. Reach your first autumn (reworded M11 — the canopy drops automatically, so this is framed
   as reaching the season, not the old "Let your canopy fall before winter" command)
5. Survive your first winter
6. Reach 30 cells (unlocks Flower mode)
7. Grow your first flower
8. Mature your first fruit — your first seed!
9. Tap the deep water table (root at depth ≥ 18)
10. Find an underground spring (grow a root beside a ground-water pocket — the rare deep jackpot)
11. Survive a drought
12. Survive a storm without losing a single cell
13. Produce 5 seeds in one year
14. Reach 100 cells
15. Carry a fruit through a drought summer
16. Produce 25 lifetime seeds
17. Produce 10 seeds in one year
18. Keep your tree alive into its 10th year (longevity — the explicit late-game question)
19. Grow to 200 cells
20. Produce 100 lifetime seeds
    ... keep generating; milestones never run out
    (The former "recover from rot" milestone is shelved with rot — see Decisions Deferred.)

### Death and the Memorial (DEFERRED — see Decisions Deferred)

The intended design: when the last living cell dies, the run ends with a **Memorial
screen** — the tree's final silhouette, its age in years, peak size, lifetime seeds,
milestones earned, and its cause of death in plain words ("Died in the drought of Year
12, age 11, having raised 17 seeds"). One button: "Plant a new seed." Death is an ending,
not a failure state — a eulogy, not a game-over screen. **Deferred for now** along with
the hall of memorials; until built, a dead tree is simply restarted via "Plant a new
seed" (the existing New Game flow).

---

## Flowers, Fruit, and the Annual Reproductive Cycle

This yearly arc is the strategic core of the mid/late game. It is a **commitment with a
delayed, uncertain payoff**: spend energy in spring, carry a thirsty load through the
scarce summer, harvest in fall. Every threshold is **emergent** from existing systems
(banked energy, the 2-unit/tick flow cap, root depth, the deep water table, structure),
not an artificial gate — so the difficulty arc falls out of the tree's size and shape.

### 1. Spring — Bloom (a real bet)

- **Flower mode** appears in the HUD only in **spring** _and_ only after the **Reach 30
  cells** milestone. Off-season or pre-30, the toggle isn't shown.
- **Placement**: a flower occupies an empty above-ground hex (or replaces a leaf) adjacent
  to wood with **health > 0.6** (see "Flower placement rules" — the original strict
  branch-tip/one-per-tip geometry was scrapped in playtest because a leafy canopy left
  nowhere to bloom). Flowers are terminal (nothing grows past them).
- **Cost: 3 energy** (vs 1 for wood/leaf). On a young ~15-energy tree that's a huge slice;
  on a mature 80-energy tree it's pocket change — this single number does most of the
  difficulty-curve work.
- Through spring's 60 ticks a flower drains **0.15 water + 0.10 energy/tick** (existing
  metabolism), fed only by what the tree's vascular system can deliver. You **watch the
  pink gray out** during playback if the branch can't feed it.

### 2. Spring→Summer — Fruit set (the first filter)

- At the **end of spring simulation** (`setFruit`, mirroring `resolveAutumnDrop`'s timing):
  every flower with **health > 0.5** converts to a `'fruit'` (auto-pollination); every
  flower at/below 0.5 **drops** — 3 energy wasted. Lesson: _don't bloom more than your
  spring canopy can keep healthy._
- A new fruit starts at **`maturity = 0.15`** (see below).

### 3. Summer — Carry (the gauntlet)

- Fruit drains **0.20 water/tick** — the thirstiest cell, arriving when summer evaporation
  is highest and rain lowest. This is the core mid-game tension.
- **Maturation bar** (`maturity`, a 0–1 cell field, serialized). Each summer tick, by the
  fruit's own water:
  - **water ≥ 2** (well-fed): `maturity += 0.025` (clamped to 1.0) — visibly ripening
  - **water < 1** (thirsty): `maturity −= 0.04` — ripeness visibly slips
  - in between: holds
- **Abort** when `maturity ≤ 0` → drops, no seed (the drought failure you watch happen).
  This _is_ the failure model (chosen over a hard dry-streak rule); normal health decay
  still applies as a backstop if the whole branch dies. A healthy tree reaches 1.0 with
  ~34 of 60 fed ticks — comfortable for a deep-rooted mid-game tree, precarious for a
  shallow young one. Rates are starting points; calibrate in tests.
- **Throughput competition** (emergent, no new code): several fruit on **one limb**
  compete for that limb's 2 units/tick — clustering starves them. Skill = spread fruit
  across well-supplied tips near the trunk.

### 4. Fall onset — Harvest (the payoff)

- At **fall simulation tick 0** (`ripenFruit`): each fruit at `maturity ≥ 1.0` yields
  **+1 seed** (`score += 1`, flat — quantity is the game), then drops. Any fruit still
  below 1.0 at fall onset drops unharvested. Summer is the gauntlet; fall opens with the
  reward. The season summary reports the harvest ("🌰 Harvested 4 seeds").

### Fruit is heavy (reproduction ↔ structure)

`computeStructure` counts flowers and especially **fruit** (~2–3× a wood cell) into the
supported-load (`cnt`/`sumX`) of their anchoring wood. Consequences, all emergent:
a fruit-laden **cantilever** reddens with stress and is far likelier to **snap in a
summer/fall storm** — losing that limb's whole harvest. Fruiting near the trunk is safe
and well-fed; fruiting on a far limb is a high-yield gamble. This is the late-game threat
layer without pests/disease yet built.

### The difficulty arc (emergent, not gated)

- **Young**: low banked energy → afford 0–1 flowers; small spring canopy → flowers gray
  out before set; shallow roots → fruit can't reach maturity before a dry spell aborts it.
  The first seed is a genuine achievement.
- **Mid**: a deep-water-table root + wide canopy + thick trunk keeps flowers healthy and
  ripens several fruit through August. "5 seeds in one year" becomes reachable.
- **Late**: storms snap fruit-laden limbs; droughts & heat waves (×1.8 transpiration)
  spike fruit thirst and reverse maturation → mass abort. Sustaining a big harvest as
  threats stack is the late game.

The player's yearly question: _how many fruit can my roots actually carry through
August?_ Everything else — root depth, trunk width, canopy size, energy reserves —
feeds into that answer.

---

## Starting State

1. Player sees the terrain (bumpy surface, soil, a few visible shallow rocks)
2. A single seed cell sits at the center surface, half-buried: type `'tree'`,
   water 5, energy 8, health 1.0
3. First planning phase, early **Spring, Year 1**: enough energy for a few cells.
   The natural first moves — grow a branch up (the canopy auto-leafs once it's tall
   enough), a root below — teach the whole game.
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
- Cells now also carry `maturity` (fruit ripeness) — include it in the serialized cell
  so a fruit's progress survives the summer→fall planning save.
- One save slot; "Plant a new seed" (New Game) clears it.
- A persistent "hall of memorials" record (best score, longest life) across runs is
  **deferred** with the Memorial — see Decisions Deferred.

**M7 implementation notes**

- Inspector (`ui/Inspector.tsx`) shows type, water, energy, health, rot, age plus a
  plain-language status line ("Water-stressed", "Low on energy", "Thriving", …) so the
  color map is legible. (M8 added a "Load stress" row once the support graph existed.)
- Pruning (`game/prune.ts`) applies immediately to the game state; the wound-sealing
  cost is accrued on `PlanningState.pruneCostAccrued` and deducted at season advance.
  Removal set = the cell plus everything that loses root-connectivity (BFS through
  wood); a whole-canopy sever requires a second confirm.
- Goals (`game/goals.ts`) reveal one at a time (lowest-index incomplete is the current
  objective); completion is checked after each season advance and surfaced in the
  season summary + goal log. Flower/fruit milestones (7–8) can't complete until M9.

---

## Known UX gaps (backlog — from playtest feedback, not yet built)

- **Drag-to-stage — desktop and mobile built.** Holding **Shift** and dragging the mouse
  stages every valid cell the cursor passes over in one gesture (`buildDragRef` in
  `game/GameCanvas.tsx`, shares the tap-to-stage validity rules via a `visited` set). This
  cured the "clicking cell by cell is death" complaint on desktop. **Mobile now has the
  equivalent**: a single-finger **long-press** (`LONG_PRESS_MS` = 350 ms, held still within
  `LONG_PRESS_MOVE_CANCEL` = 10 px) flips that touch into build mode (`navigator.vibrate`
  haptic confirmation), then dragging stages every valid cell passed over — reusing the same
  `buildDragRef`/`buildAtScreenPos`/`visited` path as desktop. Moving before the timer fires
  cancels it (it's a pan/swipe); a second finger cancels it (pinch-zoom); `touchcancel` and
  `touchend` tear it down cleanly (a build gesture is never treated as a tap).
- **Performance (partially addressed).** Profiled the large-tree slowdown a playtester
  reported as "the more cells I place, the slower it goes" (`src/cli/perf.ts` for the headless
  sim/recompute timings; a Playwright pan-FPS harness for the in-browser render loop). Found
  and fixed the two dominant bottlenecks:
  - **Render-loop recompute on camera-only frames (the "nearly unplayable" symptom).** The
    canvas render loop recomputed the O(cells) planning overlays — `getValidPlacements`,
    `autoLeafPreview`, `computeLight`, `computeStructure` — on _every_ dirty frame, including
    pan/zoom/shake where only the camera moved. Panning a 10k-cell tree spiked frames to
    ~30–40 ms (~25 fps, janky). `GameCanvas` now caches those overlays keyed on
    game/planning/mode object identity (which is reassigned fresh on every real mutation but
    stable across camera moves), so a camera-only redraw reuses the cache. Panning a 10k tree
    is now a flat ~8 ms/120 fps (p95 30.5→10.4 ms, max 39→11 ms).
  - **`computeStructure` recompute on every planning tap (the build-phase lag).** The cache
    above makes camera moves free, but each tap reassigns the planning state and so re-runs the
    overlays — and a LibreWolf (Firefox) profile showed `computeStructure` at ~57% of the
    build-phase time. It allocated a `hexKey` string and a per-cell `Set` in several
    O(cells·6) passes (the per-cell strength BFS was the worst). Rewrote it to index every wood
    cell once into typed arrays + a packed-coord→index `Map` (`packCoord`), build a wood
    adjacency list once, and run all the graph passes (dist BFS, beam integration,
    `equalizeLayer`, the strength BFS via a generation-stamped visited array) on integer
    indices with precomputed per-cell geometry — **zero `hexKey`/`Set` allocation in the hot
    loops, output byte-identical** (guarded by `structure.test.ts`'s exact stress assertions).
    `computeStructure` on a 10k tree: ~8.9 → ~2.3 ms (~4×), and near-linear now. `GameCanvas`
    also builds the real+staged `mergeStaged` map once per recompute and shares it across the
    leaf-preview / leaf-light / stress passes (was three full-map clones). The dominant
    remaining per-tap cost is `autoLeafPreview` (the iterative multi-pass canopy fill, shared
    with the deterministic `growAutoLeaves` sim — deliberately left untouched).
  - **Diffusion allocation during a season advance (the freeze on "Advance Season").** The
    `diffuse` pair-collection — the hottest sim loop (6 neighbours × every cell, every tick) —
    allocated a `"${a}|${b}"` template string + string `Set` per edge and an `[a,b]` tuple per
    pair. Replaced the dedup with a numeric canonical edge id (`edgeCode`/`EDGE_MUL`) and the
    pairs with two parallel flat arrays — **byte-identical results** (same pair set/order/RNG;
    guarded by the determinism-sensitive sim/save tests) with far less GC churn. A 10k-cell
    half-season advance dropped ~3.5 s → ~2.4 s (≈30%; similar at 1k/3k).
  - **Canvas draw volume when zoomed all the way out.** A separate bottleneck (not the
    recompute above): at min zoom each hex is ~4px, so `drawScene` path-fills-and-strokes
    ~25–30k tiny hexes/frame, dominated by `drawFilledHex`/`fill`/`hexPath`/`stroke` and the
    per-hex colour computation (`cellColor` chains up to 4 `lerpColor`s). Three safe,
    visually-identical-when-small fixes in `render/renderer.ts` + `render/colors.ts`: (1) below
    `RECT_HEX_R` (6px) screen radius draw each cell as a single `fillRect` (no path, no
    invisible 1px stroke); (2) precompute the 6 constant hex-vertex trig offsets (`HEX_VERT`)
    instead of 12 trig calls/hex; (3) memoize soil colour across 64 moisture buckets (soil is
    the most-drawn cell underground). Zoomed-out pan on a 10k tree: p95 26→16 ms, max 27→19 ms
    (~38→~64 fps on the heavy frames, often a flat 120). Further wins would need batching fills
    by colour into one Path2D per colour, or a general cell-colour cache — left as candidates.
  - **Still candidates** (not done — larger/riskier): the advance is still a multi-second
    freeze at 10k because the sim retains a full deep `Map` snapshot per tick (30 frames) and
    each tick step re-clones the map; the clean fix is to **stream playback** (simulate tick N
    while displaying N−1, spreading the compute across the 2.5 s animation) or move the sim to
    a **Web Worker**. Also still open from the original list: dirty-rect Canvas redraws,
    throttling the light calc every N ticks during playback, and a fully integer hex key
    (the diffusion path no longer allocates the pair strings, but `Map<string, Cell>` keys are
    still strings everywhere else). Use `npx tsx src/cli/perf.ts` to re-check before/after.
- **Soil-moisture "halo" artifact.** Only soil near the tree is simulated and _promoted_
  into `cells` (so its moisture persists); the rest renders at the static terrain default.
  Soil darkens with moisture, so the boundary shows as a darker/different patch tracing the
  root system (deep roots at the wet water table are darkest). Players read it as "roots
  darken the soil." A proper fix simulates/renders a consistent soil-moisture field (or
  blends the promoted region into the default). Not a gameplay bug.
- **Playback reads as static.** _Mostly addressed (playback animations)._ The HUD shows live
  total 💧 water / ⚡ energy during playback, and the canvas now animates the season: a
  **grow-in pop** as new wood/leaves appear (ease-out-back scale-up), a **falling-leaf**
  particle drop when leaves/flowers/fruit are shed (autumn drop, storm loss — capped, drifting
  - fluttering world-space particles), and a subtle **leaf shimmer** (a per-leaf light-green
    ripple) so the canopy reads as alive mid-season. All render-only — the sim stays pure; driven
    by diffing consecutive displayed frames (births → pop, deaths → particles) plus `performance.now()`.
    See `render/renderer.ts` (`SceneAnim`, `GROW_MS`, `popScale`, `drawLeafShimmer`) and the
    animation driver in `game/GameCanvas.tsx` (`animRef`, `spawnParticle`, `drawParticles`;
    `GameCanvas.setPlaying` from `App` start/finishPlayback gates it). During playback the loop
    redraws at full rAF (not just per tick) for smooth shimmer/pops. **Still wanted:** the
    water/energy **pulse up the trunk** (deferred — the fiddliest of the four; a moving
    height-banded highlight or true flow viz).
- **Camera doesn't follow growth.** CLAUDE.md specifies a gentle drift to keep new
  growth in frame unless the player has manually panned recently; not implemented. The
  initial camera now fits the loaded tree's bounding box (`makeCamera` in `GameCanvas`),
  but it does not re-frame as the tree grows during a run.
- **Minimap** (corner overview once the tree exceeds ~1.5× viewport) — specified, not built.

## Shipped cell types (formerly `0.0.2` "Quality of Life" scaffolding)

Two new `CellType`s were added on the `0.0.2` branch with their simulation plumbing in place
but unreachable in play. **Both now ship and are reachable**: `'reinforced wood'` (see below)
and `'ground water'` (the deep infinite pocket — see below). Kept here as the record of how
they were finished and the constants that drive them.

### `'reinforced wood'` — stronger wood (✅ now placeable)

- **Intent** (per the author): a wood variant that is structurally stronger but a worse
  conduit — used for internal/base reinforcement. By design it does **not** grow leaves or
  flowers (intentional, not a bug — confirmed in PR review).
- **What's wired up:** treated as living wood by `isLivingWood` (water exchange, root
  absorption, light occlusion, reachability/anchor checks), `structure.ts` halves its
  `moment` and `stress`, water upkeep is **0.075/tick** (vs 0.05 for `'tree'`), it has its
  own color (`#4e2b00`), and diagnose/inspector/HUD all account for it.
- **Placement path (added):** `PlacementMode` gained `'reinforced'`, `REINFORCED_COST = 2`,
  and a HUD "Reinforce" toggle (unlocks with the 30-cell milestone, persists across seasons).
  `handleTap` stages a `'reinforced wood'` cell (via `woodType`/`woodCost` helpers) for both
  empty hexes and leaf-replacement; `stagedCost`/`getValidPlacements` (anchors include
  reinforced wood) / refunds all account for it. The auto-canopy and flower anchors
  deliberately skip reinforced wood (no leaves/flowers). See "Modes" under Planning Phase.
- **Not yet driven (future polish):** the 2⚡ cost and 30-cell unlock gate are un-tuned against
  the harness; the placement-hint colour doesn't distinguish reinforced from normal wood.

### `'ground water'` — deep infinite water pocket (✅ now reachable)

- **Intent:** a deep, effectively infinite water reservoir that rewards creative deep-root
  growth (the "Infinite water stores" backlog item). Shipped as the **"jackpot + floor"**
  model: rare ground-water pockets are the jackpot, the deep water-table regen is the floor —
  it does **not** replace the table (a player who digs straight down but misses the scattered
  pockets still gets the table payoff).
- **What's wired up (sim):** `GROUND_WATER_CAP = 200` is stored in the cell's `water` field as
  a **sentinel** (NOT `Infinity` — `JSON.stringify(Infinity)` serializes to `null` and would
  corrupt saves). In the sim it reads as an infinite source: `diffuseWater` overrides
  `get`/`capacity`/`budget` for it, it never receives water (`recv.type === 'ground water'`
  is skipped), and `absorbWater` lets an adjacent root fill to cap each tick without
  depleting it. Root absorption, `buildWork` soil pre-expansion, and color all handle it.
- **Placement (added):** `groundWaterProbability` now ramps from depth `GW_MIN_DEPTH` = 25
  (see "Soil depth and rocks" for the curve + density/reachability numbers — kept very rare,
  a fraction of a percent even deep), on an independent hash channel. Renders as vivid blue
  (`render/colors.ts`), so once a root reveals nearby terrain it's a visible target to steer
  toward. The `tap-spring` milestone (`game/goals.ts`) credits the first root grown beside one;
  `diagnose.ts` reports "Roots tapping ground water".
- **Validated** in the headless harness: density/reachability sweep (0 above depth 25, rising
  ~0.15%→~0.57% across depths 25–49; a wide deep root mat finds one only ~7–19% of the time),
  an end-to-end check (a dry root fills 0.5→10 from a spring while the source holds at 200;
  milestone fires), and the `play.ts` strategy sweep (balance unchanged: balanced ~19 wins,
  crawler ~1 dead).

### Deep water table — restored to the design value (was temporarily nerfed)

The passive deep water-table regen in `updateSoil` (depth ≥ 18) is the **reliable floor**
beneath the ground-water jackpot. It had been temporarily nerfed (regen 0.1 → 0.01/tick, cap
`SOIL_WATER_CAP` → `/2`) as a placeholder pending ground water; with ground water now shipped
as a _complement_ (not a replacement), it's been **restored to the design value: 0.1/tick,
full `SOIL_WATER_CAP` (20)**. So deep roots are always rewarded (the floor), and the rarer
ground-water pockets are the high-value targets on top.

### Build note

Adding these two `CellType`s requires updating every exhaustive `Record<CellType, …>` / switch.
The `TYPE_LABEL` map in `ui/Inspector.tsx` was missed and broke `tsc` — fixed (both keys added,
and `'ground water'` treated as terrain in the inspector). When adding a cell type, grep for
`CellType` usages and check `npx tsc --noEmit` passes.

## Decisions Deferred (do not implement yet)

- **Rot** (former Milestone 9): infection sites, rot spread, free pruning of dead/dying
  cells, deadwood crumbling, and the "recover from rot" milestone. The `rot` field, the
  `spreadRot` stub, and free pruning of dead/dying/rotted cells already exist as
  scaffolding — leave them in, just don't drive them yet.
- **Leaf pests** (a patch of leaves loses photosynthesis efficiency and spreads
  leaf-to-leaf; counterplay is shedding affected leaves) — was slated for Year 6.
- **Memorial screen** — the end-of-run eulogy (final silhouette, age, peak size, lifetime
  seeds, milestones, plain-language cause of death). Until built, death just restarts via
  "Plant a new seed."
- **Hall of memorials** — the cross-run best-score / longest-life record.
- **Rock destruction.** Let the player spend energy (suggested: 20 per rock cell) during
  the planning phase to remove a rock cell, opening that hex for root growth. Gives agency
  when the random rock layout blocks a critical path. Cost is deliberately steep so it's a
  late-game tool (on a 20-energy tree it's ruinous; on a 200-energy tree it's a real
  choice). Fits the existing planning/energy framework with no new systems.
- **Milestone rewards.** Currently milestones are pure achievements. Consider a tangible
  reward on completion — a one-time energy grant, a permanent upkeep discount, or unlocking
  a new cell type. The flower unlock on "Reach 30 cells" is the existing precedent. Design
  the reward to feel like the milestone "pays off" rather than just recording the
  achievement, without making early milestones feel obligatory to min-max.
- **Underground aquifer nodes.** ✅ **Largely built** as `'ground water'` — see "Shipped cell
  types" and "Soil depth and rocks". Discrete, procedurally-placed, visibly-distinct (vivid
  blue) infinite pockets that roots must physically reach through the rock, with the water
  table kept as the reliable floor beneath them — exactly the "jackpot + floor" design here.
  _Optional remaining work:_ **clustered** multi-cell aquifers (currently single scattered
  cells) and a finite high-regen variant distinct from the infinite pockets.
- **Fauna: birds and canopy disturbance.** Trees that grow above a certain height (≈ 50 cells
  above ground, roughly corresponding to the 50ft comment) attract birds. Birds can displace
  leaves (removing them from a branch, resetting auto-leaf growth for a tick), eat a fruit
  (maturity → 0, instant abort), or — rarely — snap a twig (small branch). Counterplay:
  dense clusters of branches deter nesting; fruit near the trunk is safer. Thematically:
  tall trees have wind, birds, and lightning risk; short trees stay under the radar. Enables
  a Year 8+ difficulty layer without requiring rot or pests to be built first. Build after
  leaf pests (the leaf displacement is mechanically similar).
- **New cell types (all need balancing before build):**
  - _Water reserve (cistern)._ A specialised cell that holds 200+ water but cannot absorb
    from soil or receive diffusion faster than a normal cell — it must be charged by the
    tree's ordinary vascular flow. Acts as a drought buffer: a tree with a cistern near
    the trunk can survive a short dry spell even if the roots run dry. Cost: higher than
    wood (suggested 3–4 energy). Only one cistern should be placeable per tree initially
    (or unlock after the "Tap the deep water table" milestone). Pair with the energy
    reserve below.
  - _Energy reserve (heartwood cache)._ Mirror of the cistern for energy — stores 200+
    energy, cannot photosynthesize, must be charged by ordinary energy diffusion. Lets a
    player bank energy toward a big spring planting without losing it to the cell-count cap.
    Same cost and unlock restrictions as the cistern.
  - _Conduit (straw)._ A woody cell specialised for conduction: higher flow cap than
    ordinary wood (e.g. 5 units/tick vs 2) but no storage (water/energy capacity = 1), no
    photosynthesis, no absorption. Lets a player build a "vascular highway" to a distant
    canopy or deep root cluster without thickening the entire trunk. Cost: 2 energy (same as
    wood) but the strategic value comes from routing, so placement matters. Needs
    clarification on exact behaviour — see the message below.
  - _Reinforced branch._ ✅ **Built** as `'reinforced wood'` (2⚡, ½ structural stress) — see
    "Modes" under Planning Phase and the `'reinforced wood'` entry under Shipped cell types.
    Listed here only for history.
- **Horizontal growth limit with annual expansion.** Proposed: cap how far left/right the
  player can place cells, expanding the allowed radius by a fixed amount each year or season.
  Would focus early play on vertical depth and trunk structure before the canopy sprawls.
  Needs design work — what does the boundary look like, how fast does it expand, does it
  reset on new game — before building. See clarification message below.
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

### Milestone 9 — Flowers, fruit, and score ✅ built

The reproductive cycle (see "Flowers, Fruit, and the Annual Reproductive Cycle" for the
full design). Reordered ahead of rot, which is deferred.

**Implementation:**

- `Cell.maturity?` (fruit ripeness) added and serialized (`sim/cells.ts`, `game/save.ts`),
  with the reproductive constants (`FLOWER_SET_HEALTH`, `FRUIT_START_MATURITY`,
  `FRUIT_FED_WATER`/`FRUIT_THIRSTY_WATER`, `FRUIT_RIPEN_RATE`/`FRUIT_DECLINE_RATE`).
- `sim/simulate.ts`: `setFruit` (spring-sim end: health > 0.5 → fruit @ start maturity),
  `matureFruit` (per-tick step after `updateHealth`: water ≥ 2 ripens, < 1 regresses,
  ≤ 0 aborts), `ripenFruit` (fall-sim tick 0: every fruit drops; ripe ones score +1).
- `sim/structure.ts`: `TERMINAL_LOAD` hangs flower (1) / fruit (2.5) weight on the
  anchoring wood so fruited limbs stress and can snap. Leaves stay weightless.
- `game/planning.ts`: `'flower'` mode, `FLOWER_COST = 3`, `canPlaceFlower` (spring,
  above-ground hex or leaf-replace adjacent to healthy wood — see relaxed rule above);
  flower-aware refunds, reachability, `getValidPlacements`, proportional advance cost.
- `game/goals.ts`: `seedsThisSeason` in `GoalContext`; milestones `five-seeds`,
  `hundred-cells`, `fruit-drought`, `lifetime-25`. Score harvested via `ripenFruit`.
- UI: HUD Flower toggle (spring + 30-cell only; resets to Wood on leaving spring),
  fruit colour ramped by maturity, pink placement hints, season-summary harvest line, a
  "nowhere to bloom" hint, and an inspector stress hint.
- Tests: `sim/reproduction.test.ts` (set/drop, maturity climb/abort, ripen→score, fruit
  load raises stress, full-season wiring) and `game/flower.test.ts` (placement, cost,
  multi-bloom, leaf-replace, refund, advance cost).

**M9 playtest pass (post-build balance fixes).** A headless harness in **`src/cli/`** drives
the real sim/planning/goal logic with no canvas (`npx tsx src/cli/play.ts` for scripted
multi-year sweeps + ASCII tree; `npx tsx src/cli/experiments.ts` for controlled
conduction/economy micro-tests). `src/cli` is excluded from `tsconfig` (dev-only, run via
tsx). **Round 1** surfaced four issues, all fixed: (1) water conduction too resistive →
`DIFFUSE_RATE` 0.15→0.5; (2) leaf income too low → `PHOTO_COEFF` 0.12→0.24 (killed the
0-energy "zombie" attractor); (3) flowers un-placeable → relaxed placement rule; (4) manual
fall shedding was busywork → automatic.

**Round 2** (more playtest feedback): (5) the `first-flower` milestone never completed —
it checked for a flower in the _post-sim_ state, but flowers have already set to fruit by
then; now credited via `grewFlowerThisTurn` (committed plan had a flower). (6) The
**ground-crawler exploit** — flat surface sprawl scored ~4× a normal tree — fixed by the
height-light factor (see Light calculation). (7) Winter now allows underground root growth
(insulated) but frost-kills above-ground growth, with a visible reason. (8) Auto-leaf
button + visible underground root hints + live playback resource readout (tedium/legibility).

**Round 3** (the energy-economy overhaul — "tall trees can't keep water up top and energy
down at the roots; the middle starves of both"). Root cause: the symmetric health rule
required _every_ cell, including inert structural wood, to hold both water AND energy, so
energy made at the leaves had to crawl down to the roots (it never did) and water up to the
canopy — any tall tree sat pinned at health ~0.5 everywhere. Fixes: (9) **wood health is now
WATER-driven only** — structure is dead scaffolding + water-conducting sapwood; energy is
just the growth/reproduction currency, free to pool where it's made (see "Health update").
This alone made tall trees viable and healthy (the harness `tallGrower` survives every seed;
the conduction experiment shows height-12 trees fully healthy in every band). (10) With
health decoupled, **wood upkeep dropped 0.015 → 0.005**, curing the fall-drain subsistence
trap so a brutally-pruned tree _snowballs_ back (item #5 — "is it game over?": no). (11)
**`LIGHT_GROUND_FACTOR` 0.40 → 0.22** re-suppresses the crawler that cheap wood revived.
(12) Inspector status is now type-aware (a healthy root at energy 0 reads "Thriving", not
"Low on energy"). (13) "Fill leaves" reserve is season-aware (full spend in spring/summer).
New harness tool `cli/recover.ts` guards the recovery snowball; `cli/experiments.ts` now
reports per-band health for tall trees.

Across the strategy sweep the balanced grower (~17–19 seeds/10y) cleanly beats tall (~9),
over-flowering (~11) and the ground-crawler (~6) — strategy matters and the exploit is dead,
while every band of a tall tree (leaves, canopy wood, mid-trunk, roots) now stays healthy.

**Round 4** (drought canopy + summary legibility, from a Fall-Y4 drought screenshot):
(14) **Stomatal closure** — a water-stressed canopy throttles transpiration so it survives
drought instead of crashing to 0 (see Metabolic consumption; new diagnostic `cli/water.ts`,
which proved deep roots alone were _not_ a canopy-drought defence). (15) The season-summary
delta colour was hard-coded green, so a storm's **−95 living cells read as a "good" green** —
now sign-aware (green gain / red loss / grey neutral) for both energy and cells.
**Use this harness (`play.ts`, `experiments.ts`, `recover.ts`, `water.ts`, `winter.ts`) to
validate any future balance change before shipping it.**

### Milestone 10 — Workload reduction & save diagnostics ✅ built

A pass of playtest-driven UX/balance work (brother's second playthrough):

- **Resource-flow overlay** (💧/⚡ HUD toggles), **altitude ruler**, **clearer next-season
  label**, and **bulk speed-prune mode** (tap-to-select; `prune.computeMultiRemoval`).
- **Save-file diagnostic** (`game/diagnose.ts`) — a dense health report (parasite leaves,
  water supply/demand, wood health, flower-anchor lockout, energy headroom). App logs it to
  the browser console on load and exposes `treegameDiagnose()`; `cli/diagnose.ts` runs it on
  a saved JSON. The way to share a run as text, not a screenshot. **Upgraded post-M11** with:
  a **vertical profile** (water & health per 4-cell altitude band, top→base) that exposes the
  trunk-conduction gradient the global min/avg/max hid (a top band much drier than the base is
  the "can't water the lifted canopy" signature); an **"Avg living health"** headline
  (healthy / ⚠️ stressed / 🛑 in decline); and a **smarter verdict** that flags "canopy
  starves with height", a graying canopy, and overall decline, and only calls a tree "healthy"
  when avg living health ≥ 0.75 — it no longer reports "balanced" on a dying tree. Reinforced
  wood is counted in the census. Guarded by `game/diagnose.test.ts`.
- **Winter wood die-off fix** — dry structural wood floors at `WOOD_DRY_HEALTH` (0.5)
  instead of decaying to deadwood; thirst never kills wood (only rot/storms/pruning). Stopped
  big deciduous trees shedding their upper structure to deadwood every winter. Validated in
  `cli/winter.ts`.
- **Auto-leaves** — the canopy auto-grows (free) and the player only shapes wood/flowers;
  Leaf mode, Fill Leaves, and shed-marking are gone. See "Auto-leaves" for the design and the
  `MIN_LEAF_HEIGHT` anti-crawler rule. Re-validated the full strategy sweep (balanced ~23
  wins; crawler ~1, dead) and the recovery snowball.
- **Carbon–water coupling** — photosynthesis now scales with leaf water (`photoWaterFactor`),
  so the water system caps energy income and over-building self-corrects instead of banking a
  meaningless ~900 surplus. See "Carbon–water coupling" under Metabolic consumption. New
  harness tool `cli/bigtree.ts` guards against the runaway.
- **Prune guard** — can't prune the entire tree away (`removesEntireTree`); see Pruning.
- **Known limitation (height incentive):** with no competing trees, a low/wide canopy is
  naturally _good_ at reproduction (wide, well-watered, low storm-moment), so the height
  incentive is currently artificial. The harness shows the crawler is either **dominant**
  (if it can grow leaves low) or **dead** (walled by `MIN_LEAF_HEIGHT`) — there's no natural
  "viable but worse" middle, because energy-scarcity (the coupling) doesn't touch a
  well-watered low canopy. A genuine soft height incentive needs the deferred multi-tree
  **shade competition**; until then the wall stays.

### Milestone 11 — Half-season checkpoints & milestone refresh ✅ built

- **Half-season checkpoints** — a season now simulates in two 30-tick halves with a planning
  checkpoint between (see "Tick structure" → "Half-season checkpoints" for the full design,
  `seasonHalf`, the RNG-per-half scheme, `runSeasonPart`/`applyPlanCommit`, and the balance
  note). Answers the brother's "more turns per season" ask (BACKLOG "Needs info" reading c):
  smaller batches, less drastic change between them, four-season rhythm intact.
- **Milestone refresh** — reworded `first-leaf` ("Grow a branch tall enough to leaf out") and
  `shed-leaves` ("Reach your first autumn") since both were _automatic_ after M10 auto-leaves
  and read as instructions the player couldn't act on. Added four longevity/scale goals
  (`ten-seeds`, `live-decade`, `two-hundred-cells`, `lifetime-100`).

### Deferred — Rot

(Was Milestone 9; moved to Decisions Deferred.) Infection sites, spread, free pruning of
dead/dying cells, deadwood crumbling.

### Deferred — Memorial

(Was part of Milestone 10.) Memorial screen + hall of memorials. See Decisions Deferred.

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
