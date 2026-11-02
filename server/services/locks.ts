/**
 * 按 key 串行的互斥锁：每个 key 一条 promise 链，FIFO。
 * fn 抛错不影响后续排队者（错误仅传给该次调用方）。仅保证单进程内串行。
 */
export class KeyedMutex {
  private tails = new Map<string, Promise<void>>();

  withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    // prev 永不 reject（存入的都是吞掉异常后的 tail）
    const result = prev.then(() => fn());
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      // 队尾仍是自己说明没有后续排队者，清理以免 Map 无限增长
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /** 等待该 key 当前（以及等待期间新排入的）全部任务完成 */
  async idle(key: string): Promise<void> {
    for (let tail = this.tails.get(key); tail; tail = this.tails.get(key)) {
      await tail;
      // 让出一个微任务，使 tail 的清理回调先执行，避免对同一个 tail 空转
      await Promise.resolve();
    }
  }

  /** 等待所有 key 的排队任务全部完成（用于优雅关闭） */
  async idleAll(): Promise<void> {
    while (this.tails.size > 0) {
      await Promise.all([...this.tails.values()]);
      await Promise.resolve();
    }
  }

  isLocked(key: string): boolean {
    return this.tails.has(key);
  }
}
