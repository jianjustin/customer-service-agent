// 身份解析与角色守卫（SPEC §D.1）。
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Actor, Role } from "../domain/types";
import { AppError } from "../errors";
import type { Container } from "../container";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      actor?: Actor;
    }
  }
}

const ROLES: readonly Role[] = ["customer", "agent", "reviewer"];

const unauthenticated = () => new AppError(401, "UNAUTHENTICATED", "身份无效，请重新选择身份");

function header(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** 解析 x-role / x-actor-id 并在对应表中校验；失败 401 */
export function authenticate(c: Container): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const role = header(req, "x-role");
    const id = header(req, "x-actor-id");
    if (!role || !id || !(ROLES as readonly string[]).includes(role)) return next(unauthenticated());
    const row =
      role === "customer"
        ? c.repos.identity.getCustomer(id)
        : role === "agent"
          ? c.repos.identity.getSeat(id)
          : c.repos.identity.getReviewer(id);
    if (!row) return next(unauthenticated());
    req.actor = { role: role as Role, id: row.id, name: row.name };
    next();
  };
}

/** 路由组守卫：角色不符 403 */
export function requireRole(role: Role): RequestHandler {
  return (req, _res, next) => {
    if (!req.actor) return next(unauthenticated());
    if (req.actor.role !== role) return next(new AppError(403, "FORBIDDEN", "当前角色无权访问该功能"));
    next();
  };
}
