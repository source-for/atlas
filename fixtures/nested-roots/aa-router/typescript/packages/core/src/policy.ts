export function allow(path: string): boolean {
  return !path.startsWith("/admin");
}
