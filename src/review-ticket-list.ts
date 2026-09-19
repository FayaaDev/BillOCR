export interface ReviewBill {
  id: string;
  source: "whatsapp" | "telegram" | "admin_upload";
  status: string;
  displayStatus: string;
  batchId: string | null;
  invoiceDate: string | null;
  total: number | null;
  currency: string | null;
  vat: number | null;
  subtotal: number | null;
  description: string | null;
  truckNumber: string | null;
  vendorTaxNumber: string | null;
  vendorName: string | null;
  invoiceNumber: string | null;
  senderId: string | null;
  receivedAt: string;
  updatedAt: string;
}

export type ReviewSort = "received-desc" | "received-asc" | "invoice-desc" | "invoice-asc" | "total-desc" | "total-asc" | "vendor" | "invoice-number";

export const REVIEW_PAGE_SIZE = 10;

export function sumReviewBillTotals(bills: ReviewBill[]): number {
  return bills.reduce((sum, bill) => sum + (bill.total ?? 0), 0);
}

const collator = new Intl.Collator("ar", { numeric: true, sensitivity: "base" });

function nullableCompare<T>(left: T | null, right: T | null, compare: (a: T, b: T) => number): number {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return compare(left, right);
}

export function prepareReviewBills(bills: ReviewBill[], search: string, sort: ReviewSort): ReviewBill[] {
  const needle = search.trim();
  return bills
    .filter((bill) => needle === "" || bill.invoiceNumber?.toLocaleLowerCase("ar").includes(needle.toLocaleLowerCase("ar")))
    .toSorted((left, right) => {
      let result: number;
      switch (sort) {
        case "received-asc": result = collator.compare(left.receivedAt, right.receivedAt); break;
        case "invoice-desc": result = nullableCompare(left.invoiceDate, right.invoiceDate, (a, b) => collator.compare(b, a)); break;
        case "invoice-asc": result = nullableCompare(left.invoiceDate, right.invoiceDate, (a, b) => collator.compare(a, b)); break;
        case "total-desc": result = nullableCompare(left.total, right.total, (a, b) => b - a); break;
        case "total-asc": result = nullableCompare(left.total, right.total, (a, b) => a - b); break;
        case "vendor": result = nullableCompare(left.vendorName, right.vendorName, (a, b) => collator.compare(a, b)); break;
        case "invoice-number": result = nullableCompare(left.invoiceNumber, right.invoiceNumber, (a, b) => collator.compare(a, b)); break;
        default: result = collator.compare(right.receivedAt, left.receivedAt);
      }
      return result || collator.compare(left.id, right.id);
    });
}

export function paginateReviewBills(bills: ReviewBill[], requestedPage: number, pageSize = REVIEW_PAGE_SIZE) {
  const pageCount = Math.ceil(bills.length / pageSize);
  const page = Math.min(Math.max(1, requestedPage), Math.max(1, pageCount));
  const startIndex = (page - 1) * pageSize;
  return {
    bills: bills.slice(startIndex, startIndex + pageSize),
    page,
    pageCount,
    rangeStart: bills.length === 0 ? 0 : startIndex + 1,
    rangeEnd: Math.min(startIndex + pageSize, bills.length),
    total: bills.length,
  };
}
