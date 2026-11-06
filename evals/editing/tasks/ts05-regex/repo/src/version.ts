/** "1.2" or "1.2.3" (major.minor[.patch]). */
export function isVersion(s: string): boolean {
  return /^\d+\.\d+$/.test(s);
}

export const SEP = '\\';
