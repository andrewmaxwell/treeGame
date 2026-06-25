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
          over its life.
        </p>
        <ul className={styles.steps}>
          <li>
            <b>Tap</b> next to your tree to grow <b>wood</b>: below ground it's
            roots (water), above ground it's trunk and branches. Drag to pan,
            scroll/pinch to zoom.
          </li>
          <li>
            <b>Leaves grow on their own</b> on the sunniest spots once your
            branches are tall enough — shown in faint green. Grow up and out to
            earn a bigger canopy.
          </li>
          <li>
            You spend <b>⚡ energy</b> to grow wood. The canopy earns it back in
            spring and summer (and drops on its own each fall, banking most of
            its energy).
          </li>
          <li>
            <b>Winter</b> is dormant: your tree lives on reserves. Use it to
            extend roots and prune.
          </li>
          <li>
            Watch the <b>🎯 goal</b> at the top — it guides you one step at a
            time.
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
