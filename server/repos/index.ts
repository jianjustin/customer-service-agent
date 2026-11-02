import type { Db } from "../db/connection";
import { createAiRunRepo } from "./aiRuns";
import { createAssignmentStateRepo } from "./assignmentState";
import { createConversationRepo } from "./conversations";
import { createIdentityRepo } from "./identity";
import type { Repos } from "./interfaces";
import { createKnowledgeRepo } from "./knowledge";
import { createLogRepo } from "./logs";
import { createMessageRepo } from "./messages";
import { createOrderRepo } from "./orders";
import { createOutboxRepo } from "./outbox";
import { createRefundRepo } from "./refunds";
import { createTicketRepo } from "./tickets";

export * from "./interfaces";

export function createRepos(db: Db): Repos {
  return {
    identity: createIdentityRepo(db),
    orders: createOrderRepo(db),
    tickets: createTicketRepo(db),
    conversations: createConversationRepo(db),
    messages: createMessageRepo(db),
    aiRuns: createAiRunRepo(db),
    refunds: createRefundRepo(db),
    outbox: createOutboxRepo(db),
    logs: createLogRepo(db),
    knowledge: createKnowledgeRepo(db),
    assignmentState: createAssignmentStateRepo(db),
  };
}
