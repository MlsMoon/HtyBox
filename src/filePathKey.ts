/** 与 Rust `watch_path_key` 同契约：斜杠归一、反复去掉 `//?/` 前缀、小写。 */
export function filePathKey(path: string): string {
  let s = path.replace(/\\/g, "/");
  while (s.startsWith("//?/")) s = s.slice(4);
  return s.toLowerCase();
}
