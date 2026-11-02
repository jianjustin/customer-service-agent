import { useCallback, useState } from "react";
import type { Role } from "../types";

/** 身份选择，存 localStorage（键 csa.identity.${role}），读写均包 try/catch */
export function useIdentity(role: Role, defaultId: string): [string, (id: string) => void] {
  const key = `csa.identity.${role}`;
  const [id, setId] = useState<string>(() => {
    try {
      return localStorage.getItem(key) || defaultId;
    } catch {
      return defaultId;
    }
  });
  const update = useCallback(
    (next: string) => {
      setId(next);
      try {
        localStorage.setItem(key, next);
      } catch {
        /* 忽略存储失败 */
      }
    },
    [key],
  );
  return [id, update];
}
