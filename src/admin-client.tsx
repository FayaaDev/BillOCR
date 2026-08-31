import { useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Moon, RefreshCw, Sun } from "lucide-react";
import { parseAdminOverview, whatsappPairingView, type AdminOverview } from "./admin-dashboard";

const stateLabel: Record<AdminOverview["whatsapp"]["state"], string> = { connecting: "جارٍ الاتصال", connected: "متصل", awaiting_pairing: "بانتظار الاقتران", unavailable: "غير متاح" };

function copy(value: string): void {
  void navigator.clipboard?.writeText(value).catch(() => undefined);
}

function Dashboard(): ReactNode {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [error, setError] = useState(false);
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const load = (): void => {
    setError(false);
    void fetch("/admin/api/overview", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => response.ok ? parseAdminOverview(await response.json()) : null)
      .then((payload) => { if (!payload) throw new Error("invalid admin response"); setOverview(payload); })
      .catch(() => setError(true));
  };
  useEffect(load, []);
  const pairingView = overview && whatsappPairingView(overview.whatsapp.state, overview.whatsapp.canPair);
  useEffect(() => {
    if (pairingView !== "waiting" && pairingView !== "qr") return;
    const timer = setTimeout(load, 5_000);
    return () => clearTimeout(timer);
  }, [pairingView]);
  const toggleTheme = (): void => { const next = !dark; document.documentElement.classList.toggle("dark", next); try { localStorage.setItem("review-theme", next ? "dark" : "light"); } catch {} setDark(next); };
  const metrics = overview?.metrics;
  return <main className="admin-page">
    <header className="admin-header"><div><p className="admin-eyebrow">إدارة التشغيل</p><h1>لوحة متابعة الفواتير</h1><p className="admin-subtitle">عرض حالة الاستلام والربط دون كشف بيانات الاعتماد.</p><nav className="admin-tabs" aria-label="التنقل الإداري"><a className="admin-tab" href="/admin" aria-current="page">لوحة الإدارة</a><a className="admin-tab" href="/review">مراجعة الفواتير</a></nav></div><div className="admin-header-actions"><button className="admin-icon-button" type="button" onClick={load} aria-label="تحديث البيانات"><RefreshCw /></button><button className="admin-icon-button" type="button" onClick={toggleTheme} aria-label={dark ? "التبديل إلى الوضع الفاتح" : "التبديل إلى الوضع الداكن"}>{dark ? <Sun /> : <Moon />}</button></div></header>
    {error && <p className="notice error">تعذر تحميل بيانات لوحة الإدارة. حدّث الصفحة وحاول مرة أخرى.</p>}
    <section className="admin-metrics" aria-label="ملخص الفواتير">
      {[ ["الفواتير المستلمة", metrics?.received], ["الفواتير المعتمدة", metrics?.approved], ["الفواتير الفاشلة", metrics?.failed] ].map(([label, value]) => <article className="admin-card" key={String(label)}><p>{label}</p><strong dir="ltr">{value ?? "—"}</strong></article>)}
    </section>
    <section className="admin-card admin-whatsapp" aria-labelledby="whatsapp-heading"><div className="admin-section-heading"><div><h2 id="whatsapp-heading">واتساب</h2><p>الحالة: <b>{overview ? stateLabel[overview.whatsapp.state] : "جارٍ التحميل…"}</b></p></div>{overview?.whatsapp.state === "awaiting_pairing" && <span className="admin-status">يتم التحديث تلقائيًا</span>}</div>
      {pairingView === "waiting" && <p className="notice">يتم الاتصال بواتساب وتجهيز رمز الاقتران. يرجى الانتظار.</p>}
      {pairingView === "qr" && <div className="admin-qr"><img src="/admin/api/whatsapp/qr" alt="رمز QR لاقتران واتساب" /><p>امسح الرمز من جهاز واتساب. لا يُعرض رمز الاقتران النصي في هذه الصفحة.</p></div>}
      <label className="admin-field"><span>معرّف المجموعة المكوّنة</span><div><input dir="ltr" value={overview?.whatsapp.configuredGroupId ?? ""} readOnly aria-label="معرّف المجموعة المكوّنة" /><button type="button" onClick={() => overview && copy(overview.whatsapp.configuredGroupId)}>نسخ</button></div></label>
      <p className="admin-hint">لا يمكن تغيير المجموعة المكوّنة من لوحة الإدارة. يلزم أن يغيّرها المشغّل في الإعدادات ثم يعيد تشغيل الخدمة.</p>
      {pairingView === "qr" && <form method="post" action="/admin/whatsapp/pairing/cancel" onSubmit={(event) => { if (!confirm("هل تريد إلغاء الاقتران الجاري؟")) event.preventDefault(); }}><input type="hidden" name="csrf" value={overview!.whatsapp.csrf} /><button className="admin-danger-button" type="submit">إلغاء الاقتران</button></form>}
      {pairingView === "start" && <form method="post" action="/admin/whatsapp/pairing/start"><input type="hidden" name="csrf" value={overview!.whatsapp.csrf} /><button className="admin-danger-button" type="submit">الاقتران الآن</button></form>}
      {pairingView === "unavailable" && <p className="notice">لا يدعم هذا النقل بدء الاقتران من لوحة الإدارة.</p>}
    </section>
    <section className="admin-card" aria-labelledby="groups-heading"><h2 id="groups-heading">المجموعات المكتشفة</h2><p className="admin-hint">تظهر المجموعات عند وجود اتصال نشط فقط. المعرفات للقراءة والنسخ فقط.</p>{overview?.whatsapp.state === "unavailable" ? <p className="notice">تتطلب هذه القائمة اتصال واتساب نشطًا.</p> : <ul className="admin-groups">{overview?.whatsapp.groups.map((group) => <li key={group.id}><span>{group.name ?? "مجموعة بدون اسم"}</span><code dir="ltr">{group.id}</code><button type="button" onClick={() => copy(group.id)}>نسخ</button></li>) ?? <li>جارٍ التحميل…</li>}{overview?.whatsapp.groups.length === 0 && <li>لا توجد مجموعات مكتشفة حاليًا.</li>}</ul>}</section>
  </main>;
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Dashboard />);
