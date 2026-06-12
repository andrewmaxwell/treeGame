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
  fallReserveHint: boolean     // fall + low reserves → warn to bank energy for winter
  shedInfo: { count: number; energy: number } | null  // fall: feedback on marked-shed leaves
  mode: PlacementMode
  canAdvance: boolean
  isPlaying: boolean
  playbackProgress: number  // 0–1
  onModeChange: (m: PlacementMode) => void
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
  currentGoal, completedGoals, showNudge, springReLeaf, fallReserveHint, shedInfo, mode, canAdvance,
  isPlaying, playbackProgress,
  onModeChange, onAdvanceSeason, onSkip, onOpenGoals, onNewGame, onHelp,
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
          <button className={styles.iconBtn} onClick={onNewGame} title="Plant a new seed (restart)">⟳</button>
        </div>
      </div>

      {/* Current objective — always visible during planning */}
      {!isPlaying && currentGoal && (
        <button className={styles.goalBar} onClick={onOpenGoals}>
          <span className={styles.goalIcon}>🎯</span> {currentGoal}
        </button>
      )}

      {/* Playback progress bar — only visible during simulation */}
      {isPlaying && (
        <div className={styles.progressTrack}>
          <div className={styles.progressBar} style={{ width: `${playbackProgress * 100}%` }} />
        </div>
      )}
      </div>

      {/* Bottom group — contextual hints sit just above the controls, off the tree */}
      <div className={styles.bottomGroup}>
        {/* Winter planning guidance */}
        {!isPlaying && season === 'winter' && (
          <div className={styles.warning}>
            ❄️ Winter is for pruning &amp; reshaping — new growth dies at frost. Tidy up if you like, then just <b>Advance Season</b> to ride out the cold.
          </div>
        )}

        {/* Spring re-leaf guidance — only when leaves actually dropped over winter */}
        {!isPlaying && springReLeaf && (
          <div className={styles.springHint}>
            🌱 Your leaves dropped over winter. Switch to <b>Leaf</b> mode and grow a new canopy to restart photosynthesis.
          </div>
        )}

        {/* Fall: warn against overspending before the dormant winter */}
        {!isPlaying && fallReserveHint && (
          <div className={styles.reserveHint}>
            🍂 Winter ahead is dormant — your tree lives on banked energy until spring. Keep some in reserve.
          </div>
        )}

        {/* Fall: shedding feedback — make the resorption benefit visible */}
        {!isPlaying && shedInfo && shedInfo.count > 0 && (
          <div className={styles.shedHint}>
            🍂 Shedding {shedInfo.count} {shedInfo.count === 1 ? 'leaf' : 'leaves'} now banks ~{Math.round(shedInfo.energy)} energy for spring. Left on, winter frost wastes most of it.
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
    </div>
  )
}
