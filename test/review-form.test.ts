import { expect, test } from "bun:test";
import { pruneReviewFormData, reviewFormValidationMessage } from "../src/review-form";

test("review form validation accepts boundaries and explains oversized values", () => {
  expect(reviewFormValidationMessage([["description", "x".repeat(2_000)]])).toBeNull();
  expect(reviewFormValidationMessage([["description", "x".repeat(2_001)]])).toBe("وصف الفاتورة أطول من الحد المسموح.");
  expect(reviewFormValidationMessage([["vendorName", "x".repeat(1_025)]])).toBe("إحدى قيم الفاتورة أطول من الحد المسموح.");
});

test("review form removes controls injected outside the application schema", () => {
  const form = new FormData();
  form.set("csrf", "token"); form.set("action", "approve"); form.set("vendorName", "Vendor"); form.set("extensionPayload", "x".repeat(40_000));
  pruneReviewFormData(form);
  expect(Array.from(form.entries())).toEqual([["csrf", "token"], ["action", "approve"], ["vendorName", "Vendor"]]);
  expect(reviewFormValidationMessage(Array.from(form.entries()) as [string, string][])).toBeNull();
});
