import styles from './HUD.module.css'
import type { PlacementMode } from '../game/planning'
import type { Season } from '../game/state'

export interface ForecastDisplay {
  monthRange: string      // "Mar–May"
  weatherIcon: string     // this season's exact conditions
  weatherLabel: string
  nextSeasonLabel: string // "Summer"
  nextForecast: string    // reliable general forecast
}

interface HUDProps {
  energyRemaining: number
  energyTotal: number
  season: Season
  year: number
  score: number
  forecast: ForecastDisplay
  currentGoal: string | null   // current objective text
  completedGoals: number       // for the goal-log button badge
  showNudge: boolean           // gentle unspent-energy nudge
  springReLeaf: boolean        // spring + leaves actually dropped → prompt to regrow
  flowerNoSpots: boolean       // flower mode active but nowhere valid to bloom
  mode: PlacementMode
  flowerUnlocked: boolean       // spring + 30-cell milestone → show the Flower toggle
  canAdvance: boolean
  isPlaying: boolean
  playbackProgress: number  // 0–1
  playbackStats: { water: number; energy: number } | null  // live totals during playback
  onModeChange: (m: PlacementMode) => void
  onAutoLeaf: () => void
  onAdvanceSeason: () => void
  onSkip: () => void
  onOpenGoals: () => void
  onNewGame: () => void
  onHelp: () => void
}

const SEASON_LABEL: Record<Season, string> = {
  spring: 'Spring',
  summer: 'Summer',
  fall:   'Fall',
  winter: 'Winter',
}

export function HUD({
  energyRemaining, energyTotal, season, year, score, forecast,
  currentGoal, completedGoals, showNudge, springReLeaf, flowerNoSpots, mode, flowerUnlocked, canAdvance,
  isPlaying, playbackProgress, playbackStats,
  onModeChange, onAutoLeaf, onAdvanceSeason, onSkip, onOpenGoals, onNewGame, onHelp,
}: HUDProps) {
  const energy = Math.floor(energyRemaining)
  const total = Math.floor(energyTotal)
  const energyLow = energy <= 0

  return (
    <div className={styles.hud}>
      {/* Top group — pinned to the top of the screen */}
      <div className={styles.topGroup}>
      {/* Top bar */}
      <div className={styles.topBar}>
        <div className={styles.seasonBlock}>
          <span className={styles.season}>{SEASON_LABEL[season]}, Year {year}</span>
          <span className={styles.months}>{forecast.monthRange}</span>
        </div>
        <div className={styles.weatherBlock}>
          <span className={styles.weatherNow} title="This season">
            {forecast.weatherIcon} {forecast.weatherLabel}
          </span>
          <span className={styles.weatherNext} title="Next season (forecast)">
            Next: {forecast.nextSeasonLabel} · {forecast.nextForecast}
          </span>
        </div>
        <div className={styles.rightBlock}>
          <span className={styles.score}>🌰 {score}</span>
          <button className={styles.goalsBtn} onClick={onOpenGoals} title="Goals achieved">
            🏅 {completedGoals}
          </button>
          <button className={styles.iconBtn} onClick={onHelp} title="How to play">?</button>
          <button className={`${styles.iconBtn} ${styles.iconBtnReload}`} onClick={onNewGame} title="Plant a new seed (restart)">⟳</button>
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
            <div className={styles.progressBar} style={{ width: `${playbackProgress * 100}%` }} />
          </div>
        </>
      )}
      </div>

      {/* Bottom group — contextual hints sit just above the controls, off the tree */}
      <div className={styles.bottomGroup}>
        {/* Winter planning guidance */}
        {!isPlaying && season === 'winter' && (
          <div className={styles.warning}>
            ❄️ Winter: extend <b>roots</b> underground (they're insulated) and <b>prune</b> deadwood or red over-stressed limbs (free if dead/dying). Above-ground growth dies at frost. Then <b>Advance Season</b> to ride out the cold.
          </div>
        )}

        {/* Flower mode but nowhere to bloom — the #1 flower confusion. */}
        {!isPlaying && flowerNoSpots && (
          <div className={styles.springHint}>
            🌸 Nowhere to bloom yet — flowers need a <b>healthy branch</b> (over 60%, not greyed) with an open or leafy hex beside it. Grow or heal your canopy first.
          </div>
        )}

        {/* Spring re-leaf guidance — only when leaves actually dropped over winter */}
        {!isPlaying && springReLeaf && (
          <div className={styles.springHint}>
            🌱 Your leaves dropped over winter. Switch to <b>Leaf</b> mode and grow a new canopy to restart photosynthesis.
          </div>
        )}

        {/* Fall: explain the automatic canopy drop + warn against overspending */}
        {!isPlaying && season === 'fall' && (
          <div className={styles.reserveHint}>
            🍂 Your whole canopy drops automatically at fall's end, banking ~75% of its energy back into the wood. Winter ahead is dormant — keep some energy in reserve to live on until spring.
          </div>
        )}

        {/* Gentle unspent-energy nudge (early years, growth seasons only) */}
        {!isPlaying && showNudge && (
          <div className={styles.nudge}>
            You have energy to spare — grow some roots or leaves before advancing.
          </div>
        )}

        {/* Bottom bar */}
        <div className={styles.bottomBar}>
          {isPlaying ? (
            <>
              <span className={styles.playingLabel}>Simulating…</span>
              <button className={styles.skipBtn} onClick={onSkip}>Skip →</button>
            </>
          ) : (
            <>
              <span className={`${styles.energy} ${energyLow ? styles.energyLow : ''}`}>
                ⚡ {energy} / {total}
              </span>

              <div className={styles.modeToggle}>
                <button
                  className={`${styles.modeBtn} ${mode === 'branch' ? styles.modeBtnActive : ''}`}
                  onClick={() => onModeChange('branch')}
                  title="Grow woody cells: roots below ground, trunk/branches above"
                >
                  {mode === 'branch' ? '● ' : ''}Wood
                </button>
                <button
                  className={`${styles.modeBtn} ${mode === 'leaf' ? styles.modeBtnActive : ''}`}
                  onClick={() => onModeChange('leaf')}
                  title="Grow leaves above ground (they photosynthesize)"
                >
                  {mode === 'leaf' ? '● ' : ''}Leaf
                </button>
                {flowerUnlocked && (
                  <button
                    className={`${styles.modeBtn} ${mode === 'flower' ? styles.modeBtnActive : ''}`}
                    onClick={() => onModeChange('flower')}
                    title="Bloom flowers on healthy branch tips (3⚡ each, spring only) — they set fruit for seeds"
                  >
                    {mode === 'flower' ? '● ' : ''}Flower
                  </button>
                )}
              </div>

              {season !== 'winter' && (
                <button
                  className={styles.autoLeafBtn}
                  onClick={onAutoLeaf}
                  title="Fill the open canopy with leaves automatically (spends your full budget in spring/summer; keeps a small reserve in fall)"
                >
                  🍃 Fill leaves
                </button>
              )}

              <button
                className={styles.advanceBtn}
                onClick={onAdvanceSeason}
                disabled={!canAdvance}
                title={canAdvance ? undefined : 'Fix disconnected growth first'}
              >
                Advance Season →
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
