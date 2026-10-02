export const MAX_PROJECT_BACKGROUND_BYTES = 5 * 1024 * 1024;

const allowedMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);

export type ProjectBackgroundFileError = 'projectBackgroundTooLarge' | 'projectBackgroundUnsupportedType';

export function validateProjectBackgroundFile(file: Pick<File, 'size' | 'type'>): ProjectBackgroundFileError | undefined {
  if (file.size > MAX_PROJECT_BACKGROUND_BYTES) return 'projectBackgroundTooLarge';
  if (!allowedMimeTypes.has(file.type.toLowerCase())) return 'projectBackgroundUnsupportedType';
  return undefined;
}

export function readProjectBackgroundDataUrl(file: Blob, onProgress?: (percent: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(Math.round((event.loaded / event.total) * 100));
    };
    reader.onerror = () => reject(new Error('File read failed'));
    reader.onabort = () => reject(new Error('File read was cancelled'));
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('File read failed'));
    };
    reader.readAsDataURL(file);
  });
}
