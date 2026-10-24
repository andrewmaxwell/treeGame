import { useEffect, useRef, useState } from "react";
import styles from "./Memorial.module.css";
import type { Cell } from "../sim/cells";
import { hexToPixel, hexKey } from "../sim/grid";
import { surfaceR } from "../sim/terrain";
import { drawOrganicTree, type PlacedCell } from "../render/organic";
import {
  formatAge,
  eulogy,
  worldUrl,
  challengeText,
  type RunRecord,
} from "../game/memorial";

interface Props {
  record: RunRecord;
  hall: RunRecord[]; // best runs including this one, best first
  rank: number | null; // this run's place in `hall`, null if it didn't make it
  cells: Map<string, Cell>;
  onReplant: () => void;
  onKeepGrowing: () => void;
}

// The end of a run: the tree's silhouette, a line about its life, its numbers, and the
// hall of best runs. Shown when the player chooses "Plant a new seed".
export function Memorial({
  record,
  hall,
  rank,
  cells,
  onReplant,
  onKeepGrowing,
}: Props) {
  return (
    <div className={styles.overlay} onClick={onKeepGrowing}>
      <div className={styles.card} onClick={(e) => e.stopPropagation()}>
        <Silhouette cells={cells} />
        <div className={styles.title}>In memory of your tree</div>
        <p className={styles.eulogy}>{eulogy(record)}</p>

        <div className={styles.stats}>
          <Stat label="Lifetime seeds" value={`🌰 ${record.seeds}`} />
          <Stat
            label="Best year"
            value={
              record.bestYear
                ? `Year ${record.bestYear.year} · ${record.bestYear.seeds} 🌰`
                : record.seeds > 0
                  ? "not tracked (older save)"
                  : "—"
            }
          />
          <Stat label="Age" value={formatAge(record.halfSeasons)} />
          <Stat label="Peak size" value={`${record.peakCells} cells`} />
          <Stat label="Milestones" value={`🏅 ${record.milestones}`} />
          {record.world !== undefined && (
            <Stat label="World" value={`🌍 ${record.world}`} />
          )}
        </div>
        {record.world !== undefined && <Challenge record={record} />}

        <div className={styles.hallTitle}>
          Best runs
          {rank === 0 && hall.length > 1 && (
            <span className={styles.newBest}> · a new best!</span>
          )}
        </div>
        <ol className={styles.hall}>
          {hall.map((r, i) => (
            <li key={i} className={i === rank ? styles.thisRun : undefined}>
              <span className={styles.hallSeeds}>🌰 {r.seeds}</span>
              <span className={styles.hallAge}>{formatAge(r.halfSeasons)}</span>
              <span className={styles.hallDate}>
                {i === rank ? "this tree" : r.date}
                {r.world !== undefined && r.world < 100000 && ` · W${r.world}`}
              </span>
            </li>
          ))}
        </ol>
        {rank === null && (
          <p className={styles.missed}>
            This tree didn't make your top {hall.length}.
          </p>
        )}

        <button className={styles.replant} onClick={onReplant}>
          🌱 Plant a new seed
        </button>
        <button className={styles.keep} onClick={onKeepGrowing}>
          Keep growing this one
        </button>
      </div>
    </div>
  );
}

// Send a friend to this world with the score to beat: the share sheet on phones, the
// clipboard elsewhere. Says what happened, including when neither is available.
function Challenge({ record }: { record: RunRecord }) {
  const [status, setStatus] = useState<string | null>(null);
  const onClick = async () => {
    const url = worldUrl(
      record.world!,
      `${location.origin}${location.pathname}`,
    );
    const text = challengeText(record);
    if (navigator.share) {
      try {
        await navigator.share({ text, url });
        return;
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(`${text} ${url}`);
      setStatus("Link copied. Send it to a friend!");
    } catch {
      setStatus(url);
    }
  };
  return (
    <div className={styles.challenge}>
      <button className={styles.challengeBtn} onClick={onClick}>
        🌍 Challenge a friend to this world
      </button>
      {status && <div className={styles.challengeStatus}>{status}</div>}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.statRow}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{value}</span>
    </div>
  );
}

const SIL_W = 320;
const SIL_H = 150;

// The tree as it stands, fitted into a small dusk-lit frame with the ground line.
function Silhouette({ cells }: { cells: Map<string, Cell> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = SIL_W * dpr;
    canvas.height = SIL_H * dpr;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);

    const tree = [...cells.values()].filter(
      (c) => c.type !== "soil" && c.type !== "rock",
    );
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    for (const c of tree) {
      const { x, y } = hexToPixel(c.q, c.r, 1);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    const pad = 1.5;
    const scale = Math.min(
      18,
      (SIL_W - 16) / (maxX - minX + pad * 2),
      (SIL_H - 16) / (maxY - minY + pad * 2),
    );
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const toX = (x: number) => SIL_W / 2 + (x - cx) * scale;
    const toY = (y: number) => SIL_H / 2 + (y - cy) * scale;

    const groundY = toY(hexToPixel(0, surfaceR(0), 1).y - 0.75);
    const sky = ctx.createLinearGradient(0, 0, 0, groundY);
    sky.addColorStop(0, "#1e2540");
    sky.addColorStop(1, "#b0786a");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, SIL_W, SIL_H);
    ctx.fillStyle = "#1f160f";
    ctx.fillRect(0, groundY, SIL_W, SIL_H - groundY);

    const placed: PlacedCell[] = tree.map((c) => {
      const { x, y } = hexToPixel(c.q, c.r, 1);
      return { cell: c, key: hexKey(c.q, c.r), sx: toX(x), sy: toY(y), s: 1 };
    });
    drawOrganicTree(ctx, placed, cells, {
      r: scale,
      light: new Map(),
      autumn: 0,
      shimmerNow: null,
    });
  }, [cells]);
  return (
    <canvas
      ref={ref}
      className={styles.silhouette}
      style={{ width: SIL_W, height: SIL_H }}
    />
  );
}
