import {
  useEffect,
  useRef,
  useCallback,
  forwardRef,
  useImperativeHandle,
  type RefObject,
} from "react";
import {
  createCamera,
  clampZoom,
  screenToWorld,
  worldToScreen,
  type Camera,
} from "../render/camera";
import {
  drawScene,
  BASE_RADIUS,
  GROW_MS,
  type SceneAnim,
} from "../render/renderer";
import { cellColor, type ResourceOverlay } from "../render/colors";
import { computeLight, autoLeafPreview } from "../sim/simulate";
import { computeStructure } from "../sim/structure";
import { SEASON_PARAMS } from "../sim/weather";
import { pixelToHex, hexToPixel, hexKey } from "../sim/grid";
import { surfaceR } from "../sim/terrain";
import type { Cell } from "../sim/cells";
import type { GameState } from "./state";
import {
  getValidPlacements,
  type PlanningState,
  type PlacementMode,
} from "./planning";

const EMPTY_LIGHT = new Map<string, number>();
const EMPTY_STRESS = new Map<string, number>();
const EMPTY_SET = new Set<string>();
const EMPTY_VP = new Map<string, "tree" | "flower">();
const EMPTY_STAGED = new Map<string, Cell>();

// Mobile build-drag (the touch equivalent of desktop Shift+drag): a single-finger
// touch that stays put for LONG_PRESS_MS flips into build mode, then drags to stage
// every valid cell the finger passes over. Moving more than LONG_PRESS_MOVE_CANCEL px
// before the timer fires cancels it (it's a pan/swipe, not a press).
const LONG_PRESS_MS = 350;
const LONG_PRESS_MOVE_CANCEL = 10;

export interface GameCanvasHandle {
  requestDraw: () => void;
  triggerShake: () => void;
  recenter: () => void; // re-frame the camera on the current tree (e.g. after New Game)
  setPlaying: (playing: boolean) => void; // toggles playback animations (pop/shimmer/leaf-fall)
}

// A drifting, fading leaf shed during playback (autumn drop, storm loss). Render-only —
// world coordinates so it stays pinned to the tree as the camera pans during the fall.
interface LeafParticle {
  x: number; // world px
  y: number;
  vx: number; // world px / ms
  vy: number;
  rot: number; // radians
  vrot: number;
  phase: number; // flutter phase
  born: number; // ms timestamp
  life: number; // ms
  color: string;
  size: number; // world px
}

const PARTICLE_GRAVITY = 0.00003; // world px / ms²
const MAX_PARTICLES = 500; // hard cap so a huge autumn drop can't flood the canvas
const MAX_SPAWN_PER_DIFF = 200; // and per single frame-to-frame change

interface GameCanvasProps {
  gameRef: RefObject<GameState>;
  planningRef: RefObject<PlanningState>;
  modeRef: RefObject<PlacementMode>;
  isPlaying: boolean;
  inspectedKey: string | null; // cell shown in the inspector (white outline)
  pruneSet: Set<string>; // cells a pending prune would remove (red overlay)
  overlay: ResourceOverlay; // resource-flow view ('none' | 'water' | 'energy')
  pruneMode: boolean; // bulk-prune selection active → hide placement hints
  onTap: (q: number, r: number) => void;
}

// Light map over the real + staged canopy, for the per-leaf sun indicators. Takes the
// already-merged (real + staged) cell map so the per-tap recompute builds that merge once
// and shares it across the light / leaf-preview / stress computations.
function computePlanningLight(
  game: GameState,
  merged: Map<string, Cell>,
): Map<string, number> {
  if (merged.size === 0) return EMPTY_LIGHT;
  return computeLight(
    { ...game, cells: merged },
    SEASON_PARAMS[game.season].sunAngleDeg,
  );
}

const EMPTY_PREVIEW = new Set<string>();

// Hexes the canopy will auto-grow leaves on this season, given the real + staged wood —
// the planning preview so the player sees the prospective canopy as they shape the tree.
// Empty in winter (frost) and during playback (the real leaves are already drawn).
function computeLeafPreview(
  game: GameState,
  merged: Map<string, Cell>,
): Set<string> {
  if (game.season === "winter") return EMPTY_PREVIEW;
  const p = SEASON_PARAMS[game.season];
  return autoLeafPreview(
    { ...game, cells: merged },
    p.sunAngleDeg,
    p.intensity,
  );
}

// game.cells overlaid with staged growth — the canopy the player is previewing. Used
// for both the leaf-sun and the structural-stress previews so staged cells see (and
// cast) the same shade and bear the same load they will once committed.
function mergeStaged(
  game: GameState,
  planning: PlanningState,
): Map<string, Cell> {
  const merged = new Map<string, Cell>(game.cells);
  for (const [k, c] of planning.stagedCells) merged.set(k, c);
  return merged;
}

// Initial camera: frame the tree. A brand-new seed shows the spawn with ground below;
// a loaded/grown tree is centred on the bounding box of its living cells (so refreshing
// mid-game no longer leaves the canopy jammed against the top of the screen).
function makeCamera(game: GameState): Camera {
  const cam = createCamera();
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity,
    n = 0;
  for (const c of game.cells.values()) {
    if (c.type === "soil" || c.type === "rock") continue;
    const { x, y } = hexToPixel(c.q, c.r, BASE_RADIUS);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    n++;
  }
  const seedWorldY = hexToPixel(0, surfaceR(0), BASE_RADIUS).y;
  if (n <= 1 || !isFinite(minX)) {
    // Fresh seed — keep the spawn high-ish so the soil below it is visible.
    cam.x = 0;
    cam.y = seedWorldY + BASE_RADIUS * 1.5 * 5;
    return cam;
  }
  cam.x = (minX + maxX) / 2;
  // Bias the centre slightly downward so a little ground shows under the tree.
  cam.y = (minY + maxY) / 2 + BASE_RADIUS * 1.5;
  return cam;
}

export const GameCanvas = forwardRef<GameCanvasHandle, GameCanvasProps>(
  function GameCanvas(
    {
      gameRef,
      planningRef,
      modeRef,
      isPlaying,
      inspectedKey,
      pruneSet,
      overlay,
      pruneMode,
      onTap,
    },
    ref,
  ) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const cameraRef = useRef<Camera>(makeCamera(gameRef.current!));
    const rafRef = useRef<number>(0);
    const dirtyRef = useRef(true);
    const cssSizeRef = useRef({ width: 0, height: 0 });
    const shakeUntilRef = useRef(0); // performance.now() deadline
    const inspectRef = useRef<{ key: string | null; prune: Set<string> }>({
      key: null,
      prune: EMPTY_SET,
    });
    const overlayRef = useRef<ResourceOverlay>(overlay);
    const pruneModeRef = useRef(pruneMode);

    // Cache for the per-frame planning overlays (valid placements, leaf preview, leaf
    // light, structural stress). These are O(cells) — heavy on a big tree — but depend
    // ONLY on the game/planning/mode state, never on the camera. The render loop runs on
    // every dirty frame, including pan/zoom/shake where only the camera moved, so without
    // this cache a big tree recomputes ~tens of ms of structure+light every pan frame
    // (the "nearly unplayable when zoomed out on a huge tree" report). gameRef/planningRef
    // are reassigned to fresh objects on every real mutation (tap, prune, advance, each
    // playback frame), so object identity is a sound cache key: it changes exactly when a
    // recompute is actually needed and stays stable across camera-only redraws.
    const overlayCacheRef = useRef<{
      g: GameState;
      p: PlanningState;
      m: PlacementMode;
      playing: boolean;
      pruneMode: boolean;
      vp: Map<string, "tree" | "flower">;
      staged: Map<string, Cell>;
      leafPreview: Set<string>;
      leafLight: Map<string, number>;
      stress: Map<string, number>;
    } | null>(null);

    // Playback animation state (render-only). Births (new cell keys) → grow-in pop; deaths
    // of leaves/flowers/fruit → falling-leaf particles; a continuous shimmer + the pop window
    // keep the loop redrawing. Diffing is keyed on game-state object identity (lastG) so it
    // runs once per real frame change, never on a camera-only pan.
    const playingRef = useRef(false);
    const animRef = useRef({
      bornAt: new Map<string, number>(), // cell key → first-seen timestamp (grow-in pop)
      prevKeys: new Set<string>(), // non-terrain keys shown last diff
      prevCellMap: null as Map<string, Cell> | null, // for typing/colouring disappeared cells
      particles: [] as LeafParticle[],
      inited: false, // first render: adopt the tree without popping it all in
      animUntil: 0, // keep redrawing until this timestamp (active grow-in pops)
      lastNow: 0, // for particle dt
      lastG: null as GameState | null, // identity of the last diffed game state
    });

    const panRef = useRef({
      dragging: false,
      lastX: 0,
      lastY: 0,
      moved: false,
    });
    const buildDragRef = useRef({
      active: false,
      visited: new Set<string>(),
    });
    const pinchRef = useRef({ active: false, lastDist: 0 });
    // Pending long-press for mobile build mode (timer id + the press-point screen coords,
    // so the timer can build at the spot the finger went down).
    const longPressRef = useRef<{ timer: number | null; x: number; y: number }>(
      {
        timer: null,
        x: 0,
        y: 0,
      },
    );

    // Expose handle to parent
    useImperativeHandle(
      ref,
      () => ({
        requestDraw: () => {
          dirtyRef.current = true;
        },
        triggerShake: () => {
          shakeUntilRef.current = performance.now() + 350;
        },
        recenter: () => {
          cameraRef.current = makeCamera(gameRef.current!);
          dirtyRef.current = true;
        },
        setPlaying: (playing: boolean) => {
          // Set synchronously (before the first playback frame draws) so the commit-moment
          // grow-in pop isn't missed by the prop-update race.
          playingRef.current = playing;
          dirtyRef.current = true;
        },
      }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [],
    );

    // Helper: build at screen position
    const buildAtScreenPos = useCallback(
      (sx: number, sy: number) => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const rect = canvas.getBoundingClientRect();

        const { wx, wy } = screenToWorld(
          sx - rect.left,
          sy - rect.top,
          cameraRef.current,
          rect.width,
          rect.height,
        );

        const { q, r } = pixelToHex(wx, wy, BASE_RADIUS);
        const key = `${q},${r}`;

        if (buildDragRef.current.visited.has(key)) return;

        buildDragRef.current.visited.add(key);
        onTap(q, r);
      },
      [onTap],
    );

    // Cancel a pending mobile long-press (finger moved, lifted, or a second finger landed).
    const cancelLongPress = useCallback(() => {
      if (longPressRef.current.timer !== null) {
        clearTimeout(longPressRef.current.timer);
        longPressRef.current.timer = null;
      }
    }, []);

    // Bridge inspector props into the render loop (which reads refs, not props),
    // and force a redraw whenever the highlight changes.
    useEffect(() => {
      inspectRef.current = { key: inspectedKey, prune: pruneSet };
      dirtyRef.current = true;
    }, [inspectedKey, pruneSet]);

    // Bridge the resource-overlay toggle into the render loop and force a redraw.
    useEffect(() => {
      overlayRef.current = overlay;
      dirtyRef.current = true;
    }, [overlay]);

    // Bridge the bulk-prune mode flag (hides placement hints while selecting).
    useEffect(() => {
      pruneModeRef.current = pruneMode;
      dirtyRef.current = true;
    }, [pruneMode]);

    // Keep the animation play-flag in sync with the prop (the handle also sets it
    // synchronously at playback start to win the first-frame race).
    useEffect(() => {
      playingRef.current = isPlaying;
      dirtyRef.current = true;
    }, [isPlaying]);

    // ── Render loop ───────────────────────────────────────────────────────────
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d")!;

      function loop(now: number) {
        rafRef.current = requestAnimationFrame(loop);
        const isShaking = now < shakeUntilRef.current;
        if (!dirtyRef.current && !isShaking) return;
        dirtyRef.current = false;

        const { width, height } = cssSizeRef.current;
        if (width === 0 || height === 0) return;

        // Shake: oscillate camera.x slightly, amplitude decays to zero
        const cam = cameraRef.current;
        let drawCam = cam;
        if (isShaking) {
          const frac = (shakeUntilRef.current - now) / 350;
          const shakeX = (Math.sin(now * 0.03) * 4 * frac) / cam.zoom;
          drawCam = { ...cam, x: cam.x + shakeX };
          dirtyRef.current = true; // keep looping until shake expires
        }

        const g = gameRef.current;
        const p = planningRef.current;
        const m = modeRef.current;
        if (g && p && m) {
          // Recompute the O(cells) planning overlays only when the game/planning state
          // actually changed — reuse the cache on camera-only redraws (pan/zoom/shake).
          const cache = overlayCacheRef.current;
          const fresh =
            cache !== null &&
            cache.g === g &&
            cache.p === p &&
            cache.m === m &&
            cache.playing === isPlaying &&
            cache.pruneMode === pruneModeRef.current;
          let vp: Map<string, "tree" | "flower">;
          let staged: Map<string, Cell>;
          let leafPreview: Set<string>;
          let leafLight: Map<string, number>;
          let stress: Map<string, number>;
          if (fresh) {
            ({ vp, staged, leafPreview, leafLight, stress } = cache);
          } else if (isPlaying) {
            // Playback: no placement/preview overlays; stress over the real cells only
            // (so it reddens live under a storm).
            vp = EMPTY_VP;
            staged = EMPTY_STAGED;
            leafPreview = EMPTY_PREVIEW;
            leafLight = EMPTY_LIGHT;
            stress =
              g.cells.size > 0
                ? computeStructure(g.cells).stress
                : EMPTY_STRESS;
          } else {
            // Planning: build the real+staged merge ONCE and share it across the leaf
            // preview, leaf-sun light, and structural-stress previews.
            const merged = mergeStaged(g, p);
            vp = pruneModeRef.current ? EMPTY_VP : getValidPlacements(m, g, p);
            staged = p.stagedCells;
            // Auto-leaf preview: where the canopy will grow given the current (real+staged)
            // wood. Hidden during bulk-prune.
            leafPreview = pruneModeRef.current
              ? EMPTY_PREVIEW
              : computeLeafPreview(g, merged);
            // How much sun each existing leaf receives under the current season's sun
            // angle, including staged-canopy shading.
            leafLight = computePlanningLight(g, merged);
            // Stress preview over real + staged (see new growth's structural cost live).
            stress = computeStructure(merged).stress;
            overlayCacheRef.current = {
              g,
              p,
              m,
              playing: isPlaying,
              pruneMode: pruneModeRef.current,
              vp,
              staged,
              leafPreview,
              leafLight,
              stress,
            };
          }
          const insp = isPlaying ? null : inspectRef.current.key;
          const prune = isPlaying ? EMPTY_SET : inspectRef.current.prune;

          // ── Playback animation diff (once per real frame change) ───────────────
          const a = animRef.current;
          const dt = Math.min(50, now - a.lastNow);
          a.lastNow = now;
          if (a.lastG !== g) {
            const cur = new Set<string>();
            for (const c of g.cells.values()) {
              if (c.type === "soil" || c.type === "rock") continue;
              cur.add(hexKey(c.q, c.r));
            }
            if (!a.inited) {
              a.inited = true; // adopt the initial/loaded tree without popping it all in
            } else if (playingRef.current) {
              // Births → grow-in pop (only during playback, so load/new-game don't pop).
              for (const k of cur) if (!a.prevKeys.has(k)) a.bornAt.set(k, now);
              // Deaths of soft tissue → falling-leaf particles (autumn drop / storm loss).
              if (a.prevCellMap) {
                let spawned = 0;
                for (const k of a.prevKeys) {
                  if (cur.has(k) || spawned >= MAX_SPAWN_PER_DIFF) continue;
                  if (a.particles.length >= MAX_PARTICLES) break;
                  const c = a.prevCellMap.get(k);
                  if (
                    c &&
                    (c.type === "leaf" ||
                      c.type === "flower" ||
                      c.type === "fruit")
                  ) {
                    a.particles.push(spawnParticle(c, now));
                    spawned++;
                  }
                }
              }
              if (a.bornAt.size > 0) a.animUntil = now + GROW_MS;
            }
            // Drop finished/removed grow-ins so bornAt can't grow unbounded.
            for (const [k, t] of a.bornAt)
              if (!cur.has(k) || now - t > GROW_MS) a.bornAt.delete(k);
            a.prevKeys = cur;
            a.prevCellMap = g.cells;
            a.lastG = g;
          }
          // Skip the per-cell animation work entirely on a plain (e.g. camera-only) redraw.
          const sceneAnim: SceneAnim | null =
            a.bornAt.size > 0 || playingRef.current
              ? { now, bornAt: a.bornAt, shimmer: playingRef.current }
              : null;

          drawScene(
            ctx,
            width,
            height,
            drawCam,
            g.cells,
            g.terrain,
            staged,
            leafPreview,
            vp,
            leafLight,
            insp,
            prune,
            stress,
            overlayRef.current,
            sceneAnim,
          );

          // Falling leaves, drawn over the scene (drawScene cleared the canvas first).
          if (a.particles.length > 0)
            drawParticles(ctx, a.particles, now, dt, drawCam, width, height);

          // Keep redrawing while anything is animating (playback shimmer, active pops,
          // or leaves still falling).
          if (playingRef.current || now < a.animUntil || a.particles.length > 0)
            dirtyRef.current = true;
        }
      }

      rafRef.current = requestAnimationFrame(loop);
      return () => cancelAnimationFrame(rafRef.current);
    }, [gameRef, planningRef, modeRef, isPlaying]);

    // ── Resize observer ───────────────────────────────────────────────────────
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const obs = new ResizeObserver(([entry]) => {
        const { width, height } = entry.contentRect;
        cssSizeRef.current = { width, height };
        canvas.width = Math.round(width * devicePixelRatio);
        canvas.height = Math.round(height * devicePixelRatio);
        const ctx = canvas.getContext("2d")!;
        ctx.scale(devicePixelRatio, devicePixelRatio);
        dirtyRef.current = true;
      });
      obs.observe(canvas);
      return () => obs.disconnect();
    }, []);

    // ── Mouse ─────────────────────────────────────────────────────────────────
    const onMouseDown = useCallback(
      (e: React.MouseEvent) => {
        if (e.shiftKey) {
          buildDragRef.current.active = true;
          buildDragRef.current.visited.clear();

          buildAtScreenPos(e.clientX, e.clientY);
          return;
        }

        panRef.current = {
          dragging: true,
          lastX: e.clientX,
          lastY: e.clientY,
          moved: false,
        };
      },
      [buildAtScreenPos],
    );

    const onMouseMove = useCallback(
      (e: React.MouseEvent) => {
        if (buildDragRef.current.active) {
          buildAtScreenPos(e.clientX, e.clientY);
          return;
        }

        const pan = panRef.current;
        if (!pan.dragging) return;

        const dx = e.clientX - pan.lastX;
        const dy = e.clientY - pan.lastY;

        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) pan.moved = true;

        cameraRef.current.x -= dx / cameraRef.current.zoom;
        cameraRef.current.y -= dy / cameraRef.current.zoom;

        pan.lastX = e.clientX;
        pan.lastY = e.clientY;

        dirtyRef.current = true;
      },
      [buildAtScreenPos],
    );

    const onMouseUp = useCallback(
      (e: React.MouseEvent) => {
        if (buildDragRef.current.active) {
          buildDragRef.current.active = false;
          buildDragRef.current.visited.clear();
          return;
        }

        const pan = panRef.current;
        pan.dragging = false;
        if (!pan.moved) {
          const rect = canvasRef.current!.getBoundingClientRect();
          const sx = e.clientX - rect.left;
          const sy = e.clientY - rect.top;
          const { wx, wy } = screenToWorld(
            sx,
            sy,
            cameraRef.current,
            rect.width,
            rect.height,
          );
          const { q, r } = pixelToHex(wx, wy, BASE_RADIUS);
          onTap(q, r);
        }
      },
      [onTap],
    );

    // Leaving the canvas only cancels an in-progress drag — it must NOT be treated as
    // a tap, or moving the cursor onto the HUD would fire a phantom (often rejected,
    // hence shaking) placement at the exit point.
    const onMouseLeave = useCallback(() => {
      panRef.current.dragging = false;

      buildDragRef.current.active = false;
      buildDragRef.current.visited.clear();
    }, []);

    // ── Wheel zoom (non-passive) ──────────────────────────────────────────────
    useEffect(() => {
      const canvas = canvasRef.current!;
      function onWheel(e: WheelEvent) {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const cam = cameraRef.current;
        const { wx: wx0, wy: wy0 } = screenToWorld(
          sx,
          sy,
          cam,
          rect.width,
          rect.height,
        );
        cam.zoom = clampZoom(cam.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
        const { wx: wx1, wy: wy1 } = screenToWorld(
          sx,
          sy,
          cam,
          rect.width,
          rect.height,
        );
        cam.x += wx0 - wx1;
        cam.y += wy0 - wy1;
        dirtyRef.current = true;
      }
      canvas.addEventListener("wheel", onWheel, { passive: false });
      return () => canvas.removeEventListener("wheel", onWheel);
    }, []);

    // ── Touch ─────────────────────────────────────────────────────────────────
    const onTouchStart = useCallback(
      (e: React.TouchEvent) => {
        if (e.touches.length === 1) {
          const t = e.touches[0];
          panRef.current = {
            dragging: true,
            lastX: t.clientX,
            lastY: t.clientY,
            moved: false,
          };
          pinchRef.current.active = false;
          // Arm the long-press: holding still here flips into build-drag mode.
          cancelLongPress();
          longPressRef.current = {
            x: t.clientX,
            y: t.clientY,
            timer: window.setTimeout(() => {
              longPressRef.current.timer = null;
              panRef.current.dragging = false; // stop panning; we're building now
              buildDragRef.current.active = true;
              buildDragRef.current.visited.clear();
              navigator.vibrate?.(15); // haptic confirmation the mode flipped
              buildAtScreenPos(longPressRef.current.x, longPressRef.current.y);
              dirtyRef.current = true;
            }, LONG_PRESS_MS),
          };
        } else if (e.touches.length === 2) {
          cancelLongPress();
          buildDragRef.current.active = false;
          buildDragRef.current.visited.clear();
          panRef.current.dragging = false;
          pinchRef.current = {
            active: true,
            lastDist: touchDist(e.touches[0], e.touches[1]),
          };
        }
      },
      [buildAtScreenPos, cancelLongPress],
    );

    const onTouchMove = useCallback(
      (e: React.TouchEvent) => {
        e.preventDefault();
        // Build mode active: every cell the finger passes over gets staged.
        if (e.touches.length === 1 && buildDragRef.current.active) {
          const t = e.touches[0];
          buildAtScreenPos(t.clientX, t.clientY);
          return;
        }
        if (e.touches.length === 1 && panRef.current.dragging) {
          const t = e.touches[0];
          const dx = t.clientX - panRef.current.lastX;
          const dy = t.clientY - panRef.current.lastY;
          if (Math.abs(dx) > 2 || Math.abs(dy) > 2) panRef.current.moved = true;
          // A real drag means this is a pan/swipe, not a press — disarm the long-press.
          if (
            longPressRef.current.timer !== null &&
            (Math.abs(t.clientX - longPressRef.current.x) >
              LONG_PRESS_MOVE_CANCEL ||
              Math.abs(t.clientY - longPressRef.current.y) >
                LONG_PRESS_MOVE_CANCEL)
          ) {
            cancelLongPress();
          }
          cameraRef.current.x -= dx / cameraRef.current.zoom;
          cameraRef.current.y -= dy / cameraRef.current.zoom;
          panRef.current.lastX = t.clientX;
          panRef.current.lastY = t.clientY;
          dirtyRef.current = true;
        } else if (e.touches.length === 2 && pinchRef.current.active) {
          const dist = touchDist(e.touches[0], e.touches[1]);
          const factor = dist / pinchRef.current.lastDist;
          pinchRef.current.lastDist = dist;
          const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
          const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
          const rect = canvasRef.current!.getBoundingClientRect();
          const cam = cameraRef.current;
          const { wx: wx0, wy: wy0 } = screenToWorld(
            midX - rect.left,
            midY - rect.top,
            cam,
            rect.width,
            rect.height,
          );
          cam.zoom = clampZoom(cam.zoom * factor);
          const { wx: wx1, wy: wy1 } = screenToWorld(
            midX - rect.left,
            midY - rect.top,
            cam,
            rect.width,
            rect.height,
          );
          cam.x += wx0 - wx1;
          cam.y += wy0 - wy1;
          dirtyRef.current = true;
        }
      },
      [buildAtScreenPos, cancelLongPress],
    );

    const onTouchEnd = useCallback(
      (e: React.TouchEvent) => {
        cancelLongPress();
        // End any active build-drag. If a finger remains, resume panning with it;
        // a build gesture is never treated as a tap.
        if (buildDragRef.current.active) {
          buildDragRef.current.active = false;
          buildDragRef.current.visited.clear();
          panRef.current.dragging = false;
          if (e.touches.length === 1) {
            const t = e.touches[0];
            panRef.current = {
              dragging: true,
              lastX: t.clientX,
              lastY: t.clientY,
              moved: false,
            };
          }
          return;
        }
        if (e.touches.length === 0) {
          const pan = panRef.current;
          if (pan.dragging && !pan.moved) {
            const touch = e.changedTouches[0];
            const rect = canvasRef.current!.getBoundingClientRect();
            const { wx, wy } = screenToWorld(
              touch.clientX - rect.left,
              touch.clientY - rect.top,
              cameraRef.current,
              rect.width,
              rect.height,
            );
            const { q, r } = pixelToHex(wx, wy, BASE_RADIUS);
            onTap(q, r);
          }
          pan.dragging = false;
          pinchRef.current.active = false;
        } else if (e.touches.length === 1) {
          pinchRef.current.active = false;
          const t = e.touches[0];
          panRef.current = {
            dragging: true,
            lastX: t.clientX,
            lastY: t.clientY,
            moved: false,
          };
        }
      },
      [onTap, cancelLongPress],
    );

    // System-interrupted gesture: drop everything cleanly (no phantom tap or stuck build).
    const onTouchCancel = useCallback(() => {
      cancelLongPress();
      buildDragRef.current.active = false;
      buildDragRef.current.visited.clear();
      panRef.current.dragging = false;
      pinchRef.current.active = false;
    }, [cancelLongPress]);

    return (
      <canvas
        ref={canvasRef}
        style={{
          display: "block",
          width: "100%",
          height: "100%",
          cursor: "crosshair",
          touchAction: "none",
        }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseLeave}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchCancel}
      />
    );
  },
);

function touchDist(a: React.Touch, b: React.Touch): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

// Spawn a falling-leaf particle at a shed cell's world position, with a little randomized
// drift, spin, and lifetime so a canopy drop scatters naturally rather than dropping in a
// rigid sheet. Coloured by the cell so a fruit/flower falls in its own hue.
function spawnParticle(cell: Cell, now: number): LeafParticle {
  const { x, y } = hexToPixel(cell.q, cell.r, BASE_RADIUS);
  return {
    x,
    y,
    vx: (Math.random() - 0.5) * 0.02,
    vy: 0.008 + Math.random() * 0.012,
    rot: Math.random() * Math.PI * 2,
    vrot: (Math.random() - 0.5) * 0.006,
    phase: Math.random() * Math.PI * 2,
    born: now,
    life: 1100 + Math.random() * 700,
    color: cellColor(cell),
    size: BASE_RADIUS * 0.5,
  };
}

// Advance and draw the falling-leaf particles, removing any that have expired. Mutates the
// array in place (splicing dead ones). Particles fall under gravity with a gentle sine
// flutter and fade out over the back 40% of their life.
function drawParticles(
  ctx: CanvasRenderingContext2D,
  list: LeafParticle[],
  now: number,
  dt: number,
  cam: Camera,
  width: number,
  height: number,
): void {
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    const age = now - p.born;
    if (age >= p.life) {
      list.splice(i, 1);
      continue;
    }
    p.vy += PARTICLE_GRAVITY * dt;
    p.x += p.vx * dt + Math.sin(age * 0.006 + p.phase) * 0.004 * dt; // flutter
    p.y += p.vy * dt;
    p.rot += p.vrot * dt;

    const { sx, sy } = worldToScreen(p.x, p.y, cam, width, height);
    if (sx < -20 || sx > width + 20 || sy < -20 || sy > height + 20) continue;

    const fadeStart = p.life * 0.6;
    const fade =
      age > fadeStart ? 1 - (age - fadeStart) / (p.life - fadeStart) : 1;
    const s = p.size * cam.zoom;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(p.rot);
    ctx.globalAlpha = Math.max(0, fade);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.ellipse(0, 0, s * 0.7, s * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}
