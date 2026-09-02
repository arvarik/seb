import { open, stat } from 'node:fs/promises';

/** Reads one regular UTF-8 file without allocating beyond the configured limit. */
export async function readBoundedUtf8File(
  path: string,
  maximumBytes: number,
  tooLargeError: () => Error,
): Promise<string | null> {
  let initial: Awaited<ReturnType<typeof stat>>;
  try {
    initial = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!initial.isFile()) {
    throw new TypeError('The local configuration path must select a regular file.');
  }
  if (initial.size > maximumBytes) throw tooLargeError();

  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const current = await file.stat();
    if (!current.isFile()) {
      throw new TypeError('The local configuration path must select a regular file.');
    }
    if (current.size > maximumBytes) throw tooLargeError();

    const content = Buffer.allocUnsafe(maximumBytes + 1);
    let offset = 0;
    while (offset < content.length) {
      const { bytesRead } = await file.read(
        content,
        offset,
        content.length - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maximumBytes) throw tooLargeError();
    return content.subarray(0, offset).toString('utf8');
  } finally {
    await file.close();
  }
}
