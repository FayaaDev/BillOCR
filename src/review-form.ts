export const reviewFormMaxBytes = 128 * 1024;
export const reviewFieldLimits = {
  invoiceDate: 1_024,
  total: 1_024,
  vat: 1_024,
  subtotal: 1_024,
  description: 2_000,
  truckNumber: 1_024,
  vendorTaxNumber: 1_024,
  vendorName: 1_024,
  invoiceNumber: 1_024,
} as const;

const reviewFormFields = new Set(["csrf", "contentRevision", "reviewRevision", "action", ...Object.keys(reviewFieldLimits)]);

export function isReviewFormField(value: string): boolean {
  return reviewFormFields.has(value);
}

export function pruneReviewFormData(form: FormData): void {
  for (const key of [...form.keys()]) if (!reviewFormFields.has(key)) form.delete(key);
}

export function reviewFormValidationMessage(entries: Iterable<[string, string]>): string | null {
  const form = new URLSearchParams();
  for (const [key, value] of entries) {
    const limit = reviewFieldLimits[key as keyof typeof reviewFieldLimits];
    if (limit !== undefined && value.length > limit) return key === "description" ? "وصف الفاتورة أطول من الحد المسموح." : "إحدى قيم الفاتورة أطول من الحد المسموح.";
    form.append(key, value);
  }
  return new TextEncoder().encode(form.toString()).byteLength > reviewFormMaxBytes ? "بيانات المراجعة أكبر من الحد المسموح. اختصر القيم ثم حاول مرة أخرى." : null;
}

export function installReviewForm(document: Pick<Document, "getElementById">): void {
  const form = document.getElementById("review-correction-form") as HTMLFormElement | null;
  const error = document.getElementById("review-form-error");
  if (!form || !error) return;

  form.addEventListener("formdata", (event) => pruneReviewFormData(event.formData));
  form.addEventListener("submit", (event) => {
    const data = new FormData(form, event.submitter);
    if (data.get("action") === "delete_bill" && !confirm("هل تريد حذف هذه الفاتورة وملفها الأصلي؟ لا يمكن التراجع عن هذا الإجراء.")) { event.preventDefault(); return; }
    pruneReviewFormData(data);
    const message = reviewFormValidationMessage(Array.from(data.entries()).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    error.textContent = message ?? "";
    if (message) event.preventDefault();
  });
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => installReviewForm(document), { once: true });
  else installReviewForm(document);
}
