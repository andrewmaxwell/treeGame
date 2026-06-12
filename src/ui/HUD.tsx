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
  springReLeaf: boolean        // spring + no leaves → prompt to regrow the canopy
  mode: PlacementMode
  canAdvance: boolean
  isPlaying: boolean
  playbackProgress: number  // 0–1
  onModeChange: (m: PlacementMode) => void
  onAdvanceSeason: () => void
  onSkip: () => void
  onOpenGoals: () => void
}

const SEASON_LABEL: Record<Season, string> = {
  spring: 'Spring',
  summer: 'Summer',
  fall:   'Fall',
  winter: 'Winter',
}

export function HUD({
  energyRemaining, energyTotal, season, year, score, forecast,
  currentGoal, completedGoals, showNudge, springReLeaf, mode, canAdvance,
  isPlaying, playbackProgress,
  onModeChange, onAdvanceSeason, onSkip, onOpenGoals,
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
        </div>
      </div>

      {/* Current objective — always visible during planning */}
      {!isPlaying && currentGoal && (
        <button className={styles.goalBar} onClick={onOpenGoals}>
          <span className={styles.goalIcon}>🎯</span> {currentGoal}
        </button>
      )}

      {/* Winter planting warning */}
      {!isPlaying && season === 'winter' && (
        <div className={styles.warning}>
          ❄️ Frost ahead — anything you plant now will die at winter's first frost.
        </div>
      )}

      {/* Spring re-leaf guidance — the deciduous cycle's most confusing moment */}
      {!isPlaying && springReLeaf && (
        <div className={styles.springHint}>
          🌱 Spring! Your leaves dropped over winter — switch to <b>Leaf</b> mode and grow a new canopy to restart photosynthesis.
        </div>
      )}

      {/* Gentle unspent-energy nudge (early years, growth seasons only) */}
      {!isPlaying && showNudge && (
        <div className={styles.nudge}>
          You have energy to spare — grow some roots or leaves before advancing.
        </div>
      )}

      {/* Playback progress bar — only visible during simulation */}
      {isPlaying && (
        <div className={styles.progressTrack}>
          <div className={styles.progressBar} style={{ width: `${playbackProgress * 100}%` }} />
        </div>
      )}
      </div>

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
                Wood
              </button>
              <button
                className={`${styles.modeBtn} ${mode === 'leaf' ? styles.modeBtnActive : ''}`}
                onClick={() => onModeChange('leaf')}
              >
                Leaf
              </button>
            </div>

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
  )
}
