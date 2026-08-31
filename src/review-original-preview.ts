export function installOriginalPreview(document: Pick<Document, "getElementById">): void {
  const trigger = document.getElementById("original-preview-trigger") as HTMLAnchorElement | null;
  const dialog = document.getElementById("original-preview-dialog") as HTMLDialogElement | null;
  const image = document.getElementById("original-preview-image") as HTMLImageElement | null;
  const close = document.getElementById("original-preview-close") as HTMLButtonElement | null;
  if (!trigger || !dialog || !image || !close) return;

  const closePreview = (): void => dialog.close();
  trigger.addEventListener("click", (event) => {
    event.preventDefault();
    image.src = trigger.href;
    dialog.showModal();
    close.focus();
  });
  close.addEventListener("click", closePreview);
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); closePreview(); });
  dialog.addEventListener("click", (event) => { if (event.target === dialog) closePreview(); });
  dialog.addEventListener("close", () => { image.src = ""; trigger.focus(); });
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => installOriginalPreview(document), { once: true });
  else installOriginalPreview(document);
}
