# Bill Ledger

<!-- uizze:product-schema 1 -->

## Platform

web

## Product Purpose

Receive bills through WhatsApp, Telegram, and ZIP upload, extract their accounting fields, review corrections, and export completed invoices.

## Capabilities and Constraints

SQLite is the source of truth. Review decisions preserve revision guards, authenticated sessions, scoped CSRF tokens, and immutable verified originals. The existing interface uses Arabic and RTL, supports light/dark themes, and runs on Bun with React and Tailwind.

## Confirmed Dashboard Requirements

Four scorecards: total bill price including VAT, total VAT, processed bills, and bills awaiting review. A daily bill-price chart sits above the bills table. Sidebar destinations are Dashboard, Integrations (WhatsApp and Telegram), Export, and Logout.

## Brand Commitments

Use the supplied dark dashboard screenshot and shadcn dashboard-01 as the binding layout reference. Use actual bill data, without fabricated analytics or demo navigation.
