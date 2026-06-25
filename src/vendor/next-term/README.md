# Vendored: next-term (`@next_term/core` + native `SkiaRenderer`)

Source: https://github.com/rahulpandita/react-term (MIT). Vendored because the
package is **not installable** via a package manager: it has no npm release, it's
a pnpm monorepo whose packages depend on each other via `workspace:*`, and it
ships from an unbuilt `dist/` (only `src/` is in git). So we copy the source.

## What's here

- `core/` — `packages/core/src` verbatim (the VT parser: `BufferSet`, `VTParser`,
  `CellGrid`, themes, wcwidth, reflow). Zero runtime dependencies. Hermes-safe —
  `CellGrid` feature-detects `SharedArrayBuffer` and falls back to `ArrayBuffer`.
- `SkiaRenderer.ts` — `packages/native/src/renderer/SkiaRenderer.ts`. Turns a
  `CellGrid` + cursor into a flat `RenderCommand[]` (rect/text/line). Does **not**
  import Skia — the consumer paints the commands. We do that in
  `src/components/terminal/NextTermTerminal.tsx`.

We did **not** vendor `NativeTerminal`/`TerminalSurface` — those render an empty
`RCTView` placeholder and only emit render commands; our component is the real
Skia surface.

## Local modifications (only what's needed to build under Metro)

- Stripped the `.js` extension from relative import specifiers (Metro doesn't
  resolve `./foo.js` → `./foo.ts` by default).
- `SkiaRenderer.ts`: rewrote `import ... from "@next_term/core"` → `"./core"`.

To re-sync with upstream, re-run the copy and re-apply those two rewrites.
