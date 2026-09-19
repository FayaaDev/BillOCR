import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./components/ui/card";
import { Input } from "./components/ui/input";

export function renderLoginPage(returnTo: string, failed = false): string {
  const form = <main className="review-page" aria-labelledby="login-title"><Card className="mx-auto max-w-md"><CardHeader><CardTitle id="login-title">تسجيل الدخول</CardTitle><CardDescription>أدخل بيانات الوصول للمتابعة.</CardDescription></CardHeader><CardContent><form id="login-form" method="post" action="/login" className="grid gap-4"><input type="hidden" name="return" value={returnTo}/>{failed && <p className="notice error" role="alert">تعذر تسجيل الدخول. تحقق من البيانات وحاول مرة أخرى.</p>}<p className="grid gap-2"><label htmlFor="username">اسم المستخدم</label><Input id="username" name="username" autoComplete="username" required /></p><p className="grid gap-2"><label htmlFor="password">كلمة المرور</label><Input id="password" name="password" type="password" autoComplete="current-password" required /></p></form></CardContent><CardFooter><Button className="w-full" form="login-form" type="submit">دخول</Button></CardFooter></Card></main>;
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>تسجيل الدخول</title><script src="/review/assets/theme.js"></script><link rel="stylesheet" href="/review/assets/client.css"></head><body>${renderToStaticMarkup(form)}</body></html>`;
}
