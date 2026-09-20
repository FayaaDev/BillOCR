import type { ReviewBill } from "./review-ticket-list";

const dateFormat = new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-latn", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
const chartDateFormat = new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-latn", { timeZone: "UTC", month: "short", day: "numeric" });
export function formatDate(value: string | null, compact = false): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "—";
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return "—";
  return (compact ? chartDateFormat : dateFormat).format(date);
}

export interface DashboardSummary {
  totalIncludingVat: number;
  totalVat: number;
  processedBills: number;
  awaitingReview: number;
  missingVat: number;
  excludedCurrency: number;
  daily: Array<{ date: string; total: number; vat: number }>;
}

/** Mirrors the database review-queue status clauses for client-side filtering. */
export function matchesBillStatus(bill: ReviewBill, status: string): boolean {
  const notInvoice = bill.displayStatus === "NotInvoice";
  if (status === "") return true;
  if (status === "complete") return bill.status === "approved" && !notInvoice;
  if (status === "not_invoice") return notInvoice;
  return bill.status === status && !notInvoice;
}

function cents(value: number | null): number {
  if (value === null || !Number.isFinite(value)) return 0;
  const rounded = Math.round((value + Number.EPSILON) * 100);
  return Number.isSafeInteger(rounded) ? rounded : 0;
}

/** All-time counters/totals; only daily is limited to days. UI must note that null currency is assumed SAR. */
export function summarizeBills(bills: ReviewBill[], days: 7 | 30 | 90, now = new Date()): DashboardSummary {
  const end = new Date(now);
  end.setUTCHours(0, 0, 0, 0);
  const daily = Array.from({ length: days }, (_, index) => {
    const day = new Date(end);
    day.setUTCDate(day.getUTCDate() - days + 1 + index);
    return { date: day.toISOString().slice(0, 10), total: 0, vat: 0 };
  });
  const byDate = new Map(daily.map((day) => [day.date, day]));
  const summary: DashboardSummary = { totalIncludingVat: 0, totalVat: 0, processedBills: 0, awaitingReview: 0, missingVat: 0, excludedCurrency: 0, daily };

  for (const bill of bills) {
    if (bill.displayStatus === "NotInvoice" || bill.displayStatus === "not_invoice") continue;
    if (bill.status !== "approved" && bill.status !== "needs_review") continue;
    summary.processedBills += 1;
    if (bill.status === "needs_review") {
      summary.awaitingReview += 1;
      continue;
    }
    if (bill.vat === null || !Number.isFinite(bill.vat)) summary.missingVat += 1;
    if (bill.currency !== null && bill.currency !== "SAR") {
      summary.excludedCurrency += 1;
      continue;
    }
    const total = cents(bill.total);
    const vat = cents(bill.vat);
    summary.totalIncludingVat += total;
    summary.totalVat += vat;
    // Exact lookup in real UTC dates rejects invalid ISO dates without parsing or falling back to receivedAt.
    const day = bill.invoiceDate === null ? undefined : byDate.get(bill.invoiceDate);
    if (day) {
      day.total += total;
      day.vat += vat;
    }
  }

  summary.totalIncludingVat /= 100;
  summary.totalVat /= 100;
  for (const day of daily) {
    day.total /= 100;
    day.vat /= 100;
  }
  return summary;
}
