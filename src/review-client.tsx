import { useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createColumnHelper, useTable, type ColumnFiltersState, type SortingState } from "@tanstack/react-table";
import { ArrowUpDown, FilePenLine, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { reviewDataTableFeatures } from "./review-data-table-features";
import "./review-original-preview";

type ReviewBill = {
  id: string;
  invoiceDate: string | null;
  total: number | null;
  vat: number | null;
  subtotal: number | null;
  description: string | null;
  truckNumber: string | null;
  vendorTaxNumber: string | null;
  vendorName: string | null;
  invoiceNumber: string | null;
  senderId: string | null;
  receivedAt: string;
};

const column = createColumnHelper<typeof reviewDataTableFeatures, ReviewBill>();
const columns = column.columns([
  column.accessor("invoiceDate", { header: ({ column: current }) => <Button variant="ghost" onClick={() => current.toggleSorting(current.getIsSorted() === "asc")}>تاريخ الفاتورة <ArrowUpDown /></Button>, cell: ({ getValue }) => getValue() ?? "" }),
  column.accessor("total", { header: ({ column: current }) => <Button variant="ghost" onClick={() => current.toggleSorting(current.getIsSorted() === "asc")}>مبلغ اجمالي بعد الضريبة <ArrowUpDown /></Button>, cell: ({ getValue }) => getValue() ?? "" }),
  column.accessor("vat", { header: ({ column: current }) => <Button variant="ghost" onClick={() => current.toggleSorting(current.getIsSorted() === "asc")}>قيمة الضريبة <ArrowUpDown /></Button>, cell: ({ getValue }) => getValue() ?? "" }),
  column.accessor("subtotal", { header: ({ column: current }) => <Button variant="ghost" onClick={() => current.toggleSorting(current.getIsSorted() === "asc")}>مبلغ قبل الضريبة <ArrowUpDown /></Button>, cell: ({ getValue }) => getValue() ?? "" }),
  column.accessor("description", { header: "وصف القطع وبيانها", cell: ({ getValue }) => <span className="whitespace-pre-line">{getValue() ?? ""}</span> }),
  column.accessor("truckNumber", { header: "رقم الشاحنة ( المسؤليه )", cell: ({ getValue }) => getValue() ?? "" }),
  column.accessor("vendorTaxNumber", { header: "الرقم الضريبي للمورد", cell: ({ getValue }) => getValue() ?? "" }),
  column.accessor("vendorName", { header: ({ column: current }) => <Button variant="ghost" onClick={() => current.toggleSorting(current.getIsSorted() === "asc")}>اسم المورد <ArrowUpDown /></Button>, cell: ({ getValue }) => getValue() ?? "" }),
  column.accessor("invoiceNumber", { header: ({ column: current }) => <Button variant="ghost" onClick={() => current.toggleSorting(current.getIsSorted() === "asc")}>رقم الفاتورة <ArrowUpDown /></Button>, cell: ({ getValue, row }) => <a href={`/review/bills/${encodeURIComponent(row.original.id)}`} aria-label={`مراجعة الفاتورة ${getValue() ?? row.original.id}`} title="فتح المراجعة">{getValue() ?? <FilePenLine aria-hidden="true" />}</a> }),
  column.accessor("senderId", { header: "رقم مرسل الفاتورة", cell: ({ getValue }) => getValue() ?? "" }),
  column.accessor("receivedAt", { header: ({ column: current }) => <Button variant="ghost" onClick={() => current.toggleSorting(current.getIsSorted() === "asc")}>تاريخ وتوقيت الارسال <ArrowUpDown /></Button>, cell: ({ getValue }) => new Date(getValue()).toLocaleString("ar-SA") }),
]);

function Queue(): ReactNode {
  const [bills, setBills] = useState<ReviewBill[] | null>(null);
  const [error, setError] = useState(false);
  const [source, setSource] = useState("");
  const [status, setStatus] = useState("");
  const [batch, setBatch] = useState("");
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    const load = () => void fetch(`/review/api/bills?${new URLSearchParams({ ...(source ? { source } : {}), ...(status ? { status } : {}), ...(batch ? { batch } : {}) })}`, { credentials: "same-origin" })
      .then(async (response) => { if (!response.ok) throw new Error("تعذر تحميل قائمة المراجعة"); return response.json() as Promise<ReviewBill[]>; })
      .then((loaded) => { setBills(loaded); setError(false); }).catch(() => setError(true));
    load();
    const polling = setInterval(load, 15_000);
    return () => clearInterval(polling);
  }, [source, status, batch]);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const table = useTable({ features: reviewDataTableFeatures, data: bills ?? [], columns, onSortingChange: setSorting, onColumnFiltersChange: setColumnFilters, state: { sorting, columnFilters } });
  const toggleTheme = () => { const next = !dark; document.documentElement.classList.toggle("dark", next); try { localStorage.setItem("review-theme", next ? "dark" : "light"); } catch {} setDark(next); };
  return <main className="review-page">
    <div className="flex items-center justify-between gap-4"><h1>قائمة المراجعة</h1><Button variant="outline" size="icon" onClick={toggleTheme} aria-label={dark ? "التبديل إلى الوضع الفاتح" : "التبديل إلى الوضع الداكن"}>{dark ? <Sun /> : <Moon />}</Button></div>
    {error ? <p className="notice error">تعذر تحميل قائمة المراجعة. حدّث الصفحة وحاول مرة أخرى.</p> : bills === null ? <p className="notice">جارٍ تحميل قائمة المراجعة…</p> : <div className="w-full">
      <div className="flex items-center gap-2 py-4">
        <Input placeholder="ابحث برقم الفاتورة..." value={(table.getColumn("invoiceNumber")?.getFilterValue() as string) ?? ""} onChange={(event) => table.getColumn("invoiceNumber")?.setFilterValue(event.target.value)} className="max-w-sm" />
        <select aria-label="المصدر" value={source} onChange={(event) => setSource(event.target.value)}><option value="">كل المصادر</option><option value="whatsapp">واتساب</option><option value="telegram">تيليجرام</option><option value="admin_upload">ZIP</option></select>
        <select aria-label="الحالة" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">كل الحالات</option><option value="complete">مكتملة</option><option value="not_invoice">ليست فاتورة</option><option value="needs_review">تحتاج مراجعة</option></select>
        <Input aria-label="الدفعة" placeholder="معرف الدفعة" value={batch} onChange={(event) => setBatch(event.target.value)} className="max-w-sm" />
      </div>
      <div className="overflow-x-auto rounded-md border">{bills.length === 0 ? <p className="notice m-4">لا توجد فواتير للمراجعة.</p> : <Table><TableHeader>{table.getHeaderGroups().map((group) => <TableRow key={group.id}>{group.headers.map((header) => <TableHead key={header.id}>{header.isPlaceholder ? null : <table.FlexRender header={header} />}</TableHead>)}</TableRow>)}</TableHeader><TableBody>{table.getRowModel().rows.length ? table.getRowModel().rows.map((row) => <TableRow key={row.id}>{row.getVisibleCells().map((cell) => <TableCell key={cell.id}><table.FlexRender cell={cell} /></TableCell>)}</TableRow>) : <TableRow><TableCell colSpan={columns.length} className="h-24 text-center">لا توجد نتائج.</TableCell></TableRow>}</TableBody></Table>}</div>
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
  return <header className="review-actions-bar"><nav className="review-tabs" aria-label="التنقل الإداري"><a href="/admin">لوحة الإدارة</a><a href="/review" aria-current="page">مراجعة الفواتير</a></nav><div className="flex flex-wrap gap-2"><Button variant="outline" render={<a href="/review/export.csv" />}>تصدير CSV</Button><Button variant="destructive" disabled={clearing} onClick={clearBills}>{clearing ? "جارٍ الحذف…" : "حذف جميع الفواتير"}</Button></div></header>;
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Queue />);
const actions = document.getElementById("review-actions");
if (actions) createRoot(actions).render(<ReviewActions csrf={root?.dataset.csrf ?? ""} />);
