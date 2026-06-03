/**
 * Arc Agent DAO MCP Server
 *
 * Layer 7: On-chain governance and dispute arbitration tools.
 * Create proposals, vote with reputation-weighted power, resolve disputes,
 * manage USDC escrow for contested jobs.
 *
 * Add to Claude Desktop:
 * {
 *   "mcpServers": {
 *     "arc-dao": {
 *       "command": "npx",
 *       "args": ["tsx", "/path/to/arc-agent-dao/src/mcp/server.ts"],
 *       "env": { "AGENT_PRIVATE_KEY": "0x...", "AGENT_DAO_ADDRESS": "0x..." }
 *     }
 *   }
 * }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AgentDAOClient, PROPOSAL_TYPE, PROPOSAL_STATUS, VOTE_CHOICE, DISPUTE_OUTCOME } from "../dao/dao.js";
import "dotenv/config";

const client = new AgentDAOClient();
const server = new Server({ name: "arc-agent-dao", version: "0.1.0" }, { capabilities: { tools: {} } });

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "arc_create_governance_proposal",
      description:
        "Create a governance proposal for the Arc agent ecosystem. Requires agent reputation >= 3000 bps (30%).",
      inputSchema: {
        type: "object",
        properties: {
          agentTokenId: {
            type: "number",
            description: "Token ID of the proposing agent.",
          },
          description: {
            type: "string",
            description: "Human-readable proposal description.",
          },
        },
        required: ["agentTokenId", "description"],
      },
    },
    {
      name: "arc_create_dispute_proposal",
      description:
        "Create a dispute resolution proposal for a contested job. Includes job metadata and escrow amount.",
      inputSchema: {
        type: "object",
        properties: {
          agentTokenId: {
            type: "number",
            description: "Token ID of the proposing agent.",
          },
          description: {
            type: "string",
            description: "Human-readable description of the dispute.",
          },
          jobContractType: {
            type: "number",
            description: "0 = AgentJob (Layer 2), 1 = AgentOrchestrator (Layer 4).",
          },
          jobId: {
            type: "number",
            description: "ID of the disputed job.",
          },
          disputedAgentId: {
            type: "number",
            description: "Token ID of the agent whose work is contested.",
          },
          client: {
            type: "string",
            description: "Address of the client who funded the job.",
          },
          escrowAmountUsdc: {
            type: "number",
            description: "USDC amount at stake (e.g. 10.0).",
          },
        },
        required: ["agentTokenId", "description", "jobContractType", "jobId", "disputedAgentId", "client", "escrowAmountUsdc"],
      },
    },
    {
      name: "arc_vote",
      description:
        "Cast a reputation-weighted vote on an active proposal. Voting power equals the agent's current reputation (bps).",
      inputSchema: {
        type: "object",
        properties: {
          proposalId: {
            type: "number",
            description: "ID of the proposal to vote on.",
          },
          agentTokenId: {
            type: "number",
            description: "Token ID of the voting agent.",
          },
          choice: {
            type: "number",
            description: "0 = Against, 1 = For, 2 = Abstain.",
          },
        },
        required: ["proposalId", "agentTokenId", "choice"],
      },
    },
    {
      name: "arc_execute_proposal",
      description:
        "Execute a proposal after voting period (3 days) and timelock (1 day) have elapsed. Determines pass/fail and distributes dispute escrow if applicable.",
      inputSchema: {
        type: "object",
        properties: {
          proposalId: {
            type: "number",
            description: "ID of the proposal to execute.",
          },
        },
        required: ["proposalId"],
      },
    },
    {
      name: "arc_cancel_proposal",
      description:
        "Cancel an active proposal. Only the original proposer can cancel.",
      inputSchema: {
        type: "object",
        properties: {
          proposalId: {
            type: "number",
            description: "ID of the proposal to cancel.",
          },
        },
        required: ["proposalId"],
      },
    },
    {
      name: "arc_get_proposal",
      description:
        "Get full proposal details including voting stats with percentages and pass/fail projection.",
      inputSchema: {
        type: "object",
        properties: {
          proposalId: {
            type: "number",
            description: "ID of the proposal to look up.",
          },
        },
        required: ["proposalId"],
      },
    },
    {
      name: "arc_get_dispute_info",
      description:
        "Get dispute resolution metadata for a dispute proposal — job details, parties, escrow, and outcome.",
      inputSchema: {
        type: "object",
        properties: {
          proposalId: {
            type: "number",
            description: "ID of the dispute proposal.",
          },
        },
        required: ["proposalId"],
      },
    },
    {
      name: "arc_deposit_dispute_escrow",
      description:
        "Deposit USDC into the DAO contract for dispute resolution escrow. Approves and transfers in one step.",
      inputSchema: {
        type: "object",
        properties: {
          proposalId: {
            type: "number",
            description: "ID of the dispute proposal.",
          },
          amountUsdc: {
            type: "number",
            description: "USDC amount to deposit (e.g. 10.0).",
          },
        },
        required: ["proposalId", "amountUsdc"],
      },
    },
    {
      name: "arc_list_proposals_by_agent",
      description: "List all proposals created by a specific agent.",
      inputSchema: {
        type: "object",
        properties: {
          agentTokenId: {
            type: "number",
            description: "Token ID of the agent.",
          },
        },
        required: ["agentTokenId"],
      },
    },
  ],
}));

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Format a raw USDC amount (6 decimals) as a human-readable string. */
function formatUsdc(raw: bigint): string {
  return (Number(raw) / 1_000_000).toFixed(2) + " USDC";
}

/** ArcScan transaction URL. */
function txUrl(hash: string): string {
  return `https://testnet.arcscan.app/tx/${hash}`;
}

/** Format a timestamp as a human-readable date. */
function formatTs(ts: bigint): string {
  if (ts === 0n) return "N/A";
  return new Date(Number(ts) * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

/** Calculate percentage of votes. */
function votePct(votes: bigint, total: bigint): string {
  if (total === 0n) return "0.0%";
  return ((Number(votes) / Number(total)) * 100).toFixed(1) + "%";
}

/** Project whether a proposal would pass with current votes. */
function passProjection(forVotes: bigint, againstVotes: bigint, abstainVotes: bigint): string {
  const total = forVotes + againstVotes + abstainVotes;
  if (total === 0n) return "No votes yet";
  const quorumMet = forVotes >= (total * 5000n) / 10000n;
  const passing = forVotes > againstVotes && quorumMet;
  if (passing) return "PASSING (quorum met, for > against)";
  if (forVotes > againstVotes && !quorumMet) return "FAILING (for > against, but quorum not met)";
  return "FAILING (against >= for)";
}

// ---------------------------------------------------------------------------
// Tool call handler
// ---------------------------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // -----------------------------------------------------------------------
      case "arc_create_governance_proposal": {
        const { agentTokenId, description } = args as {
          agentTokenId: number;
          description: string;
        };

        const { proposalId, hash } = await client.createGovernanceProposal(
          BigInt(agentTokenId),
          description,
        );

        return {
          content: [
            {
              type: "text",
              text: [
                `Governance proposal created successfully.`,
                ``,
                `Proposal ID  : ${proposalId}`,
                `Proposer     : Agent #${agentTokenId}`,
                `Type         : Governance`,
                `Description  : "${description}"`,
                `Voting Period: 3 days (259200 seconds)`,
                ``,
                `Transaction  : ${txUrl(hash)}`,
              ].join("\n"),
            },
          ],
        };
      }

      // -----------------------------------------------------------------------
      case "arc_create_dispute_proposal": {
        const { agentTokenId, description, jobContractType, jobId, disputedAgentId, client: clientAddr, escrowAmountUsdc } = args as {
          agentTokenId: number;
          description: string;
          jobContractType: number;
          jobId: number;
          disputedAgentId: number;
          client: string;
          escrowAmountUsdc: number;
        };

        const { proposalId, hash } = await client.createDisputeProposal(
          BigInt(agentTokenId),
          description,
          jobContractType,
          BigInt(jobId),
          BigInt(disputedAgentId),
          clientAddr as `0x${string}`,
          escrowAmountUsdc,
        );

        const contractLabel = jobContractType === 0 ? "AgentJob" : "AgentOrchestrator";

        return {
          content: [
            {
              type: "text",
              text: [
                `Dispute resolution proposal created successfully.`,
                ``,
                `Proposal ID    : ${proposalId}`,
                `Proposer       : Agent #${agentTokenId}`,
                `Type           : Dispute Resolution`,
                `Job Contract   : ${contractLabel} (type ${jobContractType})`,
                `Job ID         : ${jobId}`,
                `Disputed Agent : #${disputedAgentId}`,
                `Client         : ${clientAddr}`,
                `Escrow Amount  : ${escrowAmountUsdc.toFixed(2)} USDC`,
                ``,
                `Transaction    : ${txUrl(hash)}`,
              ].join("\n"),
            },
          ],
        };
      }

      // -----------------------------------------------------------------------
      case "arc_vote": {
        const { proposalId, agentTokenId, choice } = args as {
          proposalId: number;
          agentTokenId: number;
          choice: number;
        };

        const choiceLabel = VOTE_CHOICE[choice as keyof typeof VOTE_CHOICE] ?? `Unknown(${choice})`;

        const hash = await client.vote(
          BigInt(proposalId),
          BigInt(agentTokenId),
          choice,
        );

        // Fetch updated proposal to show vote tallies
        const prop = await client.getProposal(BigInt(proposalId));
        const total = prop.forVotes + prop.againstVotes + prop.abstainVotes;

        return {
          content: [
            {
              type: "text",
              text: [
                `Vote cast successfully.`,
                ``,
                `Proposal     : #${proposalId}`,
                `Agent        : #${agentTokenId}`,
                `Choice       : ${choiceLabel}`,
                ``,
                `Current Tally:`,
                `  For     : ${prop.forVotes} (${votePct(prop.forVotes, total)})`,
                `  Against : ${prop.againstVotes} (${votePct(prop.againstVotes, total)})`,
                `  Abstain : ${prop.abstainVotes} (${votePct(prop.abstainVotes, total)})`,
                `  Voters  : ${prop.voterCount}`,
                ``,
                `Projection   : ${passProjection(prop.forVotes, prop.againstVotes, prop.abstainVotes)}`,
                ``,
                `Transaction  : ${txUrl(hash)}`,
              ].join("\n"),
            },
          ],
        };
      }

      // -----------------------------------------------------------------------
      case "arc_execute_proposal": {
        const { proposalId } = args as { proposalId: number };

        const hash = await client.executeProposal(BigInt(proposalId));

        // Fetch updated proposal to show final result
        const prop = await client.getProposal(BigInt(proposalId));
        const statusLabel = PROPOSAL_STATUS[prop.status as keyof typeof PROPOSAL_STATUS] ?? "Unknown";

        return {
          content: [
            {
              type: "text",
              text: [
                `Proposal executed.`,
                ``,
                `Proposal     : #${proposalId}`,
                `Result       : ${statusLabel}`,
                `For/Against  : ${prop.forVotes} / ${prop.againstVotes}`,
                ``,
                `Transaction  : ${txUrl(hash)}`,
              ].join("\n"),
            },
          ],
        };
      }

      // -----------------------------------------------------------------------
      case "arc_cancel_proposal": {
        const { proposalId } = args as { proposalId: number };

        const hash = await client.cancelProposal(BigInt(proposalId));

        return {
          content: [
            {
              type: "text",
              text: [
                `Proposal cancelled.`,
                ``,
                `Proposal     : #${proposalId}`,
                `Status       : Cancelled`,
                ``,
                `Transaction  : ${txUrl(hash)}`,
              ].join("\n"),
            },
          ],
        };
      }

      // -----------------------------------------------------------------------
      case "arc_get_proposal": {
        const { proposalId } = args as { proposalId: number };

        const prop = await client.getProposal(BigInt(proposalId));

        const typeLabel = PROPOSAL_TYPE[prop.proposalType as keyof typeof PROPOSAL_TYPE] ?? "Unknown";
        const statusLabel = PROPOSAL_STATUS[prop.status as keyof typeof PROPOSAL_STATUS] ?? "Unknown";
        const total = prop.forVotes + prop.againstVotes + prop.abstainVotes;

        const lines = [
          `Proposal #${proposalId}`,
          ``,
          `Type         : ${typeLabel}`,
          `Status       : ${statusLabel}`,
          `Proposer     : Agent #${prop.proposerAgentId}`,
          `Description  : "${prop.description}"`,
          `Created      : ${formatTs(prop.createdAt)}`,
          `Voting Ends  : ${formatTs(prop.votingEndsAt)}`,
          `Executed     : ${prop.executed ? "Yes" : "No"}`,
          ``,
          `--- Voting Stats ---`,
          `  For     : ${prop.forVotes} bps (${votePct(prop.forVotes, total)})`,
          `  Against : ${prop.againstVotes} bps (${votePct(prop.againstVotes, total)})`,
          `  Abstain : ${prop.abstainVotes} bps (${votePct(prop.abstainVotes, total)})`,
          `  Total   : ${total} bps`,
          `  Voters  : ${prop.voterCount}`,
          ``,
          `Projection   : ${passProjection(prop.forVotes, prop.againstVotes, prop.abstainVotes)}`,
        ];

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      }

      // -----------------------------------------------------------------------
      case "arc_get_dispute_info": {
        const { proposalId } = args as { proposalId: number };

        const info = await client.getDisputeInfo(BigInt(proposalId));
        const outcomeLabel = DISPUTE_OUTCOME[info.outcome as keyof typeof DISPUTE_OUTCOME] ?? "Unknown";
        const contractLabel = Number(info.jobContractType) === 0 ? "AgentJob" : "AgentOrchestrator";

        return {
          content: [
            {
              type: "text",
              text: [
                `Dispute Info for Proposal #${proposalId}`,
                ``,
                `Job Contract   : ${contractLabel} (type ${info.jobContractType})`,
                `Job ID         : ${info.jobId}`,
                `Disputed Agent : #${info.disputedAgentId}`,
                `Client         : ${info.client}`,
                `Escrow Amount  : ${formatUsdc(info.escrowAmount)}`,
                `Outcome        : ${outcomeLabel}`,
              ].join("\n"),
            },
          ],
        };
      }

      // -----------------------------------------------------------------------
      case "arc_deposit_dispute_escrow": {
        const { proposalId, amountUsdc } = args as {
          proposalId: number;
          amountUsdc: number;
        };

        const hash = await client.depositDisputeEscrow(
          BigInt(proposalId),
          amountUsdc,
        );

        return {
          content: [
            {
              type: "text",
              text: [
                `Dispute escrow deposited.`,
                ``,
                `Proposal     : #${proposalId}`,
                `Amount       : ${amountUsdc.toFixed(2)} USDC`,
                ``,
                `Transaction  : ${txUrl(hash)}`,
              ].join("\n"),
            },
          ],
        };
      }

      // -----------------------------------------------------------------------
      case "arc_list_proposals_by_agent": {
        const { agentTokenId } = args as { agentTokenId: number };

        const proposalIds = await client.getProposalsByAgent(BigInt(agentTokenId));

        if (proposalIds.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `Agent #${agentTokenId} has not created any proposals.`,
              },
            ],
          };
        }

        const proposals = await Promise.all(
          proposalIds.map((id) => client.getProposal(id)),
        );

        const lines: string[] = [
          `Proposals by Agent #${agentTokenId} (${proposalIds.length} total):`,
          ``,
        ];

        proposals.forEach((p, i) => {
          const id = proposalIds[i];
          const typeLabel = PROPOSAL_TYPE[p.proposalType as keyof typeof PROPOSAL_TYPE] ?? "Unknown";
          const statusLabel = PROPOSAL_STATUS[p.status as keyof typeof PROPOSAL_STATUS] ?? "Unknown";
          const total = p.forVotes + p.againstVotes + p.abstainVotes;
          lines.push(
            `  Proposal #${id} [${typeLabel}] -- ${statusLabel}`,
            `    "${p.description}"`,
            `    Votes: ${p.forVotes} for / ${p.againstVotes} against / ${p.abstainVotes} abstain (${p.voterCount} voters)`,
            `    ${passProjection(p.forVotes, p.againstVotes, p.abstainVotes)}`,
            ``,
          );
        });

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      }

      // -----------------------------------------------------------------------
      default:
        return {
          content: [{ type: "text", text: `Error: Unknown tool "${name}"` }],
          isError: true,
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
