# AI Agent

Decided October 13, 2026. The product-native agent that acts through the versioned MCP server under the shared permission model.

## 1. One agent, product-native

Exactly one AI Agent ships with Icecream Sheets. It lives inside the web-service boundary as a service component, never as a separate app or integration. The component is named AI Agent, nothing else.

## 2. Acts only through MCP

The agent has no private path to the engine or storage. Every read, write, formula edit, recalculation and code execution goes through the versioned MCP server's agent tools, the same tools third-party clients use. If it cannot be done through MCP, the agent cannot do it.

## 3. Acts as the user

The agent acts as the user: every tool call carries the user's identity through authorize() under the shared permission model. The agent sees per-subject filtered views, so it can only read and touch what the user is allowed to. Denied targets return authorization errors, never silent empties.

## 4. Audit trail

Every agent action is logged with what it did, what it touched, when and under whose identity. The log is visible to the user.

## 5. Chat is one surface

The conversational UI is one way to reach the agent, not the agent itself. The same agent also works proactively.

## 6. Proactive event subscriptions

Proactivity rides on engine event subscriptions: cell and range changes, collaborator edits and recalculation completion. A fired subscription wakes the agent with context and the agent decides whether anything deserves the user's attention. Proactive pings are rate-limited and the user can mute categories or the whole thing.

## 7. Write discipline for v1

The agent reads and analyzes freely. Writes go through the same permission checks as any client, and broad or destructive writes (bulk edits, structural changes, anything touching sharing) require explicit user confirmation first.

## 8. Pluggable model backend

The product ships a default model and the user can point the agent at another provider with their own key. Tools and behavior do not change with the model.

## 9. Conversation state

Conversation state lives in the service metadata store, per user, never in workbook bytes. Threads are scoped to the user, not to a single workbook.

## 10. Distinct from flash-fill

Deterministic inference (autocomplete, formula suggestions, cleanup proposals) stays its own track producing inspectable proposals. The agent may surface those proposals but does not own the inference.

## 11. Out of scope for v1

Agent-initiated sharing or permission changes. Cross-workbook agent actions. Third-party agents running inside the product boundary.

## 12. Memory and human-in-the-loop are tool calls

Short-term memory is session memory and belongs to the agent runtime itself. The runtime holds thread state in the service metadata store — per-user, versioned thread records (`packages/service/src/agent/threads.ts`) that are read-through and written through on every completed turn, with schema migration for older records — and checkpoints each thread after every completed turn, so the agent resumes mid-thought across restarts. Pending human-in-the-loop asks are persisted the same way, so a pause survives a restart and the human's answer can still be delivered and continued. No third-party orchestration library holds the thread state. It is not a tool call.

Long-term memory is what the agent explicitly saves, and every operation on it is a versioned MCP tool call: load memory, save memory and update memory, scoped per user in the service metadata store. There is no private memory channel.

Human-in-the-loop is also a tool call. When the agent needs the user, it calls a tool: asking a question, offering options to choose from, or requesting approval. The tool call pauses the agent until the user responds. There is no path around MCP: if it cannot be done through a tool call, the agent cannot do it.

## AI Agent v2

Tracked v2 backlog. Agent-initiated sharing or permission changes. Cross-workbook agent actions. Third-party agents inside the product boundary: resolved October 13, 2026. Rejected by design principle. Third parties remain MCP clients outside the web-service boundary. The boundary is the trust line and exactly one product-native agent lives inside it.
