import { expect, test } from "bun:test";
import { formatDate, matchesBillStatus, summarizeBills } from "../src/frontend/dashboard-data";
import { matchesReceivedDate } from "../src/frontend/review-ticket-list";
import type { ReviewBill } from "../src/frontend/review-ticket-list";

function bill(overrides: Partial<ReviewBill> = {}): ReviewBill {
  return {
    id: "bill-1", source: "whatsapp", status: "approved", displayStatus: "Complete", batchId: null,
    invoiceDate: "2026-03-01", total: 115, currency: "SAR", vat: 15, subtotal: 100,
    description: null, truckNumber: null, vendorTaxNumber: null, vendorName: null, invoiceNumber: null,
    senderId: null, receivedAt: "2026-03-01T12:00:00.000Z", updatedAt: "2026-03-01T12:00:00.000Z",
    ...overrides,
  };
}

const now = new Date("2026-03-01T23:30:00.000Z");

test("formats exact calendar dates safely and omits the year only on chart ticks", () => {
  for (const value of [null, "", "9999-99-99", "2026-02-29", "2024-02-30", "2026-04-31", "2026-3-1", "2026-03-01T00:00:00Z"]) {
    expect(formatDate(value)).toBe("—");
    expect(formatDate(value, true)).toBe("—");
  }
  expect(formatDate("2024-02-29")).toContain("2024");
  expect(formatDate("2024-02-29", true)).toBe("29 فبراير");
  expect(formatDate("9999-12-31")).toContain("9999");
});

test("matches the database review queue status semantics", () => {
  const approved = bill({ status: "approved", displayStatus: "Complete" });
  const notInvoice = bill({ status: "approved", displayStatus: "NotInvoice" });
  expect(matchesBillStatus(approved, "complete")).toBe(true);
  expect(matchesBillStatus(notInvoice, "complete")).toBe(false);
  expect(matchesBillStatus(notInvoice, "not_invoice")).toBe(true);
  expect(matchesBillStatus(notInvoice, "approved")).toBe(false);
  expect(matchesBillStatus(bill({ status: "received", displayStatus: "received" }), "received")).toBe(true);
  expect(matchesBillStatus(bill({ status: "extracting", displayStatus: "extracting" }), "extracting")).toBe(true);
});

test("uses corrected input values and counts only extracted invoices with approved financial totals", () => {
  const corrected = bill({ total: 230, vat: 30, subtotal: 200 });
  const bills = [corrected, bill({ status: "needs_review", displayStatus: "needs_review" }),
    ...["failed", "rejected", "received", "extracting"].map((status) => bill({ status })),
    bill({ displayStatus: "NotInvoice" }), bill({ displayStatus: "not_invoice" }),
    bill({ status: "needs_review", displayStatus: "NotInvoice" })];
  const before = structuredClone(bills);
  const summary = summarizeBills(bills, 7, now);
  expect(summary).toMatchObject({ totalIncludingVat: 230, totalVat: 30, processedBills: 2, awaitingReview: 1 });
  expect(summary.daily.at(-1)).toEqual({ date: "2026-03-01", total: 230, vat: 30 });
  expect(bills).toEqual(before);
});

test("sums null and non-SAR currency amounts as SAR and never infers missing VAT", () => {
  const summary = summarizeBills([
    bill({ currency: null, vat: null }), bill({ vat: 0 }),
    bill({ currency: "USD", vat: null }), bill({ currency: "EUR" }),
    bill({ status: "needs_review", currency: "USD", vat: null }),
  ], 7, now);
  expect(summary).toMatchObject({ totalIncludingVat: 460, totalVat: 15, processedBills: 5, awaitingReview: 1 });
  expect(summary.daily.at(-1)).toEqual({ date: "2026-03-01", total: 460, vat: 15 });
});

test("zero fills all supported UTC calendar ranges across month, year and leap boundaries", () => {
  const utcNow = new Date("2024-03-01T01:30:00+03:00"); // February 29 in UTC.
  for (const [days, first] of [[7, "2024-02-23"], [30, "2024-01-31"], [90, "2023-12-02"]] as const) {
    const summary = summarizeBills([], days, utcNow);
    expect(summary.daily).toHaveLength(days);
    expect(summary.daily[0]?.date).toBe(first);
    expect(summary.daily.at(-1)?.date).toBe("2024-02-29");
    expect(new Set(summary.daily.map((day) => day.date)).size).toBe(days);
    expect(summary.daily.every((day) => day.total === 0 && day.vat === 0)).toBe(true);
  }
  expect(utcNow.toISOString()).toBe("2024-02-29T22:30:00.000Z");
});

test("chart uses only exact valid invoice dates in range while financial totals stay all-time", () => {
  const dates = ["2026-02-23", "2026-02-24", "2026-03-01", "2026-03-02", null,
    "2026-02-29", "2026-02-30", "2026-02-31", "2026-3-1", "2026-03-01T00:00:00Z", "invalid"];
  const summary = summarizeBills(dates.map((invoiceDate) => bill({ invoiceDate, total: 1, vat: 0.15 })), 7, now);
  expect(summary.totalIncludingVat).toBe(11);
  expect(summary.totalVat).toBe(1.65);
  expect(summary.daily).toEqual([
    { date: "2026-02-23", total: 1, vat: 0.15 },
    { date: "2026-02-24", total: 1, vat: 0.15 },
    { date: "2026-02-25", total: 0, vat: 0 },
    { date: "2026-02-26", total: 0, vat: 0 },
    { date: "2026-02-27", total: 0, vat: 0 },
    { date: "2026-02-28", total: 0, vat: 0 },
    { date: "2026-03-01", total: 1, vat: 0.15 },
  ]);
  expect(summarizeBills([bill({ invoiceDate: "2026-02-22" })], 7, now).daily.every((day) => day.total === 0)).toBe(true);
});

test("receipt-date range filters scorecards and invoice-date chart together, including empty results", () => {
  const bills = [bill({ id: "before", receivedAt: "2026-02-28T23:59:59Z", invoiceDate: "2026-03-01", total: 100 }),
    bill({ id: "inside", receivedAt: "2026-03-01T23:59:59Z", invoiceDate: "2026-02-28", total: 200 }),
    bill({ id: "review", status: "needs_review", receivedAt: "2026-03-01T00:00:00Z" })];
  const selected = bills.filter((item) => matchesReceivedDate(item, "2026-03-01", "2026-03-01"));
  const summary = summarizeBills(selected, 7, now);
  expect(selected.map((item) => item.id)).toEqual(["inside", "review"]);
  expect(summary).toMatchObject({ totalIncludingVat: 200, processedBills: 2, awaitingReview: 1 });
  expect(summary.daily.at(-2)).toMatchObject({ date: "2026-02-28", total: 200 });
  expect(summary.daily.at(-1)).toMatchObject({ date: "2026-03-01", total: 0 });
  expect(summarizeBills(bills.filter((item) => matchesReceivedDate(item, "2026-03-02", "")), 7, now)).toMatchObject({ totalIncludingVat: 0, processedBills: 0 });
});

test("sums rounded integer cents and ignores nonfinite monetary data", () => {
  const summary = summarizeBills([
    bill({ total: 0.1, vat: 0.1 }), bill({ total: 0.2, vat: 0.2 }),
    bill({ total: 1.005, vat: 0.005 }), bill({ total: null, vat: null }),
    bill({ total: NaN, vat: Infinity }), bill({ total: Infinity, vat: NaN }),
    bill({ total: -Infinity, vat: -Infinity }), bill({ total: Number.MAX_VALUE, vat: 0 }),
  ], 7, now);
  expect(summary.totalIncludingVat).toBe(1.31);
  expect(summary.totalVat).toBe(0.31);
  expect(summary.daily.at(-1)).toEqual({ date: "2026-03-01", total: 1.31, vat: 0.31 });
});
