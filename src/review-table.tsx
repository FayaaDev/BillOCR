import type { ReactNode, TableHTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";

export function Table({ children, ...props }: TableHTMLAttributes<HTMLTableElement>): ReactNode {
  return <div className="table-wrap"><table {...props}>{children}</table></div>;
}

export function TableHead({ children, ...props }: ThHTMLAttributes<HTMLTableCellElement>): ReactNode {
  return <th {...props}>{children}</th>;
}

export function TableCell({ children, ...props }: TdHTMLAttributes<HTMLTableCellElement>): ReactNode {
  return <td {...props}>{children}</td>;
}
