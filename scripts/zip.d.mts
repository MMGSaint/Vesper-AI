/** Types for the dependency-free ZIP writer used by the packaging step. */
export interface ZipEntry {
  /** Path inside the archive; forward slashes. */
  name: string;
  data: Buffer;
}

export function createZip(entries: ZipEntry[]): Buffer;
