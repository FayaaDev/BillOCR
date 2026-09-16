import { useDeferredValue, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { FilePenLine, Moon, Sun } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { paginateReviewBills, prepareReviewBills, type ReviewBill, type ReviewSort } from "./review-ticket-list";
import "./review-original-preview";
import "./review-form";

const statusLabels: Record<string, string> = {
  received: "مستلمة",
  extracting: "قيد الاستخراج",
  needs_review: "تحتاج مراجعة",
  approved: "معتمدة",
  failed: "فشلت",
  Complete: "مكتملة",
  NotInvoice: "ليست فاتورة",
};
const sourceLabels: Record<ReviewBill["source"], string> = { whatsapp: "واتساب", telegram: "تيليجرام", admin_upload: "ZIP" };

function displayValue(value: string | number | null): ReactNode {
  return value === null || value === "" ? <span className="text-muted-foreground">غير متوفر</span> : value;
}

function formatDate(value: string | null, includeTime = false): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return includeTime ? date.toLocaleString("ar-SA") : date.toLocaleDateString("ar-SA");
}

function Identifier({ children }: { children: string }): ReactNode {
  return <bdi dir="ltr" className="ticket-identifier">{children}</bdi>;
}

function Detail({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return <div className="ticket-detail"><dt>{label}</dt><dd>{children}</dd></div>;
}

function Ticket({ bill }: { bill: ReviewBill }): ReactNode {
  const invoiceLabel = bill.invoiceNumber ?? bill.id;
  return <li>
    <Card className="ticket-card">
      <CardHeader>
        <CardTitle>{bill.vendorName ?? "مورد غير معروف"}</CardTitle>
        <CardDescription>رقم الفاتورة: <Identifier>{invoiceLabel}</Identifier></CardDescription>
        <CardAction><Badge variant={bill.displayStatus === "NotInvoice" || bill.status === "failed" ? "destructive" : "secondary"}>{statusLabels[bill.displayStatus] ?? statusLabels[bill.status] ?? bill.displayStatus}</Badge></CardAction>
      </CardHeader>
      <CardContent className="ticket-content">
        <section className="ticket-primary" aria-label="البيانات الأساسية">
          <div className="ticket-total"><span>الإجمالي بعد الضريبة</span><strong>{displayValue(bill.total)}{bill.currency ? <> <Identifier>{bill.currency}</Identifier></> : null}</strong></div>
          <Detail label="تاريخ الفاتورة">{displayValue(formatDate(bill.invoiceDate))}</Detail>
          <div className="ticket-description"><span>الوصف</span><p>{displayValue(bill.description)}</p></div>
        </section>
        <dl className="ticket-details">
          <Detail label="المبلغ قبل الضريبة">{displayValue(bill.subtotal)}</Detail>
          <Detail label="قيمة الضريبة">{displayValue(bill.vat)}</Detail>
          <Detail label="رقم الشاحنة">{bill.truckNumber ? <Identifier>{bill.truckNumber}</Identifier> : displayValue(null)}</Detail>
          <Detail label="الرقم الضريبي للمورد">{bill.vendorTaxNumber ? <Identifier>{bill.vendorTaxNumber}</Identifier> : displayValue(null)}</Detail>
          <Detail label="المصدر">{sourceLabels[bill.source]}</Detail>
          <Detail label="معرف المرسل">{bill.senderId ? <Identifier>{bill.senderId}</Identifier> : displayValue(null)}</Detail>
          <Detail label="تاريخ ووقت الاستلام">{displayValue(formatDate(bill.receivedAt, true))}</Detail>
          <Detail label="معرف الدفعة">{bill.batchId ? <Identifier>{bill.batchId}</Identifier> : displayValue(null)}</Detail>
          <Detail label="آخر تحديث">{displayValue(formatDate(bill.updatedAt, true))}</Detail>
        </dl>
      </CardContent>
      <CardFooter className="justify-end">
        <Button render={<a href={`/review/bills/${encodeURIComponent(bill.id)}`} aria-label={`مراجعة الفاتورة ${invoiceLabel}`} />}>
          <FilePenLine data-icon="inline-start" aria-hidden="true" /> فتح المراجعة
        </Button>
      </CardFooter>
    </Card>
  </li>;
}

function Queue(): ReactNode {
  const [bills, setBills] = useState<ReviewBill[] | null>(null);
  const [error, setError] = useState(false);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [source, setSource] = useState("");
  const [status, setStatus] = useState("");
  const [batch, setBatch] = useState("");
  const [sort, setSort] = useState<ReviewSort>("received-desc");
  const [page, setPage] = useState(1);
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));

  useEffect(() => {
    const controller = new AbortController();
    let requestSequence = 0;
    const load = () => {
      const sequence = ++requestSequence;
      void fetch(`/review/api/bills?${new URLSearchParams({ ...(source ? { source } : {}), ...(status ? { status } : {}), ...(batch ? { batch } : {}) })}`, { credentials: "same-origin", signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error("تعذر تحميل قائمة المراجعة"); return response.json() as Promise<ReviewBill[]>; })
      .then((loaded) => { if (sequence === requestSequence) { setBills(loaded); setError(false); } })
      .catch((loadError: unknown) => { if (sequence === requestSequence && !(loadError instanceof DOMException && loadError.name === "AbortError")) setError(true); });
    };
    load();
    const polling = setInterval(load, 15_000);
    return () => { controller.abort(); clearInterval(polling); };
  }, [source, status, batch]);

  const prepared = prepareReviewBills(bills ?? [], deferredSearch, sort);
  const pagination = paginateReviewBills(prepared, page);
  useEffect(() => { if (pagination.page !== page) setPage(pagination.page); }, [page, pagination.page]);

  const resetPage = (change: () => void): void => { change(); setPage(1); };
  const toggleTheme = (): void => { const next = !dark; document.documentElement.classList.toggle("dark", next); try { localStorage.setItem("review-theme", next ? "dark" : "light"); } catch {} setDark(next); };

  return <main className="review-page">
    <div className="flex items-center justify-between gap-4"><h1>قائمة المراجعة</h1><Button variant="outline" size="icon" onClick={toggleTheme} aria-label={dark ? "التبديل إلى الوضع الفاتح" : "التبديل إلى الوضع الداكن"}>{dark ? <Sun /> : <Moon />}</Button></div>
    {error ? <p className="notice error">تعذر تحميل قائمة المراجعة. حدّث الصفحة وحاول مرة أخرى.</p> : bills === null ? <p className="notice">جارٍ تحميل قائمة المراجعة…</p> : <div className="ticket-dashboard">
      <div className="ticket-toolbar" aria-label="بحث وفرز الفواتير">
        <Input aria-label="البحث برقم الفاتورة" placeholder="ابحث برقم الفاتورة..." value={search} onChange={(event) => resetPage(() => setSearch(event.target.value))} />
        <select aria-label="المصدر" value={source} onChange={(event) => resetPage(() => setSource(event.target.value))}><option value="">كل المصادر</option><option value="whatsapp">واتساب</option><option value="telegram">تيليجرام</option><option value="admin_upload">ZIP</option></select>
        <select aria-label="الحالة" value={status} onChange={(event) => resetPage(() => setStatus(event.target.value))}><option value="">كل الحالات</option><option value="complete">مكتملة</option><option value="not_invoice">ليست فاتورة</option><option value="needs_review">تحتاج مراجعة</option></select>
        <Input aria-label="الدفعة" placeholder="معرف الدفعة" value={batch} onChange={(event) => resetPage(() => setBatch(event.target.value))} />
        <select aria-label="ترتيب الفواتير" value={sort} onChange={(event) => resetPage(() => setSort(event.target.value as ReviewSort))}>
          <option value="received-desc">الأحدث استلاماً</option><option value="received-asc">الأقدم استلاماً</option><option value="invoice-desc">تاريخ الفاتورة: الأحدث</option><option value="invoice-asc">تاريخ الفاتورة: الأقدم</option><option value="total-desc">الإجمالي: الأعلى</option><option value="total-asc">الإجمالي: الأقل</option><option value="vendor">اسم المورد</option><option value="invoice-number">رقم الفاتورة</option>
        </select>
      </div>
      {bills.length === 0 ? <p className="notice">لا توجد فواتير للمراجعة.</p> : prepared.length === 0 ? <p className="notice">لا توجد نتائج مطابقة لرقم الفاتورة.</p> : <>
        <ul className="ticket-list" aria-label="فواتير المراجعة">{pagination.bills.map((bill) => <Ticket key={bill.id} bill={bill} />)}</ul>
        <nav className="ticket-pagination" aria-label="صفحات فواتير المراجعة">
          <p aria-live="polite">عرض {pagination.rangeStart}–{pagination.rangeEnd} من {pagination.total} فاتورة</p>
          <div className="ticket-page-buttons">
            <Button variant="outline" className="ticket-page-button" disabled={pagination.page === 1} onClick={() => setPage((current) => current - 1)} aria-label="الصفحة السابقة">السابق</Button>
            {Array.from({ length: pagination.pageCount }, (_, index) => index + 1).map((number) => <Button key={number} variant={number === pagination.page ? "default" : "outline"} className="ticket-page-button" onClick={() => setPage(number)} aria-label={`الصفحة ${number}`} aria-current={number === pagination.page ? "page" : undefined}>{number}</Button>)}
            <Button variant="outline" className="ticket-page-button" disabled={pagination.page === pagination.pageCount} onClick={() => setPage((current) => current + 1)} aria-label="الصفحة التالية">التالي</Button>
          </div>
        </nav>
      </>}
    </div>}
  </main>;
}

function ReviewActions({ csrf }: { csrf: string }): ReactNode {
  const [clearing, setClearing] = useState(false);
  const clearBills = (): void => {
    if (!confirm("هل تريد حذف جميع الفواتير المحلية؟ لا يمكن التراجع عن هذا الإجراء، ولن تُحذف الملفات الأصلية.")) return;
    setClearing(true);
    void fetch("/review/api/bills/clear", { method: "POST", credentials: "same-origin", headers: { "x-csrf-token": csrf } })
      .then((response) => { if (!response.ok) throw new Error("clear failed"); window.location.reload(); })
      .catch(() => { setClearing(false); alert("تعذر حذف الفواتير. حدّث الصفحة وحاول مرة أخرى."); });
  };
  return <header className="review-actions-bar"><nav className="review-tabs" aria-label="التنقل الإداري"><a href="/admin">لوحة الإدارة</a><a href="/review" aria-current="page">مراجعة الفواتير</a></nav><div className="flex flex-wrap gap-2"><Button variant="outline" render={<a href="/review/export.csv" />}>تصدير CSV</Button><Button variant="outline" render={<a href="/review/export.xlsx" />}>تصدير XLSX</Button><Button variant="destructive" disabled={clearing} onClick={clearBills}>{clearing ? "جارٍ الحذف…" : "حذف جميع الفواتير"}</Button></div></header>;
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Queue />);
const actions = document.getElementById("review-actions");
if (actions) createRoot(actions).render(<ReviewActions csrf={root?.dataset.csrf ?? ""} />);
