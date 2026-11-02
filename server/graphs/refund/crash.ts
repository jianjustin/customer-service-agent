// 崩溃点注入（SPEC §A.8 / §H.7）：一次性，命中即从集合删除并抛 SimulatedCrash。
import type { RefundNodeName } from "./node-names";

export type CrashPointName = `before:${RefundNodeName}` | `after:${RefundNodeName}` | "mid:execute_refund";

export class SimulatedCrash extends Error {
  constructor(public point: CrashPointName) {
    super("simulated crash at " + point);
    this.name = "SimulatedCrash";
  }
}

export interface CrashPoints {
  /** 命中则从集合删除并 throw SimulatedCrash（一次性） */
  trip(point: CrashPointName): void;
}

export function createCrashPoints(points?: Iterable<CrashPointName>): CrashPoints {
  const set = new Set<CrashPointName>(points ?? []);
  return {
    trip(point) {
      if (set.delete(point)) throw new SimulatedCrash(point);
    },
  };
}
