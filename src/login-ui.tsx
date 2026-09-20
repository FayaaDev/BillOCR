import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./components/ui/card";
import { Input } from "./components/ui/input";
import { Field, FieldError, FieldGroup, FieldLabel } from "./components/ui/field";

export function renderLoginPage(returnTo: string, failed = false): string {
  const form = <main className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted/30 p-6" aria-labelledby="login-title">
    <p className="text-lg font-semibold">ماسح الفواتير</p>
    <Card className="w-full max-w-md">
      <CardHeader><CardTitle><h1 id="login-title" className="m-0 text-xl">تسجيل الدخول</h1></CardTitle><CardDescription>أدخل بيانات الوصول لمراجعة الفواتير وإدارة التكاملات.</CardDescription></CardHeader>
      <CardContent><form id="login-form" method="post" action="/login">
        <input type="hidden" name="return" value={returnTo}/>
        <FieldGroup>
          {failed && <FieldError id="login-error">تعذر تسجيل الدخول. تحقق من البيانات وحاول مرة أخرى.</FieldError>}
          <Field><FieldLabel htmlFor="username">اسم المستخدم</FieldLabel><Input id="username" name="username" autoComplete="username" dir="auto" required aria-describedby={failed ? "login-error" : undefined} /></Field>
          <Field><FieldLabel htmlFor="password">كلمة المرور</FieldLabel><Input id="password" name="password" type="password" autoComplete="current-password" required aria-describedby={failed ? "login-error" : undefined} /></Field>
        </FieldGroup>
      </form></CardContent>
      <CardFooter><Button className="w-full" form="login-form" type="submit">دخول</Button></CardFooter>
    </Card>
  </main>;
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>تسجيل الدخول</title><script src="/review/assets/theme.js"></script><link rel="stylesheet" href="/review/assets/client.css"></head><body><!-- dashboard-01: user-pinned neutral invoice workflow. Dark neutral shadcn card, shared radii and brand; centered native login, stacked fields, visible recovery on failure. -->${renderToStaticMarkup(form)}</body></html>`;
}
