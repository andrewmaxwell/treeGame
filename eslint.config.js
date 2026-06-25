import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["dist/", "src/cli/"] },
  { linterOptions: { reportUnusedDisableDirectives: "error" } },
  ...tseslint.configs.recommended,
  {
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": "off", // tsc handles this with noUnusedLocals
      // Refs intentionally hold live game state; React state only mirrors it for HUD re-renders.
      // Reading ref.current in useState initializers (run once on mount, not on every render)
      // is a deliberate architectural pattern here, not a bug.
      "react-hooks/refs": "off",
      // Resetting confirming state when the inspected cell changes is intentional.
      "react-hooks/set-state-in-effect": "off",
      // advancePlayback is a recursive RAF loop — it intentionally references itself.
      "react-hooks/immutability": "off",
    },
  },
  prettier,
);
