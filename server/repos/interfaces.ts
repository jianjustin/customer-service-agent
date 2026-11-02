// 数据访问层接口（SPEC §A.4）。实现均为同步函数（better-sqlite3），可组合在 tx() 内。
// 把 OrderRepo 等换成业务 API / 多维表格适配器时，实现同名接口即可。
import type {
  AiRunRow,
  ConversationRow,
  CustomerRow,
  ExecutionLogRow,
  KnowledgeEntry,
  LogScope,
  MessageRow,
  MessageSource,
  NotificationPayload,
  OrderRow,
  OutboxRow,
  PaymentRow,
  RefundDecisionRow,
  RefundExecutionRow,
  RefundRequestRow,
  RefundStatus,
  ReviewerRow,
  SeatRow,
  SenderType,
  TicketRow,
  TicketStatus,
} from "../domain/types";

export interface IdentityRepo {
  getCustomer(id: string): CustomerRow | undefined;
  listCustomers(): CustomerRow[];
  getSeat(id: string): SeatRow | undefined;
  listSeats(): SeatRow[]; // ORDER BY sort_order
  setSeatOnline(id: string, online: boolean): number; // 返回 changes
  getReviewer(id: string): ReviewerRow | undefined;
  listReviewers(): ReviewerRow[];
}

export interface OrderRepo {
  get(id: string): OrderRow | undefined;
  listByCustomer(customerId: string): OrderRow[]; // ORDER BY created_at DESC, id
  getPayment(orderId: string): PaymentRow | undefined;
  markRefunded(orderId: string, at: string): number; // UPDATE … WHERE id=? AND payment_status='paid'
  markPaymentRefunded(orderId: string): number; // UPDATE payments SET status='refunded' WHERE order_id=? AND status='succeeded'
  consumeSimulatedFailure(orderId: string): number; // simulate_refund_failure-1 WHERE id=? AND simulate_refund_failure>0
}

export interface TicketRepo {
  get(id: string): TicketRow | undefined;
  insert(row: Omit<TicketRow, "ai_summary" | "handover_requested" | "handover_reason" | "assigned_at" | "closed_at">): void;
  listByCustomer(customerId: string): TicketRow[]; // ORDER BY created_at DESC, rowid DESC
  listBySeat(seatId: string, status?: TicketStatus): TicketRow[];
  latestOpenForCustomer(customerId: string): TicketRow | undefined; // status!='closed' ORDER BY created_at DESC, rowid DESC LIMIT 1
  countAssigned(seatId: string): number; // status='assigned' AND seat_id=?
  listQueued(): TicketRow[]; // status='queued' ORDER BY created_at, rowid
  /** 条件更新：WHERE id=? AND status=fromStatus；queued→assigned 或 assigned→assigned（转派）。返回 changes */
  assign(id: string, seatId: string, at: string, fromStatus: "queued" | "assigned"): number;
  close(id: string, at: string): number;
  setSummary(id: string, summary: string, at: string): void;
  setHandoverRequested(id: string, reason: string, at: string): number;
}

export interface ConversationRepo {
  get(id: string): ConversationRow | undefined;
  getByTicket(ticketId: string): ConversationRow | undefined;
  insert(row: ConversationRow): void;
  takeover(id: string, at: string): number; // handling_mode='human', ai_generation+1 WHERE handling_mode='ai'
  resumeAi(id: string, at: string): number; // handling_mode='ai' WHERE handling_mode='human'
  bumpGeneration(id: string, at: string): number;
}

export interface MessageInsert {
  conversationId: string;
  senderType: SenderType;
  senderId: string | null;
  content: string;
  sources?: MessageSource[];
  aiRunId?: number | null;
  clientMessageId?: string | null;
  at: string;
}
export interface MessageRepo {
  insert(m: MessageInsert): MessageRow; // seq = COALESCE(MAX(seq),0)+1（同一条语句内计算）
  insertIgnoreByClientId(m: MessageInsert & { clientMessageId: string }): { row: MessageRow; duplicate: boolean };
  findCustomerMessageByClientId(customerId: string, clientMessageId: string): MessageRow | undefined; // sender_type='customer' AND sender_id=? AND client_message_id=?
  list(conversationId: string, afterSeq?: number): MessageRow[]; // ORDER BY seq
  get(id: number): MessageRow | undefined;
}

export interface AiRunRepo {
  insert(conversationId: string, triggerMessageId: number, generation: number, at: string): AiRunRow;
  get(id: number): AiRunRow | undefined;
  markRunning(id: number, at: string): number; // WHERE id=? AND status='queued'
  complete(id: number, replyMessageId: number, at: string): number; // WHERE id=? AND status='running'
  suppress(id: number, at: string): number; // WHERE id=? AND status IN ('running','cancelled')
  fail(id: number, error: string, at: string): number; // WHERE id=? AND status IN ('queued','running')
  cancelActive(conversationId: string, at: string): number; // status IN ('queued','running') → 'cancelled'
  markHandoverRequested(id: number): number; // WHERE id=? AND status='running'
  listActive(): AiRunRow[]; // status IN ('queued','running')
  hasPending(conversationId: string): boolean;
  listByConversation(conversationId: string, limit: number): AiRunRow[];
}

export interface RefundRepo {
  get(id: string): RefundRequestRow | undefined;
  findActiveByOrder(orderId: string): RefundRequestRow | undefined; // status NOT IN ('rejected','failed')
  countByOrder(orderId: string): number;
  insert(row: RefundRequestRow): void;
  listByCustomer(customerId: string): RefundRequestRow[]; // 倒序
  listByTicket(ticketId: string): RefundRequestRow[]; // 正序
  listAll(status?: RefundStatus): RefundRequestRow[]; // 倒序
  listFlowOpen(): RefundRequestRow[]; // flow_completed_at IS NULL ORDER BY created_at
  transition(id: string, from: RefundStatus[], to: RefundStatus, at: string, extra?: { failureReason?: string | null }): number;
  prepareRetry(id: string, expectedAttempt: number, newThreadId: string, at: string): number;
  markFlowCompleted(id: string, at: string): number; // WHERE id=? AND flow_completed_at IS NULL
  getDecision(requestId: string): RefundDecisionRow | undefined;
  insertDecision(row: RefundDecisionRow): void; // 违反 UNIQUE 抛 SqliteError(code 'SQLITE_CONSTRAINT_UNIQUE')
  listExecutions(requestId: string): RefundExecutionRow[];
  getSuccessExecution(requestId: string): RefundExecutionRow | undefined;
  getExecution(requestId: string, attempt: number): RefundExecutionRow | undefined;
  sumSuccessByOrder(orderId: string): number;
  insertExecution(row: RefundExecutionRow): void;
}

export interface OutboxRepo {
  enqueue(e: { dedupeKey: string; conversationId: string; payload: NotificationPayload; at: string }): { inserted: boolean }; // INSERT OR IGNORE
  due(now: string, limit: number): OutboxRow[]; // status='pending' AND next_attempt_at<=? ORDER BY id LIMIT ?
  markSent(id: number, at: string): number; // WHERE id=? AND status='pending'
  markRetry(id: number, attempts: number, nextAt: string, error: string): number;
  markFailed(id: number, attempts: number, error: string): number;
  listByConversation(conversationId: string): OutboxRow[];
  listByDedupePrefix(prefix: string): OutboxRow[];
}

export interface LogRepo {
  /** dedupeKey 存在时 INSERT OR IGNORE */
  write(e: { scope: LogScope; refId: string; node: string; event: string; detail?: unknown; dedupeKey?: string; at?: string }): void;
  list(scope: LogScope, refId: string): ExecutionLogRow[];
  count(scope: LogScope, filter?: { event?: string; node?: string }): number;
}

export interface KnowledgeRepo {
  upsertAll(entries: KnowledgeEntry[], at: string): void;
  listAll(): KnowledgeEntry[];
}

export interface AssignmentStateRepo {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

export interface Repos {
  identity: IdentityRepo;
  orders: OrderRepo;
  tickets: TicketRepo;
  conversations: ConversationRepo;
  messages: MessageRepo;
  aiRuns: AiRunRepo;
  refunds: RefundRepo;
  outbox: OutboxRepo;
  logs: LogRepo;
  knowledge: KnowledgeRepo;
  assignmentState: AssignmentStateRepo;
}
