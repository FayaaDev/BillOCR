import { dlopen, FFIType } from "bun:ffi";

type NativeOpen = { openat(dirfd: number, path: string, flags: number, mode: number): number; close(fd: number): number };
export type BeforeOpenRootComponent = (component: string) => Promise<void>;

const platform = process.platform === "darwin"
  ? { library: "/usr/lib/libSystem.B.dylib", atFdcwd: -2, readOnly: 0, directory: 0x100000, noFollow: 0x100, closeOnExec: 0x1000000 }
  : process.platform === "linux"
    ? { library: "libc.so.6", atFdcwd: -100, readOnly: 0, directory: 0x10000, noFollow: 0x20000, closeOnExec: 0x80000 }
    : null;

const native: NativeOpen | null = platform && dlopen(platform.library, {
  openat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
}).symbols;

// Bun 1.2.23 requires explicit null-terminated bytes for FFI cstring arguments.
const cstring = (value: string): string => Buffer.from(`${value}\0`) as unknown as string;

function requireNative(): { native: NativeOpen; platform: NonNullable<typeof platform> } {
  if (!native || !platform) throw new Error("descriptor-relative original reads are unsupported on this platform");
  return { native, platform };
}

/** Walks from trusted /; every configured-root component is opened descriptor-relatively. */
export async function openOriginalRoot(components: readonly string[], beforeOpenComponent?: BeforeOpenRootComponent): Promise<number> {
  const { native, platform } = requireNative();
  let current = native.openat(platform.atFdcwd, cstring("/"), platform.readOnly | platform.directory | platform.noFollow | platform.closeOnExec, 0);
  if (current < 0) return -1;
  try {
    for (const component of components) {
      await beforeOpenComponent?.(component);
      const next = native.openat(current, cstring(component), platform.readOnly | platform.directory | platform.noFollow | platform.closeOnExec, 0);
      if (next < 0) { native.close(current); return -1; }
      native.close(current);
      current = next;
    }
    return current;
  } catch (error) {
    native.close(current);
    throw error;
  }
}

/** Opens a single direct child of an already-opened configured directory. */
export function openOriginalChild(rootFd: number, basename: string): number {
  const { native, platform } = requireNative();
  return native.openat(rootFd, cstring(basename), platform.readOnly | platform.noFollow | platform.closeOnExec, 0);
}

export function closeOriginalFd(fd: number): void {
  if (fd >= 0) requireNative().native.close(fd);
}
