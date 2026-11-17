# Durable conversation extraction provenance

The opt-in ADK profile reuses a reviewed generic Xpell Agent Starter source
snapshot. The owner's active local source was inspected; this does not claim
that the remote Starter main contains that snapshot. The original source is
unchanged. Hashes below identify the reviewed inputs and extracted copies.

Ten TypeScript modules and all five protected app/schema artifacts are exact
copies. The remaining types module removes unused Action-only declarations
and the `agent_action` map entry. No executable algorithm is changed in the
copies. The profile wrapper adds explicit configuration, fresh-folder ownership,
restart checks, local mock composition, bounded read projection and disposal.
Private native-chat/actor compatibility helpers remain internal source code;
they do not enable a new IAM, authentication or Actions API. The retry policy
file supplies existing safe failure classification; no retry worker is started.
The source app metadata is retained byte-for-byte; UI/flows, `agent_action`,
product modules, records, credentials, bindings and migrations are not copied.

| Starter path | Extracted path | Source SHA-256 | Extracted SHA-256 | Adaptation |
| --- | --- | --- | --- | --- |
| `server/src/persistence/ConversationRepository.ts` | `src/adk/starter/persistence/ConversationRepository.ts` | `f327be9791fc789b540010553e9f6125551a6cc4193aa5b024261990592b3a13` | `f327be9791fc789b540010553e9f6125551a6cc4193aa5b024261990592b3a13` | unchanged |
| `server/src/persistence/AgentPersistenceLifecycle.ts` | `src/adk/starter/persistence/AgentPersistenceLifecycle.ts` | `e4c64ff385deb23c35eba72e63e4d236b60f721af8e0e3a41b9fe817c2b09706` | `e4c64ff385deb23c35eba72e63e4d236b60f721af8e0e3a41b9fe817c2b09706` | unchanged |
| `server/src/persistence/AgentApplicationScope.ts` | `src/adk/starter/persistence/AgentApplicationScope.ts` | `424caca9da3a36d02c1981b43efe7f2aebfe25d59cc512a7d4e6554fb7999e31` | `424caca9da3a36d02c1981b43efe7f2aebfe25d59cc512a7d4e6554fb7999e31` | unchanged |
| `server/src/persistence/keys.ts` | `src/adk/starter/persistence/keys.ts` | `2c38bc1bad36044abebff1cce4dbe5090738171c4d08c977dfec196372492e6f` | `2c38bc1bad36044abebff1cce4dbe5090738171c4d08c977dfec196372492e6f` | unchanged |
| `server/src/persistence/types.ts` | `src/adk/starter/persistence/types.ts` | `a8e02ace2a54e97ba7eda4dcca78be9803edf7fd2ffc21d4f62f832ec1bb1cf0` | `194ff07772f0579fcfd2d2f882d9be8c15a6bb94930905db0636e3fe1b68d5ba` | remove unused Action-only typedefs |
| `server/src/conversation/ConversationService.ts` | `src/adk/starter/conversation/ConversationService.ts` | `99f1fbd652bd89eef3128ba4e2349152ad5cb645cd1d888653df42969ba91c76` | `99f1fbd652bd89eef3128ba4e2349152ad5cb645cd1d888653df42969ba91c76` | unchanged |
| `server/src/conversation/ConversationContextManager.ts` | `src/adk/starter/conversation/ConversationContextManager.ts` | `2ac05583bb42e9a27625e2ff8a0b4b73952547cbdd18dd94158127cb36f4ff2f` | `2ac05583bb42e9a27625e2ff8a0b4b73952547cbdd18dd94158127cb36f4ff2f` | unchanged |
| `server/src/conversation/UserVisibleReply.ts` | `src/adk/starter/conversation/UserVisibleReply.ts` | `4875a7deef245f740ae476c5e6a38766e691957dfdf6da1142692155cafc3693` | `4875a7deef245f740ae476c5e6a38766e691957dfdf6da1142692155cafc3693` | unchanged |
| `server/src/conversation/ResponseLanguagePolicy.ts` | `src/adk/starter/conversation/ResponseLanguagePolicy.ts` | `8553dc9a8bc2890beee8d295314235e75b32f590fea64894f85166a34f2eb93b` | `8553dc9a8bc2890beee8d295314235e75b32f590fea64894f85166a34f2eb93b` | unchanged |
| `server/src/actor/ActorContext.ts` | `src/adk/starter/actor/ActorContext.ts` | `f49899ef9b80c8313c813d180c7f84fbdb83b0f06b6188dc838a139c340a23b4` | `f49899ef9b80c8313c813d180c7f84fbdb83b0f06b6188dc838a139c340a23b4` | unchanged |
| `server/src/recovery/OutboundRetryPolicy.ts` | `src/adk/starter/recovery/OutboundRetryPolicy.ts` | `33f343e57312e1ecf2e8abe0a49808afc8c92758d97ae7ec4021e2ccb0c9b1a4` | `33f343e57312e1ecf2e8abe0a49808afc8c92758d97ae7ec4021e2ccb0c9b1a4` | unchanged |
| `server/system-xapps/xpell-agent-starter/app.json` | `adk-system-xapps/xpell-agent-starter/app.json` | `6f057a67f99c61f42c8197948d5b0a1388cf88b9c017f3a029dd5e86a08355f8` | `6f057a67f99c61f42c8197948d5b0a1388cf88b9c017f3a029dd5e86a08355f8` | unchanged |
| `server/system-xapps/xpell-agent-starter/entities/conversation_participant.json` | `adk-system-xapps/xpell-agent-starter/entities/conversation_participant.json` | `99e9093614ae77e0c716261c9a4cbcea285939bf47862bb262a9c5be5e50abe9` | `99e9093614ae77e0c716261c9a4cbcea285939bf47862bb262a9c5be5e50abe9` | unchanged |
| `server/system-xapps/xpell-agent-starter/entities/channel_identity.json` | `adk-system-xapps/xpell-agent-starter/entities/channel_identity.json` | `2d93c61d75bab0f6f6f84409987a94a8be1c99cd1794cb3c557e72347d9cf81e` | `2d93c61d75bab0f6f6f84409987a94a8be1c99cd1794cb3c557e72347d9cf81e` | unchanged |
| `server/system-xapps/xpell-agent-starter/entities/conversation.json` | `adk-system-xapps/xpell-agent-starter/entities/conversation.json` | `dd68d019200558e8b4c186ee5939ac8d9b4696f8a8acddfcdece181655e6c9c1` | `dd68d019200558e8b4c186ee5939ac8d9b4696f8a8acddfcdece181655e6c9c1` | unchanged |
| `server/system-xapps/xpell-agent-starter/entities/message.json` | `adk-system-xapps/xpell-agent-starter/entities/message.json` | `01c8088ba1c9786ea1261326c4b7a0020ec611c40b55a7bcc65abc5653fa80b2` | `01c8088ba1c9786ea1261326c4b7a0020ec611c40b55a7bcc65abc5653fa80b2` | unchanged |

The default root runtime and Phase 1 mode remain independent of storage
activation. Rollback is to stop this profile, retain its synthetic folder,
and return to the previous package revision. No data migration is required.
