import { open } from "node:fs/promises";

// Reading a whole video into memory to upload it is what the deployed 1GB
// VM cannot afford (docs/adr/0001-oracle-free-vm-and-dynamic-dns.md), so
// adapters read the file a window at a time through this port. It is a
// port rather than a direct fs call so a test can assert what was actually
// read, which is the only cheap, deterministic proxy for "never
// materialises the whole file".

export interface VideoFile {
  /** Total size in bytes, read once when the file is opened. */
  readonly size: number;
  // Short at end-of-file, never longer. The buffer type is pinned to
  // ArrayBuffer (not the wider ArrayBufferLike) because these bytes go
  // straight into a fetch body, which will not accept a shared buffer.
  read(offset: number, length: number): Promise<Uint8Array<ArrayBuffer>>;
  close(): Promise<void>;
}

export type OpenVideoFile = (filePath: string) => Promise<VideoFile>;

export const openVideoFile: OpenVideoFile = async (filePath) => {
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    return {
      size,
      async read(offset, length) {
        const wanted = Math.min(length, Math.max(size - offset, 0));
        const buffer = new Uint8Array(wanted);
        const { bytesRead } = await handle.read(buffer, 0, wanted, offset);
        return buffer.subarray(0, bytesRead);
      },
      close: () => handle.close(),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
};
