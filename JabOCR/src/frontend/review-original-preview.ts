export function installOriginalPreview(document: Pick<Document, "getElementById" | "querySelectorAll">): void {
  const triggers = Array.from(document.querySelectorAll(".original-preview-trigger")) as HTMLAnchorElement[];
  const dialog = document.getElementById("original-preview-dialog") as HTMLDialogElement | null;
  const image = document.getElementById("original-preview-image") as HTMLImageElement | null;
  const close = document.getElementById("original-preview-close") as HTMLButtonElement | null;
  if (!triggers.length || !dialog || !image || !close) return;

  let lastTrigger: HTMLAnchorElement | null = null;
  const closePreview = (): void => dialog.close();
  for (const trigger of triggers) {
    trigger.addEventListener("click", (event) => {
      event.preventDefault();
      lastTrigger = trigger;
      image.src = trigger.href;
      dialog.showModal();
      close.focus();
    });
  }
  close.addEventListener("click", closePreview);
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); closePreview(); });
  dialog.addEventListener("click", (event) => { if (event.target === dialog) closePreview(); });
  dialog.addEventListener("close", () => { image.src = ""; lastTrigger?.focus(); });
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => installOriginalPreview(document), { once: true });
  else installOriginalPreview(document);
}
