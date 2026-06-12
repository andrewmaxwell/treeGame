import styles from './HUD.module.css'
import type { PlacementMode } from '../game/planning'
import type { Season } from '../game/state'

interface HUDProps {
  energyRemaining: number
  energyTotal: number
  season: Season
  year: number
  mode: PlacementMode
  canAdvance: boolean
  isPlaying: boolean
  playbackProgress: number  // 0–1
  onModeChange: (m: PlacementMode) => void
  onAdvanceSeason: () => void
  onSkip: () => void
}

const SEASON_LABEL: Record<Season, string> = {
  spring: 'Spring',
  summer: 'Summer',
  fall:   'Fall',
  winter: 'Winter',
}

export function HUD({
  energyRemaining, energyTotal, season, year, mode, canAdvance,
  isPlaying, playbackProgress,
  onModeChange, onAdvanceSeason, onSkip,
}: HUDProps) {
  const energy = Math.floor(energyRemaining)
  const total = Math.floor(energyTotal)
  const energyLow = energy <= 0

  return (
    <div className={styles.hud}>
      {/* Top bar */}
      <div className={styles.topBar}>
        <span className={styles.season}>{SEASON_LABEL[season]}, Year {year}</span>
        <span className={styles.score}>🌰 0</span>
      </div>

      {/* Playback progress bar — only visible during simulation */}
      {isPlaying && (
        <div className={styles.progressTrack}>
          <div className={styles.progressBar} style={{ width: `${playbackProgress * 100}%` }} />
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
              >
                Branch
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
