import { expect, test } from "bun:test";
import { installOriginalPreview } from "../src/review-original-preview";

type Listener = (event: { preventDefault(): void; target?: unknown }) => void;

class FakeElement {
  readonly listeners = new Map<string, Listener[]>();
  focused = false;
  addEventListener(type: string, listener: Listener): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  dispatch(type: string, target: unknown = this): { prevented: boolean } { let prevented = false; for (const listener of this.listeners.get(type) ?? []) listener({ target, preventDefault: () => { prevented = true; } }); return { prevented }; }
  focus(): void { this.focused = true; }
}

class FakeDialog extends FakeElement {
  open = false;
  showModal(): void { this.open = true; }
  close(): void { this.open = false; this.dispatch("close"); }
}

test("image preview opens only on activation and closes accessibly", () => {
  const trigger = Object.assign(new FakeElement(), { href: "/review/bills/bill/original" });
  const dialog = new FakeDialog(); const image = Object.assign(new FakeElement(), { src: "" }); const close = new FakeElement();
  installOriginalPreview({ getElementById: (id: string) => ({ "original-preview-trigger": trigger, "original-preview-dialog": dialog, "original-preview-image": image, "original-preview-close": close })[id] ?? null } as never);

  expect(image.src).toBe("");
  expect(trigger.dispatch("click").prevented).toBe(true); expect(dialog.open).toBe(true); expect(image.src).toBe(trigger.href); expect(close.focused).toBe(true);
  expect(dialog.dispatch("cancel").prevented).toBe(true); expect(dialog.open).toBe(false); expect(image.src).toBe(""); expect(trigger.focused).toBe(true);
  trigger.focused = false; trigger.dispatch("click"); dialog.dispatch("click", dialog); expect(dialog.open).toBe(false); expect(image.src).toBe(""); expect(trigger.focused).toBe(true);
});

test("does nothing when the detail-page preview markup is absent", () => {
  expect(() => installOriginalPreview({ getElementById: () => null } as never)).not.toThrow();
});
