# Worker notes (dsh-superagent)

- Validation: run `scripts/smoke.sh <your-delivery-dir>` — a syntax gate plus one
  headless browser load with console-error capture (screenshot only on failure,
  written to `.smoke/smoke-fail.png`). It is idempotent: do not install playwright,
  browsers or any npm packages yourself.
- Never modify `preview/`, `.github/`, or other apps" directories (`ordering/`,
  `roewe/`, `roewe-cockpit/`, ...) — deliver only your own new directory.
- Zero-build deliverables only: no npm build steps, no node_modules inside your
  delivery directory.
