# The site pages

`index.html` (the one-pager) is the marketing version of the [README](../../README.md): one self-contained page covering local mode, a team server and the factory sidecar. GitHub Pages serves it from `master`'s `docs/` folder at https://nolnoch.github.io/grayboard/site/; `docs/index.html` redirects the bare site root there (`docs/.nojekyll` makes Pages serve files as they are, without a Jekyll build over the agent docs). `sessions.html` explains one mechanism for evaluators: how a team server handles sign-in, tokens and session names, in three diagrams. The rules below apply to every page here.

## Keeping it true

- **Claims come from the repo.** A feature on the page must be in the README's feature list or the guide page that owns it; a number must be checkable in the file named in the `<!-- source: -->` comment beside it. No customers, quotes, pricing or deployment names. Don't claim a target as a result (1,000 sessions is a target, #912).
- **Numbers are defaults, not deployments.** A page shows the server's default and names the setting that changes it, never one deployment's value.
- **A minor or major release revisits the pages.** `tests/integration/site.test.ts` fails when any page's `grayboard vX.Y` lags `package.json`'s major.minor. Read the release's notes, update the feature columns and numbers that changed, then bump the version strings. A patch release needs nothing.
- **When the README's feature list changes,** check the page's three mode columns in the same PR.

## Theme

- The colors, fonts, spacing and radii are generated: `bun scripts/site_tokens.ts` writes the block between the `BEGIN generated tokens` and `END generated tokens` comments in every `*.html` here from `tokens.json`; a new page starts with the two markers. Change a color in `tokens.json` and regenerate; never edit the block by hand (the site test fails when it differs).
- Dark first: dark values on `:root`, light under `prefers-color-scheme: light` and `data-theme="light"`. `.dark-scope` keeps the cover band dark in both themes.
- Violet (`--focus`) is the accent for lines, borders and edges: kicker rules, the band's bottom edge, the featured card and tile, the bus in the diagram, focus outlines. Never text, never a fill.
- Icons are inline SVG symbols near the top of `<body>`; reuse one with `<use href="#i-name">`.
- Before merging a visual change, look at both themes and at 400 px wide (headless Chromium screenshots work): no horizontal scroll, 16 px side gutters.
