import { invoke } from "@tauri-apps/api/tauri";

export const isTauri = () => Boolean((window as any).__TAURI__);

export async function invokeSafe<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isTauri()) return null;
  return invoke<T>(cmd, args);
}
