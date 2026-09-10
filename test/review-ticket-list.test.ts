import { expect, test } from "bun:test";
import { paginateReviewBills, prepareReviewBills, REVIEW_PAGE_SIZE, type ReviewBill } from "../src/review-ticket-list";

function bill(index: number, overrides: Partial<ReviewBill> = {}): ReviewBill {
  return {
    id: `bill-${String(index).padStart(2, "0")}`,
    source: "whatsapp",
    status: "needs_review",
    displayStatus: "needs_review",
    batchId: null,
    invoiceDate: `2026-08-${String(index).padStart(2, "0")}`,
    total: index,
    currency: "SAR",
    vat: index / 10,
    subtotal: index - index / 10,
    description: null,
    truckNumber: null,
    vendorTaxNumber: null,
    vendorName: `مورد ${index}`,
    invoiceNumber: `INV-${index}`,
    senderId: "sender",
    receivedAt: `2026-08-${String(index).padStart(2, "0")}T00:00:00.000Z`,
    updatedAt: `2026-08-${String(index).padStart(2, "0")}T00:00:00.000Z`,
    ...overrides,
  };
}

test("ticket list searches invoice numbers and supports every requested sort", () => {
  const bills = [bill(1, { vendorName: "باء", invoiceNumber: "INV-20", total: null, invoiceDate: null }), bill(2, { vendorName: "ألف", invoiceNumber: "inv-3", total: 30 }), bill(3, { vendorName: null, invoiceNumber: null, total: 10 })];
  expect(prepareReviewBills(bills, "INV-3", "received-desc").map((item) => item.id)).toEqual(["bill-02"]);
  expect(prepareReviewBills(bills, "", "received-asc").map((item) => item.id)).toEqual(["bill-01", "bill-02", "bill-03"]);
  expect(prepareReviewBills(bills, "", "invoice-desc").map((item) => item.id)).toEqual(["bill-03", "bill-02", "bill-01"]);
  expect(prepareReviewBills(bills, "", "invoice-asc").map((item) => item.id)).toEqual(["bill-02", "bill-03", "bill-01"]);
  expect(prepareReviewBills(bills, "", "total-desc").map((item) => item.id)).toEqual(["bill-02", "bill-03", "bill-01"]);
  expect(prepareReviewBills(bills, "", "total-asc").map((item) => item.id)).toEqual(["bill-03", "bill-02", "bill-01"]);
  expect(prepareReviewBills(bills, "", "vendor").map((item) => item.id)).toEqual(["bill-02", "bill-01", "bill-03"]);
  expect(prepareReviewBills(bills, "", "invoice-number").map((item) => item.id)).toEqual(["bill-02", "bill-01", "bill-03"]);
});

test("forty tickets produce four complete numbered pages", () => {
  const bills = Array.from({ length: 40 }, (_, index) => bill(index + 1));
  expect(REVIEW_PAGE_SIZE).toBe(10);
  for (let page = 1; page <= 4; page += 1) {
    const result = paginateReviewBills(bills, page);
    expect(result.pageCount).toBe(4);
    expect(result.bills).toHaveLength(10);
    expect(result.bills[0]?.id).toBe(`bill-${String((page - 1) * 10 + 1).padStart(2, "0")}`);
    expect(result.rangeStart).toBe((page - 1) * 10 + 1);
    expect(result.rangeEnd).toBe(page * 10);
  }
});

test("pagination preserves valid pages and clamps after refreshed results shrink", () => {
  const forty = Array.from({ length: 40 }, (_, index) => bill(index + 1));
  expect(paginateReviewBills(forty, 3).page).toBe(3);
  const shrunk = paginateReviewBills(forty.slice(0, 16), 3);
  expect(shrunk.page).toBe(2);
  expect(shrunk.rangeStart).toBe(11);
  expect(shrunk.rangeEnd).toBe(16);
  expect(paginateReviewBills([], 4)).toMatchObject({ page: 1, pageCount: 0, rangeStart: 0, rangeEnd: 0, total: 0 });
});
