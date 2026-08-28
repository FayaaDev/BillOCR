import { useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { Table, TableCell, TableHead } from "./review-table";
import "./review-client.css";

type ReviewBill = { id: string; status: string; originalFilename: string | null; receivedAt: string; updatedAt: string };
const column = createColumnHelper<ReviewBill>();
const columns = [
  column.accessor("id", { header: "ID", cell: ({ getValue }) => <a href={`/review/bills/${encodeURIComponent(getValue())}`}>{getValue()}</a> }),
  column.accessor("status", { header: "Status" }),
  column.accessor("originalFilename", { header: "Attachment", cell: ({ getValue }) => getValue() ?? "—" }),
  column.accessor("receivedAt", { header: "Received", cell: ({ getValue }) => new Date(getValue()).toLocaleString() }),
  column.accessor("updatedAt", { header: "Updated", cell: ({ getValue }) => new Date(getValue()).toLocaleString() }),
];

function Queue(): ReactNode {
  const [bills, setBills] = useState<ReviewBill[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    void fetch("/review/api/bills", { credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load review queue");
        return response.json() as Promise<ReviewBill[]>;
      })
      .then(setBills)
      .catch(() => setError(true));
  }, []);
  const table = useReactTable({ data: bills ?? [], columns, getCoreRowModel: getCoreRowModel() });
  return <main className="review-page"><h1>Review queue</h1>{error ? <p className="notice error">Could not load the review queue. Refresh and try again.</p> : bills === null ? <p className="notice">Loading review queue…</p> : bills.length === 0 ? <p className="notice">No bills require review.</p> : <Table><thead>{table.getHeaderGroups().map((group) => <tr key={group.id}>{group.headers.map((header) => <TableHead key={header.id}>{header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}</TableHead>)}</tr>)}</thead><tbody>{table.getRowModel().rows.map((row) => <tr key={row.id}>{row.getVisibleCells().map((cell) => <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>)}</tr>)}</tbody></Table>}</main>;
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Queue />);
