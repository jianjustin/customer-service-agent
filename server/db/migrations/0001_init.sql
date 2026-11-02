CREATE TABLE customers (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE seats (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  online     INTEGER NOT NULL DEFAULT 1 CHECK (online IN (0, 1)),
  capacity   INTEGER NOT NULL DEFAULT 2 CHECK (capacity >= 0),
  sort_order INTEGER NOT NULL UNIQUE
);

CREATE TABLE reviewers (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE orders (
  id                      TEXT PRIMARY KEY,
  customer_id             TEXT NOT NULL REFERENCES customers(id),
  title                   TEXT NOT NULL,
  amount_minor            INTEGER NOT NULL CHECK (amount_minor > 0),
  currency                TEXT NOT NULL DEFAULT 'CNY',
  payment_status          TEXT NOT NULL CHECK (payment_status IN ('unpaid','paid','refunded')),
  shipping_status         TEXT NOT NULL DEFAULT 'none' CHECK (shipping_status IN ('none','pending','shipped','delivered')),
  tracking_no             TEXT,
  paid_at                 TEXT,
  refunded_at             TEXT,
  refund_note             TEXT,
  simulate_refund_failure INTEGER NOT NULL DEFAULT 0 CHECK (simulate_refund_failure >= 0),
  created_at              TEXT NOT NULL
);
CREATE INDEX idx_orders_customer ON orders(customer_id, created_at);

CREATE TABLE payments (
  id             TEXT PRIMARY KEY,
  order_id       TEXT NOT NULL REFERENCES orders(id),
  channel        TEXT NOT NULL CHECK (channel IN ('wechat','alipay','card')),
  status         TEXT NOT NULL CHECK (status IN ('pending','succeeded','failed','refunded')),
  amount_minor   INTEGER NOT NULL CHECK (amount_minor > 0),
  paid_at        TEXT,
  failure_reason TEXT,
  created_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_payments_order ON payments(order_id);

CREATE TABLE tickets (
  id                 TEXT PRIMARY KEY,
  customer_id        TEXT NOT NULL REFERENCES customers(id),
  seat_id            TEXT REFERENCES seats(id),
  status             TEXT NOT NULL CHECK (status IN ('queued','assigned','closed')),
  subject            TEXT NOT NULL,
  ai_summary         TEXT,
  handover_requested INTEGER NOT NULL DEFAULT 0 CHECK (handover_requested IN (0, 1)),
  handover_reason    TEXT,
  created_at         TEXT NOT NULL,
  assigned_at        TEXT,
  closed_at          TEXT,
  updated_at         TEXT NOT NULL,
  CHECK ((status = 'queued' AND seat_id IS NULL) OR (status = 'assigned' AND seat_id IS NOT NULL) OR status = 'closed')
);
CREATE INDEX idx_tickets_customer ON tickets(customer_id, status, created_at);
CREATE INDEX idx_tickets_seat ON tickets(seat_id, status);
CREATE INDEX idx_tickets_queue ON tickets(created_at) WHERE status = 'queued';

CREATE TABLE conversations (
  id                 TEXT PRIMARY KEY,
  ticket_id          TEXT NOT NULL UNIQUE REFERENCES tickets(id),
  customer_id        TEXT NOT NULL REFERENCES customers(id),
  channel            TEXT NOT NULL DEFAULT 'web' CHECK (channel IN ('web','wechat','feishu')),
  channel_session_id TEXT NOT NULL,
  thread_id          TEXT NOT NULL UNIQUE,
  handling_mode      TEXT NOT NULL DEFAULT 'ai' CHECK (handling_mode IN ('ai','human')),
  ai_generation      INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_conversations_channel_session ON conversations(channel, channel_session_id);
CREATE INDEX idx_conversations_customer ON conversations(customer_id);

CREATE TABLE messages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id   TEXT NOT NULL REFERENCES conversations(id),
  seq               INTEGER NOT NULL,
  sender_type       TEXT NOT NULL CHECK (sender_type IN ('customer','ai','agent','system')),
  sender_id         TEXT,
  content           TEXT NOT NULL,
  sources_json      TEXT NOT NULL DEFAULT '[]',
  ai_run_id         INTEGER,
  client_message_id TEXT,
  created_at        TEXT NOT NULL,
  UNIQUE (conversation_id, seq),
  UNIQUE (conversation_id, client_message_id)
);
-- 客户消息全局去重（首条消息时会话尚不存在，必须按 customer 维度去重）
CREATE UNIQUE INDEX ux_messages_customer_client ON messages(sender_id, client_message_id)
  WHERE sender_type = 'customer' AND client_message_id IS NOT NULL;
-- 每个 AI run 至多写回一条回复
CREATE UNIQUE INDEX ux_messages_ai_run ON messages(ai_run_id) WHERE ai_run_id IS NOT NULL;

CREATE TABLE ai_runs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id    TEXT NOT NULL REFERENCES conversations(id),
  trigger_message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id),
  generation         INTEGER NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('queued','running','completed','suppressed','cancelled','failed')),
  handover_requested INTEGER NOT NULL DEFAULT 0 CHECK (handover_requested IN (0, 1)),
  error              TEXT,
  reply_message_id   INTEGER REFERENCES messages(id),
  created_at         TEXT NOT NULL,
  started_at         TEXT,
  finished_at        TEXT
);
CREATE INDEX idx_ai_runs_conversation ON ai_runs(conversation_id, status);

CREATE TABLE refund_requests (
  id                TEXT PRIMARY KEY,
  customer_id       TEXT NOT NULL REFERENCES customers(id),
  ticket_id         TEXT NOT NULL REFERENCES tickets(id),
  conversation_id   TEXT NOT NULL REFERENCES conversations(id),
  order_id          TEXT NOT NULL REFERENCES orders(id),
  amount_minor      INTEGER NOT NULL CHECK (amount_minor > 0),
  currency          TEXT NOT NULL DEFAULT 'CNY',
  reason            TEXT NOT NULL,
  evidence_json     TEXT NOT NULL DEFAULT '{}',
  version           INTEGER NOT NULL CHECK (version >= 1),
  status            TEXT NOT NULL CHECK (status IN ('submitted','pending_review','approved','rejected','executing','refunded','failed')),
  idempotency_key   TEXT NOT NULL UNIQUE,
  thread_id         TEXT NOT NULL UNIQUE,
  attempt           INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  failure_reason    TEXT,
  flow_completed_at TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (order_id, version)
);
-- 同一订单同时只能有一条“活跃”申请
CREATE UNIQUE INDEX ux_refund_active_per_order ON refund_requests(order_id)
  WHERE status NOT IN ('rejected','failed');
CREATE INDEX idx_refund_customer ON refund_requests(customer_id, created_at);
CREATE INDEX idx_refund_ticket ON refund_requests(ticket_id);
CREATE INDEX idx_refund_status ON refund_requests(status, created_at);
CREATE INDEX idx_refund_flow_open ON refund_requests(created_at) WHERE flow_completed_at IS NULL;

CREATE TABLE refund_decisions (
  id                TEXT PRIMARY KEY,
  refund_request_id TEXT NOT NULL UNIQUE REFERENCES refund_requests(id),
  reviewer_id       TEXT NOT NULL REFERENCES reviewers(id),
  decision          TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  comment           TEXT NOT NULL,
  decided_at        TEXT NOT NULL
);

CREATE TABLE refund_executions (
  id                TEXT PRIMARY KEY,
  refund_request_id TEXT NOT NULL REFERENCES refund_requests(id),
  order_id          TEXT NOT NULL REFERENCES orders(id),
  attempt           INTEGER NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('success','failed')),
  amount_minor      INTEGER NOT NULL,
  failure_reason    TEXT,
  executed_at       TEXT NOT NULL,
  UNIQUE (refund_request_id, attempt)
);
CREATE UNIQUE INDEX ux_refund_exec_success_request ON refund_executions(refund_request_id) WHERE status = 'success';
CREATE UNIQUE INDEX ux_refund_exec_success_order ON refund_executions(order_id) WHERE status = 'success';

CREATE TABLE outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL CHECK (kind IN ('customer_notification')),
  dedupe_key      TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  payload_json    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  sent_at         TEXT,
  last_error      TEXT
);
CREATE INDEX idx_outbox_due ON outbox(status, next_attempt_at);

CREATE TABLE execution_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope       TEXT NOT NULL CHECK (scope IN ('conversation','refund','outbox','mcp','assignment')),
  ref_id      TEXT NOT NULL,
  node        TEXT NOT NULL,
  event       TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  dedupe_key  TEXT UNIQUE,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_logs_ref ON execution_logs(scope, ref_id, id);

CREATE TABLE assignment_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE knowledge_entries (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  version       INTEGER NOT NULL,
  category      TEXT NOT NULL,
  content       TEXT NOT NULL,
  keywords_json TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
