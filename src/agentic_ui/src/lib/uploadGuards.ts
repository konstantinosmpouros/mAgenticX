export const MAX_SINGLE_FILE_MB = 200;   // mirror backend per-file cap (example)
export const MAX_TOTAL_FILES_MB = 500;   // mirror backend total cap (example)
export const PROXY_LIMIT_MB = 600;  // must match nginx client_max_body_size
const B = 1024 * 1024;
const inflateBase64 = (bytes: number) => Math.ceil(bytes * 4 / 3);


export function validateAttachmentsForUpload(files: File[]): string | null {
    // Per-file cap
    const tooBig = files.find(f => f.size > MAX_SINGLE_FILE_MB * B);
    if (tooBig) {
        return `File "${tooBig.name}" exceeds ${MAX_SINGLE_FILE_MB} MB.`;
    }
    
    // Total cap (raw)
    const totalRaw = files.reduce((s, f) => s + f.size, 0);
    if (totalRaw > MAX_TOTAL_FILES_MB * B) {
        return `Total attachments exceed ${MAX_TOTAL_FILES_MB} MB.`;
    }
    
    // Proxy cap (after base64 inflation)
    const totalInflated = files.reduce((s, f) => s + inflateBase64(f.size), 0);
    if (totalInflated > PROXY_LIMIT_MB * B) {
        return `Payload too large for server limit (~${Math.ceil(totalInflated / B)} MB > ${PROXY_LIMIT_MB} MB).`;
    }
    
    return null;
}


export function validateAdd(existing: File[], adding: File[]): string | null {
    const combined: File[] = [...existing, ...adding];
    return validateAttachmentsForUpload(combined);
}