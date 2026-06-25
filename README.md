# Tree Growth Game

A season-based strategy game where you grow a 2D tree on a hex grid. Maximize reproduction (viable seeds) over your tree's lifetime by managing water, energy, structure, and the annual cycle of growth and dormancy.

**Play it:** https://tree-game-mauve.vercel.app/

## How to play

Each year cycles through four seasons:

- **Spring** — grow new branches and roots, and bloom flowers; the canopy leafs out on its own
- **Summer** — maximum photosynthesis, but water is scarce; fruit is thirsty
- **Fall** — harvest seeds (your score); the canopy drops on its own, banking energy before frost
- **Winter** — survive on reserves; ideal time to prune and reshape

Place cells during the planning phase, then advance the season to watch the simulation play out.

## Tech stack

- TypeScript (strict) + React (HUD only)
- HTML5 Canvas for rendering
- Vite + Vitest
- Deployed on Vercel

## Development

```bash
npm install
npm run dev      # dev server
npm run build    # production build
npm test         # run tests
```

## Repo

https://github.com/andrewmaxwell/treeGame
