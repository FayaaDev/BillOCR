# ISO 4217 policy

`src/backend/currency.ts` ships the versioned `iso4217-policy-2025-03` dataset; validation never calls a network service. It accepts active currency and invoice-relevant fund/supranational codes, including XAF, XOF, XPF, XDR, XSU, and XUA. It deliberately rejects precious-metal, test, and no-currency codes (XAU, XAG, XPT, XPD, XXX): they are not settlement currencies for this ledger.

Arithmetic tolerance is one ISO minor unit for a recognized currency: 1 for zero-unit codes (including JPY and ISK), 0.01 for common two-decimal currencies, 0.001 for BHD, IQD, JOD, KWD, LYD, OMR, and TND, and 0.0001 for CLF/UYW. XDR, XSU, and XUA are accepted special fund/supranational codes but have explicit `null` ISO minor-unit metadata, so they use `CURRENCY_ROUNDING_TOLERANCE`. Absent or unrecognized currency uses that same explicit fallback.
