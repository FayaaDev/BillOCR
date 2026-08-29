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
