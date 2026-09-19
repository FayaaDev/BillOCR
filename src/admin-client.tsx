import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Moon, RefreshCw, Sun } from "lucide-react";
import { parseAdminOverview, parseAdminZipStatus, type AdminOverview, type AdminZipStatus } from "./admin-dashboard";
import { ZipUploadSession, zipUploadControlDisabled } from "./admin-zip-client";

const zipStateLabel: Record<AdminZipStatus["items"][number]["state"], string> = { queued: "في الانتظار", processing: "قيد المعالجة", complete: "مكتملة", not_invoice: "ليست فاتورة", rejected: "مرفوضة", failed: "فشلت" };

function copy(value: string): void {
  void navigator.clipboard?.writeText(value).catch(() => undefined);
}

function Dashboard(): ReactNode {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [channel, setChannel] = useState<"telegram" | "zip">("telegram");
  const [error, setError] = useState(false);
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [batch, setBatch] = useState<AdminZipStatus | null>(null);
  const [uploadError, setUploadError] = useState(false);
  const zipSession = useRef<ZipUploadSession | null>(null);
  const load = (): void => {
    setError(false);
    void fetch("/admin/api/overview", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => response.ok ? parseAdminOverview(await response.json()) : null)
      .then((payload) => { if (!payload) throw new Error("invalid admin response"); setOverview(payload); })
      .catch(() => setError(true));
  };
  useEffect(load, []);
  const getZipSession = (): ZipUploadSession => zipSession.current ??= new ZipUploadSession({
    createSourceId: () => crypto.randomUUID(), createRequest: () => new XMLHttpRequest(),
    fetchStatus: async (batchId) => { const response = await fetch(`/admin/api/zip/${encodeURIComponent(batchId)}`, { credentials: "same-origin", cache: "no-store" }); return response.ok ? parseAdminZipStatus(await response.json()) : null; },
    schedule: (callback, delayMs) => setTimeout(callback, delayMs), cancel: clearTimeout,
    onProgress: setProgress, onUploading: setUploading, onStatus: setBatch, onError: () => setUploadError(true),
  });
  useEffect(() => () => zipSession.current?.dispose(), []);
  const submitZip = (): void => {
    if (!file || !overview?.zip.available || uploading) return;
    setUploading(true); setUploadError(false); setProgress(0); setBatch(null);
    getZipSession().submit(file, overview.zip.csrf);
  };
  const toggleTheme = (): void => { const next = !dark; document.documentElement.classList.toggle("dark", next); try { localStorage.setItem("review-theme", next ? "dark" : "light"); } catch {} setDark(next); };
  const changeChannel = (event: KeyboardEvent<HTMLButtonElement>): void => { const channels = ["telegram", "zip"] as const; const index = channels.indexOf(channel); const next = event.key === "ArrowLeft" ? (index + 1) % channels.length : event.key === "ArrowRight" ? (index + channels.length - 1) % channels.length : event.key === "Home" ? 0 : event.key === "End" ? channels.length - 1 : null; if (next === null) return; const selected = channels[next]!; event.preventDefault(); setChannel(selected); document.getElementById(`${selected}-tab`)?.focus(); };
  const metrics = overview?.metrics;
  return <main className="admin-page">
    <header className="admin-header"><div><p className="admin-eyebrow">إدارة التشغيل</p><h1>لوحة متابعة الفواتير</h1><p className="admin-subtitle">عرض حالة الاستلام والربط دون كشف بيانات الاعتماد.</p><nav className="admin-tabs" aria-label="التنقل الإداري"><a className="admin-tab" href="/admin" aria-current="page">لوحة الإدارة</a><a className="admin-tab" href="/review">مراجعة الفواتير</a></nav></div><div className="admin-header-actions"><button className="admin-icon-button" type="button" onClick={load} aria-label="تحديث البيانات"><RefreshCw /></button><button className="admin-icon-button" type="button" onClick={toggleTheme} aria-label={dark ? "التبديل إلى الوضع الفاتح" : "التبديل إلى الوضع الداكن"}>{dark ? <Sun /> : <Moon />}</button></div></header>
    {error && <p className="notice error">تعذر تحميل بيانات لوحة الإدارة. حدّث الصفحة وحاول مرة أخرى.</p>}
    <section className="admin-metrics" aria-label="ملخص الفواتير">
      {[ ["الفواتير المستلمة", metrics?.received], ["الفواتير المعتمدة", metrics?.approved], ["الفواتير الفاشلة", metrics?.failed] ].map(([label, value]) => <article className="admin-card" key={String(label)}><p>{label}</p><strong dir="ltr">{value ?? "—"}</strong></article>)}
    </section>
    <div className="admin-channel-tabs" role="tablist" aria-label="قنوات الاستلام"><button role="tab" type="button" disabled aria-disabled="true" id="whatsapp-tab">واتساب</button><button role="tab" type="button" tabIndex={channel === "telegram" ? 0 : -1} aria-selected={channel === "telegram"} aria-controls="telegram-panel" id="telegram-tab" onClick={() => setChannel("telegram")} onKeyDown={changeChannel}>تيليجرام</button><button role="tab" type="button" tabIndex={channel === "zip" ? 0 : -1} aria-selected={channel === "zip"} aria-controls="zip-panel" id="zip-tab" onClick={() => setChannel("zip")} onKeyDown={changeChannel}>رفع ZIP</button></div>
    <section hidden={channel !== "zip"} className="admin-card admin-zip" role="tabpanel" id="zip-panel" aria-labelledby="zip-tab"><h2 id="zip-heading">رفع فواتير ZIP</h2><p className="admin-hint">اختر ملف ZIP يحتوي على صور أو ملفات PDF للفواتير. الحد الأقصى للملف المضغوط: {overview ? `${Math.floor(overview.zip.maxCompressedBytes / (1024 * 1024))} ميغابايت` : "—"}.</p>
      {overview && !overview.zip.available ? <p className="notice error">رفع ملفات ZIP غير متاح حاليًا لأن خدمة التحليل غير مهيأة.</p> : <><label className="admin-field"><span>ملف ZIP</span><input type="file" accept=".zip,application/zip,application/x-zip-compressed" disabled={!overview || uploading} onChange={(event) => { zipSession.current?.reset(); setFile(event.target.files?.[0] ?? null); setUploadError(false); }} /></label>{file && <p className="admin-hint">الملف المحدد: <b dir="ltr">{file.name}</b></p>}<button className="admin-danger-button admin-upload-button" type="button" disabled={zipUploadControlDisabled(overview?.zip.available === true, file !== null, uploading)} onClick={submitZip}>{uploading ? "جارٍ الرفع…" : "رفع الملف"}</button>{progress !== null && <p className="admin-hint" role="status">تقدم الرفع: {progress}%</p>}</>}
      {uploadError && <p className="notice error">تعذر رفع الملف أو قراءة حالته. تحقق من ملف ZIP وحاول مرة أخرى.</p>}
      {batch && <div className="admin-zip-results" aria-live="polite"><p>نتيجة الرفع: {batch.counts.complete} مكتملة، {batch.counts.notInvoice} ليست فواتير، {batch.counts.rejected + batch.counts.failed} مرفوضة أو فاشلة، {batch.counts.queued + batch.counts.processing} قيد المعالجة.</p><ul>{batch.items.map((item) => <li key={`${item.entryPath}-${item.billId ?? ""}`}><code dir="ltr">{item.entryPath}</code><span>{zipStateLabel[item.state]}</span>{item.errorCode && <span>(تعذر قبول الملف)</span>}</li>)}</ul></div>}
    </section>
    <section hidden={channel !== "telegram"} className="admin-card" role="tabpanel" id="telegram-panel" aria-labelledby="telegram-tab"><h2>تيليجرام</h2><p>الحالة: <b>{overview?.telegram.enabled ? "مفعّل" : "غير مفعّل"}</b></p><p className="admin-hint">هذه المعلومات للقراءة فقط ولا تعرض رمز البوت.</p>{overview?.telegram.groupIds.length ? <ul className="admin-groups">{overview.telegram.groupIds.map((groupId) => <li key={groupId}><code dir="ltr">{groupId}</code><button type="button" onClick={() => copy(groupId)}>نسخ</button></li>)}</ul> : <p className="notice">لا توجد معرّفات مجموعات مكوّنة.</p>}</section>
  </main>;
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Dashboard />);
