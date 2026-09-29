# Bill Ledger — built design reference

## Direction and artifacts
- The user-pinned screenshot anchors the neutral dark shadcn `dashboard-01` hierarchy: right sidebar, compact header, four summary cards, daily chart, then invoice table.
- The generated `dashboard-01` block was installed through the real shadcn CLI (implementation handoff provenance); the shipped interface adapts it to the invoice workflow.
- Arabic and RTL remain primary. Numbers, identifiers, and chart plotting use LTR isolation where implemented.
- Dark is the default; the header light/dark toggle persists `review-theme`. Only a saved `light` value overrides dark, including on login and review pages.
- Source of truth: `src/frontend/admin-client.tsx`, `src/frontend/review-client.css`, `src/frontend/components/app-sidebar.tsx`, `src/backend/review-ui.ts`, `src/frontend/login-ui.tsx`; calculations live in `src/frontend/dashboard-data.ts`.
- Production chart and table consume actual local ledger data, never generated block demo data or invented trends.

## Routes and navigation
| Route | Built surface |
| --- | --- |
| `/admin` | Summary cards, daily amounts, searchable invoice table |
| `/admin?view=integrations` | WhatsApp connection/configured group and read-only Telegram group IDs with copy actions |
| `/admin?view=upload` | ZIP selection, upload progress, batch results |
| `/review` | Invoice review queue |
| `/review/bills/:id` | Original attachment and effective accounting fields for manual review |
| `/review/bills/:id/original` | View original; `?download=1` downloads it |
| `/review/export.xlsx` | Completed-invoice workbook download |
| `/login` | Centered shared-token login card; native username/password form |
| `/logout` | CSRF-protected POST from navigation |
- Sidebar destinations are dashboard, integrations, export, and logout; the brand returns to `/admin`. ZIP upload is a header action.
- Active dashboard/integrations links expose `aria-current`; the sidebar is right-aligned, inset, and off-canvas collapsible.

## Data semantics
- All four cards are all-time and independent of chart range and table filters. Non-invoices are excluded.
- **إجمالي الفواتير شامل الضريبة:** approved invoice totals, already including VAT; VAT is not added again.
- **إجمالي ضريبة القيمة المضافة:** VAT from approved invoices with a usable VAT value.
- Both monetary cards use SAR; null currency is treated as SAR, other currencies are excluded. Accumulation rounds each amount to integer cents before summing.
- **الفواتير المعالجة:** approved plus `needs_review` invoice count, across currencies.
- **بانتظار المراجعة:** `needs_review` invoice count, across currencies.
- Missing VAT and excluded-currency counts receive explanatory text; missing amounts do not become invented accounting values.
- The chart plots approved SAR-compatible total and VAT by exact invoice date, never receipt date. Invalid/missing dates do not contribute to daily buckets.
- Range choices are 90 days (default), 30 days, and 7 days, ending today in UTC; days without amounts are zero-filled.
- Dates use Arabic Gregorian formatting with Latin digits; tooltips show date and SAR amounts. Neutral total area and muted VAT line have a visible legend.
- `/review/api/bills` supplies effective values after corrections. Bills refresh every 15 seconds and through the header refresh action.
- The table includes vendor/detail link, invoice number/date, source, VAT, status, and total. Unknown values use explicit fallbacks or `—`.
- Filters cover invoice-number search, receipt-date bounds, status, and sorting; changes reset pagination. Pages contain ten bills.
- Filtered totals group amounts by currency instead of adding unlike currencies; the table retains each invoice's currency.

## Layout and tokens
- Summary grid: four columns above 960px, two at 960px and below, one at 640px and below. Header actions wrap; filters reduce to two then one column.
- Below 768px the sidebar becomes a right-side sheet (18rem); desktop sidebar width is 16rem.
- Main dashboard content caps at 1440px; padding is `clamp(1rem, 3vw, 2rem)` with 1rem section/grid gaps.
- The table has a local horizontal scroll container and 54rem minimum width; wide rows must not widen the page.
- Review detail uses original and correction panels side-by-side at `lg`, stacked below; the image is contained, while PDFs link to the original.
- Font: self-hosted Noto Sans Arabic 400/700, then UI/system sans-serif. Header title is 1.35rem; metric values use `clamp(1.5rem, 2.2vw, 2rem)` and tabular numerals.
- Supporting labels commonly use .75–.8rem; metric footer line-height is 1.6. Shared base radius is .625rem; small/medium radii are .6/.8 times that value.
- Dark OKLCH neutrals: background `.145`, card `.205`, foreground `.985`, muted `.269`, muted foreground `.708` (zero chroma/hue); border is white at 10%, input at 15%.
- Light neutrals: white background/card, foreground `.145`, muted `.97`, muted foreground `.556`, border/input `.922`.
- Destructive accents use the shared red token; focus uses `--ring`. Borders, restrained surfaces, and typography carry the hierarchy.

## Actions and recovery
- Loading uses skeletons with live status; empty tables/charts explain absence rather than display sample rows or curves.
- Fetch errors use destructive alerts; expired sessions link to login. Refresh provides an explicit retry; existing bill data can remain visible after refresh failure.
- ZIP requires a selected file and available extraction service; controls disable during upload. Progress, per-entry states, batch counts, and upload/status errors are visible.
- Copy actions report success or failure. Integrations show connection/availability and configured IDs without credentials.
- Clear-all requires native confirmation and CSRF, disables while pending, and explains active-processing conflicts or connection failure. Confirmation states originals remain.
- Review supports approve/save corrections, reject, mark not-invoice, and reclassify for manual review. Processing records remain read-only; missing extraction invites manual correction.
- Review conflict/invalid-request pages provide return navigation. Login failure appears beside labeled required fields; focus outlines and accessible icon-button names remain visible.

## Finish review
- Disposition: **ship**, per the supplied fresh independent QA handoff.
- Reported browser checks: 1440px desktop and 390px mobile; no page overflow and no captured CSP/runtime errors.
- Four existing fixture test failures remain reported; this is not an all-tests-passing claim. This documentation pass did not rerun browser or test checks.
- Parent owns Beads closure; this reference adds no issue or task list.
