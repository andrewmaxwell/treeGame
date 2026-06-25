import { useState, useEffect } from 'react'
import styles from './Inspector.module.css'
import type { Cell } from '../sim/cells'
import { CELL_WATER_CAP, CELL_ENERGY_CAP, SOIL_WATER_CAP } from '../sim/cells'
import { surfaceR } from '../sim/terrain'

interface Props {
  cell: Cell
  removalCount: number   // total cells removed if this one is pruned (incl. itself)
  cost: number           // energy cost to prune (0 if dead/dying/rotted)
  affordable: boolean
  seversCanopy: boolean  // pruning would cut the whole canopy from the roots
  removesAll: boolean    // pruning would wipe out the whole tree → blocked
  pruneable: boolean     // false for leaves (auto-managed) and terrain — no prune button
  stress?: number        // structural stress (load/strength) for wood cells; else undefined
  onPrune: () => void
  onClose: () => void
}

// Mirrors the renderer's red-tint warning line: at/above this, the cell is a storm risk.
const STRESS_WARN = 0.8

const TYPE_LABEL: Record<Cell['type'], string> = {
  tree: 'Wood', 'reenforced wood': 'Reinforced wood', leaf: 'Leaf', flower: 'Flower', fruit: 'Fruit',
  deadwood: 'Deadwood', soil: 'Soil', rock: 'Rock', 'ground water': 'Ground water',
}

function woodLabel(cell: Cell): string {
  return cell.r >= surfaceR(cell.q) ? 'Root' : 'Branch'
}

// Plain-language status — the whole point is to make "why is this cell gray?"
// legible without the player decoding the color map.
function status(cell: Cell): { text: string; tone: 'good' | 'warn' | 'bad' } {
  if (cell.type === 'deadwood') return { text: 'Dead wood — still bears load', tone: 'warn' }
  if (cell.rot > 0) return { text: 'Rotting', tone: 'bad' }
  if (cell.health < 0.3) return { text: 'Dying', tone: 'bad' }
  const dryish = cell.water < 3
  // Wood (trunk + roots) is structural — its health rides on WATER alone. Its energy is
  // just stored growth currency, so a root at energy 0 is fine; don't flag it as starved.
  if (cell.type === 'tree') {
    if (dryish) return { text: 'Water-stressed', tone: 'warn' }
    if (cell.health > 0.9) return { text: 'Thriving', tone: 'good' }
    return { text: 'Recovering', tone: 'warn' }
  }
  const starved = cell.energy < 2
  if (dryish && starved) return { text: 'Starving and parched', tone: 'bad' }
  if (dryish) return { text: 'Water-stressed', tone: 'warn' }
  if (starved) return { text: 'Low on energy', tone: 'warn' }
  if (cell.health > 0.9) return { text: 'Thriving', tone: 'good' }
  return { text: 'Recovering', tone: 'warn' }
}

export function Inspector({ cell, removalCount, cost, affordable, seversCanopy, removesAll, pruneable, stress, onPrune, onClose }: Props) {
  // Two-step confirm only when severing the whole canopy.
  const [confirming, setConfirming] = useState(false)
  useEffect(() => { setConfirming(false) }, [cell])

  const isTerrain = cell.type === 'soil' || cell.type === 'rock' || cell.type === 'ground water'
  const waterCap = cell.type === 'soil' ? SOIL_WATER_CAP : CELL_WATER_CAP
  const st = status(cell)

  const typeName = cell.type === 'tree' ? woodLabel(cell) : TYPE_LABEL[cell.type]
  const canPrune = !isTerrain && !removesAll && (cost === 0 || affordable)

  const pruneLabel = removalCount > 1
    ? `Prune — ${removalCount} cells removed`
    : 'Prune'

  function handlePrune() {
    if (seversCanopy && !confirming) { setConfirming(true); return }
    onPrune()
  }

  return (
    <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
      <div className={styles.header}>
        <span className={styles.title}>{typeName}</span>
        <button className={styles.close} onClick={onClose} aria-label="Close">×</button>
      </div>

      {!isTerrain && <div className={`${styles.status} ${styles[st.tone]}`}>{st.text}</div>}

      <div className={styles.rows}>
        <Row label="Water"  value={`${cell.water.toFixed(1)} / ${waterCap}`} />
        {cell.type !== 'soil' && <Row label="Energy" value={`${cell.energy.toFixed(1)} / ${CELL_ENERGY_CAP}`} />}
        {!isTerrain && <Row label="Health" value={`${Math.round(cell.health * 100)}%`} />}
        {!isTerrain && cell.rot > 0 && <Row label="Rot" value={`${Math.round(cell.rot * 100)}%`} />}
        {stress !== undefined && (
          <Row
            label="Load stress"
            value={stress > STRESS_WARN ? `${stress.toFixed(1)}× — storm risk` : `${stress.toFixed(1)}×`}
          />
        )}
        {stress !== undefined && stress > STRESS_WARN && (
          <p className={styles.hint}>
            A one-sided limb bends hardest here. Widen the trunk <em>at this row</em>, shorten
            the heavy branch, or balance it with growth on the opposite side.
          </p>
        )}
        {!isTerrain && <Row label="Age" value={`${cell.age} ${cell.age === 1 ? 'season' : 'seasons'}`} />}
      </div>

      {!isTerrain && cell.type === 'leaf' && (
        <p className={styles.hint}>Leaves grow and fall on their own — no need to prune them.</p>
      )}

      {pruneable && (
        <>
          {removesAll && (
            <div className={styles.warnLine}>This is your whole tree — prune something smaller, or "Plant a new seed" to start over.</div>
          )}
          {seversCanopy && confirming && (
            <div className={styles.warnLine}>This removes your whole canopy. Tap again to confirm.</div>
          )}
          <button
            className={`${styles.prune} ${confirming ? styles.pruneDanger : ''}`}
            onClick={handlePrune}
            disabled={!canPrune}
            title={removesAll ? "Can't prune your whole tree" : !canPrune ? 'Not enough energy to seal the wound' : undefined}
          >
            {confirming ? 'Confirm prune' : pruneLabel}
            {cost > 0 && <span className={styles.cost}>⚡{cost}</span>}
            {cost === 0 && !confirming && <span className={styles.free}>free</span>}
          </button>
        </>
      )}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <span className={styles.rowValue}>{value}</span>
    </div>
  )
}
