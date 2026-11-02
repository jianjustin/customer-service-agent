import { Router } from "express";
import type { Container } from "../container";

/** GET /api/bootstrap（无需身份）：身份列表与当前模型模式 */
export function bootstrapRouter(c: Container): Router {
  const r = Router();
  r.get("/", (_req, res) => {
    res.json({
      customers: c.repos.identity.listCustomers().map((x) => ({ id: x.id, name: x.name })),
      seats: c.repos.identity
        .listSeats()
        .map((s) => ({ id: s.id, name: s.name, online: s.online === 1, capacity: s.capacity })),
      reviewers: c.repos.identity.listReviewers().map((x) => ({ id: x.id, name: x.name })),
      model: c.modelInfo,
    });
  });
  return r;
}
