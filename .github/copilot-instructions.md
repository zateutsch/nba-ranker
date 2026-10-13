# Copilot instructions

- This is a static site (plain HTML/CSS/JS, no build step) hosted on GitHub Pages from the root of `main`.
- Design mobile-first. Every UI change must work at phone widths (~360–430px) as well as desktop:
  - No horizontal scrolling; long names and chip rows must wrap within their card.
  - Side-by-side items that should match (e.g. the two player cards) use `minmax(0, 1fr)` columns so content can't make them unequal.
  - Images sit in fixed aspect-ratio boxes so layout doesn't shift while they load.
  - Hover effects go inside `@media (hover: hover)`; touch devices get `:active` feedback instead.
  - On the compare screen, both player cards should fit on a phone screen without scrolling.
- Verify layout changes at both ~390px and desktop widths before committing.
- Colours live only in the `:root` theme variables at the top of `css/styles.css` (the share image reads them too). Use `var(--...)` instead of hard-coding colours; per-team colours in `TEAM_COLORS` are data, not theme.
