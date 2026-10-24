import styles from "./Intro.module.css";

interface Props {
  onDismiss: () => void;
}

// A short, dismissible "how to play" shown on first launch (and reopenable via the ?
// button). Deliberately brief — the goal tracker teaches the rest one step at a time.
export function Intro({ onDismiss }: Props) {
  return (
    <div className={styles.overlay} onClick={onDismiss}>
      <div className={styles.card} onClick={(e) => e.stopPropagation()}>
        <div className={styles.title}>🌱 Grow your tree</div>
        <p className={styles.lead}>
          Raise a tree through the seasons and make as many seeds as you can
          over its life. Drag to look around; pinch or scroll to zoom.
        </p>
        <ul className={styles.steps}>
          <li>
            <b>Tap a glowing spot</b> to grow wood (it costs ⚡ energy). Roots
            below ground drink water; branches above reach for the sun.
          </li>
          <li>
            <b>Leaves sprout on their own</b> once a branch is tall enough, and
            their energy pays for more growth.
          </li>
          <li>
            Each year: grow in <b>spring</b>, endure <b>summer</b>, harvest{" "}
            <b>seeds</b> in fall (your score), rest through <b>winter</b>.
          </li>
        </ul>
        <p className={styles.tip}>
          Tip: keep your tree <b>balanced</b> — long one-sided branches turn red
          and snap in storms.
        </p>
        <button className={styles.btn} onClick={onDismiss}>
          Plant it →
        </button>
      </div>
    </div>
  );
}
