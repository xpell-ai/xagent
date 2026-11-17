import type {
  XAgentInboundMessage,
  XAgentMessageContext,
  XAgentMessageLifecycle,
  XAgentOutboundMessage,
} from "@xpell/agent";
import { _xlog } from "@xpell/node";

import {
  ConversationService,
  type ConversationTurnState,
  type InboundCompletionOutcome,
  type InboundConversationTurn,
  type OutboundCompletionOutcome,
} from "../conversation/ConversationService.js";
import { ConversationRepository } from "./ConversationRepository.js";

export type AgentPersistenceLifecycleOptions = {
  _service?: ConversationService;
  /** Compatibility path for callers that have not composed a service. */
  _repository?: ConversationRepository;
  _now?: () => Date;
  _local_id?: () => string;
};

/** XAgent lifecycle adapter; conversation behavior lives in ConversationService. */
export class AgentPersistenceLifecycle implements XAgentMessageLifecycle {
  readonly #service: ConversationService;
  readonly #state = new WeakMap<XAgentMessageContext, ConversationTurnState>();

  constructor(options: AgentPersistenceLifecycleOptions) {
    if (!options._service && !options._repository) {
      throw new Error("Agent persistence lifecycle requires a ConversationService");
    }
    this.#service =
      options._service ??
      new ConversationService({
        _repository: options._repository!,
        ...(options._now ? { _now: options._now } : {}),
        ...(options._local_id ? { _local_id: options._local_id } : {}),
      });
  }

  async beforeInbound(
    context: XAgentMessageContext,
    message: Readonly<XAgentInboundMessage>,
  ): Promise<void | { readonly _action: "handled" }> {
    const prepared = await this.#service.prepareInbound(message);
    this.#state.set(context, prepared._turn);
    return prepared._handled ? { _action: "handled" } : undefined;
  }

  async afterInbound(
    context: XAgentMessageContext,
    _message: Readonly<XAgentInboundMessage>,
    outcome: InboundCompletionOutcome,
  ): Promise<void> {
    await this.#service.completeInbound(
      this.requireInboundTurn(context),
      outcome,
    );
  }

  async beforeSend(
    context: XAgentMessageContext,
    message: Readonly<XAgentOutboundMessage>,
  ): Promise<void> {
    const turn = await this.#service.prepareOutbound(
      this.#state.get(context),
      message,
    );
    this.#state.set(context, turn);
  }

  async beforeChannelSend(
    context: XAgentMessageContext,
    _message: Readonly<XAgentOutboundMessage>,
  ): Promise<void> {
    await this.#service.claimOutbound(this.requireState(context, "outbound claim"));
  }

  async afterSend(
    context: XAgentMessageContext,
    _message: Readonly<XAgentOutboundMessage>,
    outcome: OutboundCompletionOutcome,
  ): Promise<void> {
    const state = this.requireState(context, "outbound completion");
    try {
      await this.#service.completeOutbound(state, outcome);
    } catch (error) {
      if (outcome._status === "accepted") {
        _xlog.error(
          "[agent-starter] provider accepted a message but persistence reconciliation is required",
          {
            _code: "E_STARTER_ACCEPTANCE_RECONCILIATION_REQUIRED",
            _outbound_message_id: state._outbound_message_id,
          },
        );
      }
      throw error;
    } finally {
      this.#state.delete(context);
    }
  }

  /** Application-private lookup; persistence IDs never enter Agent DTOs. */
  requireInboundTurn(context: XAgentMessageContext): InboundConversationTurn {
    const state = this.requireState(context, "inbound handler");
    if (
      !state._participant_id ||
      !state._channel_identity_id ||
      !state._inbound_message_id
    ) {
      throw new Error("Inbound persistence state is incomplete");
    }
    return state as InboundConversationTurn;
  }

  private requireState(
    context: XAgentMessageContext,
    phase: string,
  ): ConversationTurnState {
    const state = this.#state.get(context);
    if (!state) throw new Error(`Missing persistence state for ${phase}`);
    return state;
  }
}
