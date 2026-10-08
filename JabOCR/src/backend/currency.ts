/**
 * ISO 4217 policy dataset version 2025-03. It is shipped with the server and never fetched at
 * runtime. We accept assigned currency and fund codes needed for invoices (including XAF/XOF/XPF,
 * XDR, XSU and XUA), but deliberately reject metal/test/no-currency codes (XAU, XAG, XPT, XPD,
 * XXX) because they are not bill settlement currencies.
 */
export const ISO_4217_DATASET_VERSION = "iso4217-policy-2025-03";
const codes = "AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BOV BRL BSD BTN BWP BYN BZD CAD CDF CHE CHF CHW CLF CLP CNY COP COU CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HRK HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SLL SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD USN UYI UYU UYW UZS VED VES VND VUV WST XAF XCD XCG XDR XOF XPF XSU XUA YER ZAR ZMW ZWG";
export const knownIso4217Codes = new Set(codes.split(" "));
/** Declared ISO policy overrides, audited by tests against the policy version above. */
export const minorUnitPolicy = Object.freeze({
  zero: ["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF"],
  three: ["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"],
  four: ["CLF", "UYW"],
  noMinorUnit: ["XDR", "XSU", "XUA"],
});
const zeroDecimal = new Set(minorUnitPolicy.zero);
const threeDecimal = new Set(minorUnitPolicy.three);
const fourDecimal = new Set(minorUnitPolicy.four);
const noMinorUnit = new Set(minorUnitPolicy.noMinorUnit);

/** Complete explicit metadata for every accepted code. null means ISO publishes no minor unit. */
export const iso4217MinorUnits: Readonly<Record<string, number | null>> = Object.freeze(Object.fromEntries([...knownIso4217Codes].map((code) => [code,
  noMinorUnit.has(code) ? null : fourDecimal.has(code) ? 4 : threeDecimal.has(code) ? 3 : zeroDecimal.has(code) ? 0 : 2,
])));

/** ISO minor-unit precision, including explicit null policy for XDR/XSU/XUA. */
export function currencyMinorUnits(currency: string): number | null {
  return Object.hasOwn(iso4217MinorUnits, currency) ? iso4217MinorUnits[currency]! : null;
}

export function toleranceForCurrency(currency: string | null, nullCurrencyFallback: number): string {
  const units = currency === null ? null : currencyMinorUnits(currency);
  if (units === null) return String(nullCurrencyFallback);
  return units === 0 ? "1" : `0.${"0".repeat(units - 1)}1`;
}
