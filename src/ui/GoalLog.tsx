import styles from './GoalLog.module.css'
import { MILESTONES, type Milestone } from '../game/goals'

interface Props {
  completed: Milestone[]      // in completion order
  currentGoalId: string | null
  onClose: () => void
}

export function GoalLog({ completed, currentGoalId, onClose }: Props) {
  const completedIds = new Set(completed.map((m) => m.id))

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <span className={styles.title}>Milestones</span>
          <button className={styles.close} onClick={onClose} aria-label="Close">×</button>
        </div>

        <ul className={styles.list}>
          {completed.map((m) => (
            <li key={m.id} className={styles.done}>
              <span className={styles.check}>✓</span>
              <span className={styles.text}>{m.log}</span>
            </li>
          ))}

          {/* Only the current objective is revealed; later milestones stay secret. */}
          {(() => {
            const next = MILESTONES.find((m) => !completedIds.has(m.id))
            if (!next) return null
            return (
              <li className={styles.current}>
                <span className={styles.dot}>🎯</span>
                <span className={styles.text}>{next.goal}</span>
              </li>
            )
          })()}
          {currentGoalId && (
            <li className={styles.locked}>
              <span className={styles.dot}>·</span>
              <span className={styles.text}>More milestones await…</span>
            </li>
          )}
        </ul>

        {completed.length === 0 && (
          <p className={styles.empty}>No milestones yet — your tree's story starts here.</p>
        )}
      </div>
    </div>
  )
}
