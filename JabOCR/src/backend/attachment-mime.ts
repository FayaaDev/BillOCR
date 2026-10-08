export function canonicalImageExtension(mimeType: string | null | undefined): ".jpg" | ".png" | ".webp" | null {
  switch (mimeType?.toLowerCase()) {
    case "image/jpeg": return ".jpg";
    case "image/png": return ".png";
    case "image/webp": return ".webp";
    default: return null;
  }
}

export function isSupportedImageMimeType(mimeType: string | null | undefined): boolean {
  return canonicalImageExtension(mimeType) !== null;
}

export function isSupportedDocumentMimeType(mimeType: string | null | undefined): boolean {
  return isSupportedImageMimeType(mimeType) || mimeType?.toLowerCase() === "application/pdf";
}

export function canonicalAttachmentExtension(mimeType: string | null | undefined): ".jpg" | ".png" | ".webp" | ".pdf" | null {
  return canonicalImageExtension(mimeType) ?? (mimeType?.toLowerCase() === "application/pdf" ? ".pdf" : null);
}

/** Determines an accepted document type solely from bytes, never a supplied filename or MIME type. */
export function sniffSupportedDocumentMimeType(bytes: Uint8Array): "application/pdf" | "image/png" | "image/jpeg" | "image/webp" | null {
  const at = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (at(37, 80, 68, 70, 45)) return "application/pdf";
  if (at(137, 80, 78, 71, 13, 10, 26, 10)) return "image/png";
  if (at(255, 216, 255)) return "image/jpeg";
  if (at(82, 73, 70, 70) && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) return "image/webp";
  return null;
}
