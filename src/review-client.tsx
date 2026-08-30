import { useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createColumnHelper, useTable, type ColumnFiltersState, type ColumnVisibilityState, type RowSelectionState, type SortingState } from "@tanstack/react-table";
import { ArrowUpDown, ChevronDown, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { reviewDataTableFeatures } from "./review-data-table-features";

type ReviewBill = { id: string; status: string; originalFilename: string | null; receivedAt: string; updatedAt: string };
const statusLabels: Record<string, string> = { needs_review: "تحتاج إلى مراجعة", approved: "معتمدة", failed: "فشلت", pending: "قيد الانتظار" };
const column = createColumnHelper<typeof reviewDataTableFeatures, ReviewBill>();
const columns = column.columns([
  column.display({
    id: "select",
    header: ({ table }) => <Checkbox checked={table.getIsAllPageRowsSelected()} indeterminate={table.getIsSomePageRowsSelected() && !table.getIsAllPageRowsSelected()} onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)} aria-label="اختيار كل الصفوف" />,
    cell: ({ row }) => <Checkbox checked={row.getIsSelected()} onCheckedChange={(value) => row.toggleSelected(!!value)} aria-label={`اختيار ${row.original.id}`} />,
    enableSorting: false,
    enableHiding: false,
  }),
  column.accessor("id", {
    header: ({ column: current }) => <Button variant="ghost" onClick={() => current.toggleSorting(current.getIsSorted() === "asc")}>معرّف الفاتورة <ArrowUpDown /></Button>,
    cell: ({ getValue }) => { const id = getValue(); return <a href={`/review/bills/${encodeURIComponent(id)}`} title={id} aria-label={`معرّف الفاتورة الكامل: ${id}`}><span dir="ltr">{id.slice(-4)}</span></a>; },
  }),
  column.accessor("status", { header: ({ column: current }) => <Button variant="ghost" onClick={() => current.toggleSorting(current.getIsSorted() === "asc")}>الحالة <ArrowUpDown /></Button>, cell: ({ getValue }) => statusLabels[getValue()] ?? getValue() }),
  column.accessor("originalFilename", { header: "المرفق", cell: ({ getValue }) => getValue() ?? "—" }),
  column.accessor("receivedAt", { header: ({ column: current }) => <Button variant="ghost" onClick={() => current.toggleSorting(current.getIsSorted() === "asc")}>تاريخ الاستلام <ArrowUpDown /></Button>, cell: ({ getValue }) => new Date(getValue()).toLocaleString("ar-SA") }),
  column.accessor("updatedAt", { header: ({ column: current }) => <Button variant="ghost" onClick={() => current.toggleSorting(current.getIsSorted() === "asc")}>آخر تحديث <ArrowUpDown /></Button>, cell: ({ getValue }) => new Date(getValue()).toLocaleString("ar-SA") }),
]);

function Queue(): ReactNode {
  const [bills, setBills] = useState<ReviewBill[] | null>(null);
  const [error, setError] = useState(false);
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    void fetch("/review/api/bills", { credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error("تعذر تحميل قائمة المراجعة");
        return response.json() as Promise<ReviewBill[]>;
      })
      .then(setBills)
      .catch(() => setError(true));
  }, []);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] = useState<ColumnVisibilityState>({});
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const table = useTable({ features: reviewDataTableFeatures, data: bills ?? [], columns, onSortingChange: setSorting, onColumnFiltersChange: setColumnFilters, onColumnVisibilityChange: setColumnVisibility, onRowSelectionChange: setRowSelection, state: { sorting, columnFilters, columnVisibility, rowSelection } });
  const toggleTheme = () => { const next = !dark; document.documentElement.classList.toggle("dark", next); try { localStorage.setItem("review-theme", next ? "dark" : "light"); } catch {} setDark(next); };
  return <main className="review-page"><div className="flex items-center justify-between gap-4"><h1>قائمة المراجعة</h1><Button variant="outline" size="icon" onClick={toggleTheme} aria-label={dark ? "التبديل إلى الوضع الفاتح" : "التبديل إلى الوضع الداكن"}>{dark ? <Sun /> : <Moon />}</Button></div>{error ? <p className="notice error">تعذر تحميل قائمة المراجعة. حدّث الصفحة وحاول مرة أخرى.</p> : bills === null ? <p className="notice">جارٍ تحميل قائمة المراجعة…</p> : <div className="w-full"><div className="flex items-center gap-2 py-4"><Input placeholder="ابحث برقم الفاتورة..." value={(table.getColumn("id")?.getFilterValue() as string) ?? ""} onChange={(event) => table.getColumn("id")?.setFilterValue(event.target.value)} className="max-w-sm" /><DropdownMenu><DropdownMenuTrigger render={<Button variant="outline" className="ms-auto" />}>الأعمدة <ChevronDown /></DropdownMenuTrigger><DropdownMenuContent align="start" className="w-44"><DropdownMenuGroup>{table.getAllColumns().filter((current) => current.getCanHide()).map((current) => <DropdownMenuCheckboxItem key={current.id} checked={current.getIsVisible()} onCheckedChange={(value) => current.toggleVisibility(!!value)}>{current.id}</DropdownMenuCheckboxItem>)}</DropdownMenuGroup></DropdownMenuContent></DropdownMenu></div><div className="overflow-hidden rounded-md border">{bills.length === 0 ? <p className="notice m-4">لا توجد فواتير للمراجعة.</p> : <Table><TableHeader>{table.getHeaderGroups().map((group) => <TableRow key={group.id}>{group.headers.map((header) => <TableHead key={header.id}>{header.isPlaceholder ? null : <table.FlexRender header={header} />}</TableHead>)}</TableRow>)}</TableHeader><TableBody>{table.getRowModel().rows.length ? table.getRowModel().rows.map((row) => <TableRow key={row.id} data-state={row.getIsSelected() && "selected"}>{row.getVisibleCells().map((cell) => <TableCell key={cell.id}><table.FlexRender cell={cell} /></TableCell>)}</TableRow>) : <TableRow><TableCell colSpan={columns.length} className="h-24 text-center">لا توجد فواتير مطابقة.</TableCell></TableRow>}</TableBody></Table>}</div><div className="flex items-center justify-end gap-2 py-4"><div className="flex-1 text-sm text-muted-foreground">تم اختيار {table.getFilteredSelectedRowModel().rows.length} من {table.getFilteredRowModel().rows.length} صفوف.</div><Button variant="outline" size="sm" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>السابق</Button><Button variant="outline" size="sm" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>التالي</Button></div></div>}</main>;
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Queue />);
