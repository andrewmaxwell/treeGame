import styles from "./HUD.module.css";
import type { PlacementMode } from "../game/planning";
import type { Season } from "../game/state";
import type { ResourceOverlay } from "../render/colors";

export interface ForecastDisplay {
  monthRange: string; // "Mar–May"
  weatherIcon: string; // this season's exact conditions
  weatherLabel: string;
  nextSeasonLabel: string; // "Summer"
  nextSeasonMeaning: string; // what that season means for the tree ("peak sun, water stress")
  nextForecast: string; // reliable general forecast
}

interface HUDProps {
  energyRemaining: number;
  energyTotal: number;
  season: Season;
  seasonHalf: 0 | 1; // which half of the season is being planned (mid-season checkpoint)
  year: number;
  score: number;
  forecast: ForecastDisplay;
  currentGoal: string | null; // current objective text
  completedGoals: number; // for the goal-log button badge
  showNudge: boolean; // gentle unspent-energy nudge
  springReLeaf: boolean; // spring + leaves actually dropped → prompt to regrow
  flowerNoSpots: boolean; // flower mode active but nowhere valid to bloom
  mode: PlacementMode;
  flowerUnlocked: boolean; // spring + 30-cell milestone → show the Flower toggle
  canAdvance: boolean;
  isPlaying: boolean;
  playbackProgress: number; // 0–1
  playbackStats: { water: number; energy: number } | null; // live totals during playback
  overlay: ResourceOverlay; // active resource-flow view
  onOverlayChange: (o: ResourceOverlay) => void;
  pruneMode: boolean; // bulk-prune selection active
  pruneCount: number; // cells the current selection would remove
  pruneCost: number; // energy cost to seal those wounds
  pruneRemovesAll: boolean; // selection would wipe out the whole tree → blocked
  onTogglePrune: () => void;
  onConfirmPrune: () => void;
  onModeChange: (m: PlacementMode) => void;
  onAdvanceSeason: () => void;
  onSkip: () => void;
  onOpenGoals: () => void;
  onNewGame: () => void;
  onHelp: () => void;
}

const SEASON_LABEL: Record<Season, string> = {
  spring: "Spring",
  summer: "Summer",
  fall: "Fall",
  winter: "Winter",
};

export function HUD({
  energyRemaining,
  energyTotal,
  season,
  seasonHalf,
  year,
  score,
  forecast,
  currentGoal,
  completedGoals,
  showNudge,
  springReLeaf,
  flowerNoSpots,
  mode,
  flowerUnlocked,
  canAdvance,
  isPlaying,
  playbackProgress,
  playbackStats,
  overlay,
  pruneMode,
  pruneCount,
  pruneCost,
  pruneRemovesAll,
  onOverlayChange,
  onTogglePrune,
  onConfirmPrune,
  onModeChange,
  onAdvanceSeason,
  onSkip,
  onOpenGoals,
  onNewGame,
  onHelp,
}: HUDProps) {
  const energy = Math.floor(energyRemaining);
  const total = Math.floor(energyTotal);
  const energyLow = energy <= 0;

  return (
    <div className={styles.hud}>
      {/* Top group — pinned to the top of the screen */}
      <div className={styles.topGroup}>
        {/* Top bar — two rows on mobile */}
        <div className={styles.topBar}>
          <div className={styles.topRow}>
            <div className={styles.seasonBlock}>
              <span className={styles.season}>
                {SEASON_LABEL[season]}, Year {year}
              </span>
              <span className={styles.months}>
                {forecast.monthRange} ·{" "}
                {seasonHalf === 0 ? "first half" : "second half"}
              </span>
            </div>
            <div className={styles.rightBlock}>
              <span className={styles.score}>🌰 {score}</span>
              <button
                className={styles.goalsBtn}
                onClick={onOpenGoals}
                title="Goals achieved"
              >
                🏅 {completedGoals}
              </button>
              <button
                className={styles.iconBtn}
                onClick={onHelp}
                title="How to play"
              >
                ?
              </button>
              <button
                className={`${styles.iconBtn} ${styles.iconBtnReload}`}
                onClick={onNewGame}
                title="Plant a new seed (restart)"
              >
                ⟳
              </button>
            </div>
          </div>
          {/* Weather row — current + next in one line; overlay toggles pushed to the right */}
          <div
            className={styles.weatherRow}
            title={`Forecast: ${forecast.nextForecast}`}
          >
            <span className={styles.weatherNow}>
              {forecast.weatherIcon} {forecast.weatherLabel}
            </span>
            <span className={styles.weatherSep}>→ Next:</span>
            <span className={styles.weatherNext}>
              <b>{forecast.nextSeasonLabel}</b> · {forecast.nextSeasonMeaning}
            </span>
            <div className={styles.overlayToggle}>
              <button
                className={`${styles.overlayBtn} ${overlay === "water" ? styles.overlayBtnWater : ""}`}
                onClick={() =>
                  onOverlayChange(overlay === "water" ? "none" : "water")
                }
                title="Water view — see moisture in the soil and water climbing the tree"
              >
                💧
              </button>
              <button
                className={`${styles.overlayBtn} ${overlay === "energy" ? styles.overlayBtnEnergy : ""}`}
                onClick={() =>
                  onOverlayChange(overlay === "energy" ? "none" : "energy")
                }
                title="Energy view — see where sugar is made and where it pools"
              >
                ⚡
              </button>
            </div>
          </div>
        </div>

        {/* Current objective — always visible during planning */}
        {!isPlaying && currentGoal && (
          <button className={styles.goalBar} onClick={onOpenGoals}>
            <span className={styles.goalIcon}>🎯</span> {currentGoal}
          </button>
        )}

        {/* Playback progress bar + live tree totals — only visible during simulation */}
        {isPlaying && (
          <>
            {playbackStats && (
              <div className={styles.playStats}>
                <span title="Total water held across the tree (rises with rain/roots, falls with transpiration)">
                  💧 {Math.round(playbackStats.water)}
                </span>
                <span title="Total energy held across the tree (rises with photosynthesis, falls with metabolism)">
                  ⚡ {Math.round(playbackStats.energy)}
                </span>
              </div>
            )}
            <div className={styles.progressTrack}>
              <div
                className={styles.progressBar}
                style={{ width: `${playbackProgress * 100}%` }}
              />
            </div>
          </>
        )}
      </div>

      {/* Bottom group — contextual hints sit just above the controls, off the tree */}
      <div className={styles.bottomGroup}>
        {/* Winter planning guidance */}
        {!isPlaying && season === "winter" && (
          <div className={styles.warning}>
            ❄️ Winter: extend <b>roots</b> underground (they're insulated) and{" "}
            <b>prune</b> deadwood or red over-stressed limbs (free if
            dead/dying). Above-ground growth dies at frost. Then{" "}
            <b>Advance Season</b> to ride out the cold.
          </div>
        )}

        {/* Flower mode but nowhere to bloom — the #1 flower confusion. */}
        {!isPlaying && flowerNoSpots && (
          <div className={styles.springHint}>
            🌸 Nowhere to bloom yet — flowers need a <b>healthy branch</b> (over
            60%, not greyed) with an open or leafy hex beside it. Grow or heal
            your canopy first.
          </div>
        )}

        {/* Spring re-leaf reassurance — the canopy regrows on its own now */}
        {!isPlaying && springReLeaf && (
          <div className={styles.springHint}>
            🌱 Your canopy will <b>regrow automatically</b> this spring on the
            sunniest spots (shown in faint green). Just shape your <b>wood</b> —
            and bloom <b>flowers</b> if you like.
          </div>
        )}

        {/* Fall: explain the automatic canopy drop + warn against overspending */}
        {!isPlaying && season === "fall" && (
          <div className={styles.reserveHint}>
            🍂 Your whole canopy drops automatically at fall's end, banking ~75%
            of its energy back into the wood. Winter ahead is dormant — keep
            some energy in reserve to live on until spring.
          </div>
        )}

        {/* Gentle unspent-energy nudge (early years, growth seasons only) */}
        {!isPlaying && showNudge && (
          <div className={styles.nudge}>
            You have energy to spare — extend your roots or branches before
            advancing.
          </div>
        )}

        {/* Bottom bar */}
        <div className={styles.bottomBar}>
          {isPlaying ? (
            <>
              <span className={styles.playingLabel}>Simulating…</span>
              <button className={styles.skipBtn} onClick={onSkip}>
                Skip →
              </button>
            </>
          ) : pruneMode ? (
            <>
              <span
                className={`${styles.energy} ${energyLow ? styles.energyLow : ""}`}
              >
                ⚡ {energy} / {total}
              </span>
              <span className={styles.pruneHint}>
                {pruneRemovesAll
                  ? "⚠️ That's your whole tree — deselect some"
                  : "✂️ Tap limbs to prune"}
              </span>
              <button className={styles.pruneCancelBtn} onClick={onTogglePrune}>
                Done
              </button>
              <button
                className={styles.pruneConfirmBtn}
                onClick={onConfirmPrune}
                disabled={
                  pruneCount === 0 || pruneRemovesAll || pruneCost > energy
                }
                title={
                  pruneRemovesAll
                    ? "Can't prune your whole tree"
                    : pruneCost > energy
                      ? "Not enough energy to seal the wounds"
                      : undefined
                }
              >
                Prune {pruneCount} {pruneCount === 1 ? "cell" : "cells"}
                {pruneCost > 0 && (
                  <span className={styles.pruneConfirmCost}>
                    {" "}
                    ⚡{pruneCost}
                  </span>
                )}
              </button>
            </>
          ) : (
            <>
              <span
                className={`${styles.energy} ${energyLow ? styles.energyLow : ""}`}
              >
                ⚡ {energy} / {total}
              </span>

              {/* Leaves auto-grow on well-lit canopy hexes — the player only shapes wood
                  (and flowers in spring). The toggle appears only once flowers unlock,
                  since otherwise everything you place is wood. */}
              {flowerUnlocked && (
                <div className={styles.modeToggle}>
                  <button
                    className={`${styles.modeBtn} ${mode === "branch" ? styles.modeBtnActive : ""}`}
                    onClick={() => onModeChange("branch")}
                    title="Grow woody cells: roots below ground, trunk/branches above"
                  >
                    {mode === "branch" ? "● " : ""}Wood
                  </button>
                  <button
                    className={`${styles.modeBtn} ${mode === "flower" ? styles.modeBtnActive : ""}`}
                    onClick={() => onModeChange("flower")}
                    title="Bloom flowers on healthy branches (3⚡ each, spring only) — they set fruit for seeds"
                  >
                    {mode === "flower" ? "● " : ""}Flower
                  </button>
                </div>
              )}

              <button
                className={styles.pruneToggleBtn}
                onClick={onTogglePrune}
                title="Prune several limbs at once — tap each to select, then confirm"
              >
                ✂️ Prune
              </button>

              <button
                className={styles.advanceBtn}
                onClick={onAdvanceSeason}
                disabled={!canAdvance}
                title={canAdvance ? undefined : "Fix disconnected growth first"}
              >
                {seasonHalf === 0
                  ? "Advance to mid-season →"
                  : "Advance to next season →"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
