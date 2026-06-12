import styles from './SeasonSummary.module.css'
import type { SeasonSummaryData } from '../game/summary'
import type { Season } from '../game/state'

const SEASON_LABEL: Record<Season, string> = {
  spring: 'Spring',
  summer: 'Summer',
  fall:   'Fall',
  winter: 'Winter',
}

interface Props {
  data: SeasonSummaryData
  onDismiss: () => void
}

export function SeasonSummary({ data, onDismiss }: Props) {
  const energyDelta = data.energyEnd - data.energyStart
  const energySign = energyDelta >= 0 ? '+' : '−'

  return (
    <div className={styles.overlay} onClick={onDismiss}>
      <div className={styles.card} onClick={(e) => e.stopPropagation()}>
        <div className={styles.title}>
          {SEASON_LABEL[data.season]}, Year {data.year}
        </div>
        <div className={styles.subtitle}>Season complete</div>

        {data.events.length > 0 && (
          <ul className={styles.events}>
            {data.events.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        )}

        <div className={styles.stats}>
          <Stat label="Energy" value={`${Math.floor(data.energyStart)} → ${Math.floor(data.energyEnd)}`}
                detail={`${energySign}${Math.abs(Math.round(energyDelta))}`} />
          <Stat label="Living cells" value={`${data.cellsStart} → ${data.cellsEnd}`}
                detail={data.cellsLost > 0 ? `−${data.cellsLost}` : data.cellsGained > 0 ? `+${data.cellsGained}` : '—'} />
          <Stat label="Water" value={data.waterStatus} />
        </div>

        <button className={styles.dismiss} onClick={onDismiss}>Continue →</button>
      </div>
    </div>
  )
}

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className={styles.statRow}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{value}</span>
      {detail && <span className={styles.statDetail}>{detail}</span>}
    </div>
  )
}
