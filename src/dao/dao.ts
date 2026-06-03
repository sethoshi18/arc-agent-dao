/**
 * AgentDAOClient
 *
 * Provides typed methods for interacting with the AgentDAO smart contract
 * on the Arc Testnet. Supports governance proposals, dispute resolution,
 * reputation-weighted voting, and USDC escrow management.
 *
 * Pattern mirrors AgentOrchestratorClient from arc-agent-orchestrator.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config, arcTestnet } from "../config.js";

// ---------------------------------------------------------------------------
// Status label lookup maps
// ---------------------------------------------------------------------------

export const PROPOSAL_TYPE = {
  0: "Governance",
  1: "DisputeResolution",
} as const;

export const PROPOSAL_STATUS = {
  0: "Active",
  1: "Passed",
  2: "Failed",
  3: "Executed",
  4: "Cancelled",
} as const;

export const VOTE_CHOICE = {
  0: "Against",
  1: "For",
  2: "Abstain",
} as const;

export const DISPUTE_OUTCOME = {
  0: "None",
  1: "ReleaseToAgent",
  2: "RefundToClient",
  3: "SplitEvenly",
} as const;

// ---------------------------------------------------------------------------
// ABI definitions (human-readable)
// ---------------------------------------------------------------------------

const daoAbi = parseAbi([
  // Proposal creation
  "function createGovernanceProposal(uint256 agentTokenId, string description) returns (uint256 proposalId)",
  "function createDisputeProposal(uint256 agentTokenId, string description, uint256 jobContractType, uint256 jobId, uint256 disputedAgentId, address client, uint256 escrowAmount) returns (uint256 proposalId)",

  // Voting
  "function vote(uint256 proposalId, uint256 agentTokenId, uint8 choice)",

  // Execution & cancellation
  "function executeProposal(uint256 proposalId)",
  "function cancelProposal(uint256 proposalId)",

  // Escrow
  "function depositDisputeEscrow(uint256 proposalId, uint256 amount)",

  // View functions
  "function getProposal(uint256 proposalId) view returns ((uint256 id, uint256 proposerAgentId, uint8 proposalType, string description, uint8 status, uint256 createdAt, uint256 votingEndsAt, uint256 forVotes, uint256 againstVotes, uint256 abstainVotes, uint256 voterCount, bool executed))",
  "function getDisputeInfo(uint256 proposalId) view returns ((uint256 jobContractType, uint256 jobId, uint256 disputedAgentId, address client, uint256 escrowAmount, uint8 outcome))",
  "function getVote(uint256 proposalId, uint256 agentTokenId) view returns ((uint256 agentTokenId, uint8 choice, uint256 weight, uint256 votedAt))",
  "function getProposalsByAgent(uint256 agentTokenId) view returns (uint256[])",
  "function getProposalCount() view returns (uint256)",
  "function hasAgentVoted(uint256 proposalId, uint256 agentTokenId) view returns (bool)",

  // Events
  "event ProposalCreated(uint256 indexed proposalId, uint256 indexed proposerAgentId, uint8 proposalType, string description)",
  "event Voted(uint256 indexed proposalId, uint256 indexed agentTokenId, uint8 choice, uint256 weight)",
  "event ProposalExecuted(uint256 indexed proposalId)",
  "event ProposalCancelled(uint256 indexed proposalId)",
  "event DisputeResolved(uint256 indexed proposalId, uint256 indexed jobId, uint8 outcome, uint256 amountToAgent, uint256 amountToClient)",
]);

const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

// ---------------------------------------------------------------------------
// Helper: convert human-readable USDC amount to 6-decimal bigint
// ---------------------------------------------------------------------------

function toUsdcUnits(amount: number): bigint {
  return BigInt(Math.round(amount * 1_000_000));
}

// ---------------------------------------------------------------------------
// AgentDAOClient
// ---------------------------------------------------------------------------

export class AgentDAOClient {
  private readonly publicClient;
  private readonly walletClient;
  private readonly account;

  /** Address of the deployed AgentDAO contract. */
  private readonly daoAddress: `0x${string}`;

  constructor() {
    if (!config.wallet.privateKey) {
      throw new Error("AGENT_PRIVATE_KEY is not set in environment");
    }
    if (!config.contracts.agentDAO) {
      throw new Error("AGENT_DAO_ADDRESS is not set in environment");
    }

    this.account = privateKeyToAccount(config.wallet.privateKey);
    this.daoAddress = config.contracts.agentDAO;

    this.publicClient = createPublicClient({
      chain: arcTestnet,
      transport: http(config.arc.rpcUrl),
    });

    this.walletClient = createWalletClient({
      account: this.account,
      chain: arcTestnet,
      transport: http(config.arc.rpcUrl),
    });
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Simulate then write a transaction, then wait for receipt.
   * Returns the transaction hash.
   */
  private async sendTx(args: Parameters<typeof this.walletClient.writeContract>[0]): Promise<`0x${string}`> {
    // Simulate first to surface revert reasons before submitting
    await this.publicClient.simulateContract({
      ...args,
      account: this.account,
    } as Parameters<typeof this.publicClient.simulateContract>[0]);

    const hash = await this.walletClient.writeContract(args as Parameters<typeof this.walletClient.writeContract>[0]);
    await this.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  /**
   * Ensure the wallet has approved at least `amount` USDC for the DAO contract.
   * Only sends an approval transaction when the current allowance is insufficient.
   */
  private async ensureUsdcAllowance(amount: bigint): Promise<void> {
    const allowance = await this.publicClient.readContract({
      address: config.contracts.usdc,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.account.address, this.daoAddress],
    });

    if (allowance >= amount) return;

    console.log(`Approving ${amount} USDC (6 decimals) for DAO contract...`);
    const hash = await this.sendTx({
      address: config.contracts.usdc,
      abi: erc20Abi,
      functionName: "approve",
      args: [this.daoAddress, amount],
    });
    console.log(`USDC approval confirmed (tx: ${hash})`);
  }

  // -------------------------------------------------------------------------
  // Proposal creation
  // -------------------------------------------------------------------------

  /**
   * Create a governance proposal.
   *
   * @param agentTokenId Token ID of the proposing agent (must be owned by caller).
   * @param description  Human-readable proposal description.
   * @returns Object containing the new proposalId (bigint) and transaction hash.
   */
  async createGovernanceProposal(
    agentTokenId: bigint,
    description: string,
  ): Promise<{ proposalId: bigint; hash: `0x${string}` }> {
    console.log(`Creating governance proposal -- agent: ${agentTokenId}`);

    // Simulate to extract the return value (proposalId)
    const { result: proposalId } = await this.publicClient.simulateContract({
      address: this.daoAddress,
      abi: daoAbi,
      functionName: "createGovernanceProposal",
      args: [agentTokenId, description],
      account: this.account,
    });

    const hash = await this.walletClient.writeContract({
      address: this.daoAddress,
      abi: daoAbi,
      functionName: "createGovernanceProposal",
      args: [agentTokenId, description],
    });

    await this.publicClient.waitForTransactionReceipt({ hash });
    console.log(`Governance proposal created -- id: ${proposalId}, tx: ${hash}`);
    return { proposalId, hash };
  }

  /**
   * Create a dispute resolution proposal with associated job metadata.
   *
   * @param agentTokenId    Token ID of the proposing agent (must be owned by caller).
   * @param description     Human-readable description of the dispute.
   * @param jobContractType 0 = AgentJob, 1 = AgentOrchestrator.
   * @param jobId           ID of the disputed job.
   * @param disputedAgentId Token ID of the agent whose work is contested.
   * @param client          Address of the client who funded the job.
   * @param escrowAmountUsdc Human-readable USDC amount (e.g. 10.0).
   * @returns Object containing the new proposalId and transaction hash.
   */
  async createDisputeProposal(
    agentTokenId: bigint,
    description: string,
    jobContractType: number,
    jobId: bigint,
    disputedAgentId: bigint,
    client: `0x${string}`,
    escrowAmountUsdc: number,
  ): Promise<{ proposalId: bigint; hash: `0x${string}` }> {
    const escrowAmount = toUsdcUnits(escrowAmountUsdc);
    console.log(`Creating dispute proposal -- agent: ${agentTokenId}, job: ${jobId}`);

    const { result: proposalId } = await this.publicClient.simulateContract({
      address: this.daoAddress,
      abi: daoAbi,
      functionName: "createDisputeProposal",
      args: [agentTokenId, description, BigInt(jobContractType), jobId, disputedAgentId, client, escrowAmount],
      account: this.account,
    });

    const hash = await this.walletClient.writeContract({
      address: this.daoAddress,
      abi: daoAbi,
      functionName: "createDisputeProposal",
      args: [agentTokenId, description, BigInt(jobContractType), jobId, disputedAgentId, client, escrowAmount],
    });

    await this.publicClient.waitForTransactionReceipt({ hash });
    console.log(`Dispute proposal created -- id: ${proposalId}, tx: ${hash}`);
    return { proposalId, hash };
  }

  // -------------------------------------------------------------------------
  // Voting
  // -------------------------------------------------------------------------

  /**
   * Cast a vote on an active proposal.
   *
   * @param proposalId   ID of the proposal to vote on.
   * @param agentTokenId Token ID of the voting agent (must be owned by caller).
   * @param choice       Vote choice: 0 = Against, 1 = For, 2 = Abstain.
   * @returns Transaction hash.
   */
  async vote(
    proposalId: bigint,
    agentTokenId: bigint,
    choice: number,
  ): Promise<`0x${string}`> {
    console.log(`Voting on proposal ${proposalId} -- agent: ${agentTokenId}, choice: ${VOTE_CHOICE[choice as keyof typeof VOTE_CHOICE] ?? choice}`);

    const hash = await this.sendTx({
      address: this.daoAddress,
      abi: daoAbi,
      functionName: "vote",
      args: [proposalId, agentTokenId, choice],
    });

    console.log(`Vote cast -- tx: ${hash}`);
    return hash;
  }

  // -------------------------------------------------------------------------
  // Execution & cancellation
  // -------------------------------------------------------------------------

  /**
   * Execute a proposal after the voting period and timelock have elapsed.
   *
   * @param proposalId ID of the proposal to execute.
   * @returns Transaction hash.
   */
  async executeProposal(proposalId: bigint): Promise<`0x${string}`> {
    console.log(`Executing proposal ${proposalId}...`);

    const hash = await this.sendTx({
      address: this.daoAddress,
      abi: daoAbi,
      functionName: "executeProposal",
      args: [proposalId],
    });

    console.log(`Proposal executed -- tx: ${hash}`);
    return hash;
  }

  /**
   * Cancel an active proposal (proposer only).
   *
   * @param proposalId ID of the proposal to cancel.
   * @returns Transaction hash.
   */
  async cancelProposal(proposalId: bigint): Promise<`0x${string}`> {
    console.log(`Cancelling proposal ${proposalId}...`);

    const hash = await this.sendTx({
      address: this.daoAddress,
      abi: daoAbi,
      functionName: "cancelProposal",
      args: [proposalId],
    });

    console.log(`Proposal cancelled -- tx: ${hash}`);
    return hash;
  }

  // -------------------------------------------------------------------------
  // Escrow
  // -------------------------------------------------------------------------

  /**
   * Deposit USDC into the DAO contract for dispute resolution escrow.
   * Automatically approves the DAO to spend USDC if necessary.
   *
   * @param proposalId      ID of the dispute proposal.
   * @param amountUsdc      Human-readable USDC amount (e.g. 10.0).
   * @returns Transaction hash.
   */
  async depositDisputeEscrow(
    proposalId: bigint,
    amountUsdc: number,
  ): Promise<`0x${string}`> {
    const amount = toUsdcUnits(amountUsdc);
    console.log(`Depositing ${amountUsdc} USDC escrow for proposal ${proposalId}...`);

    await this.ensureUsdcAllowance(amount);

    const hash = await this.sendTx({
      address: this.daoAddress,
      abi: daoAbi,
      functionName: "depositDisputeEscrow",
      args: [proposalId, amount],
    });

    console.log(`Escrow deposited -- tx: ${hash}`);
    return hash;
  }

  // -------------------------------------------------------------------------
  // View functions
  // -------------------------------------------------------------------------

  /**
   * Fetch on-chain metadata for a proposal.
   *
   * @param proposalId ID of the proposal to look up.
   * @returns Proposal struct data with additional human-readable labels.
   */
  async getProposal(proposalId: bigint) {
    const data = await this.publicClient.readContract({
      address: this.daoAddress,
      abi: daoAbi,
      functionName: "getProposal",
      args: [proposalId],
    });

    return {
      ...data,
      proposalTypeLabel: PROPOSAL_TYPE[data.proposalType as keyof typeof PROPOSAL_TYPE] ?? "Unknown",
      statusLabel: PROPOSAL_STATUS[data.status as keyof typeof PROPOSAL_STATUS] ?? "Unknown",
    };
  }

  /**
   * Fetch dispute info for a dispute resolution proposal.
   *
   * @param proposalId ID of the proposal.
   * @returns DisputeInfo struct with an additional outcomeLabel.
   */
  async getDisputeInfo(proposalId: bigint) {
    const data = await this.publicClient.readContract({
      address: this.daoAddress,
      abi: daoAbi,
      functionName: "getDisputeInfo",
      args: [proposalId],
    });

    return {
      ...data,
      outcomeLabel: DISPUTE_OUTCOME[data.outcome as keyof typeof DISPUTE_OUTCOME] ?? "Unknown",
    };
  }

  /**
   * Fetch a specific agent's vote on a proposal.
   *
   * @param proposalId   ID of the proposal.
   * @param agentTokenId Token ID of the voting agent.
   * @returns Vote struct with a choiceLabel.
   */
  async getVote(proposalId: bigint, agentTokenId: bigint) {
    const data = await this.publicClient.readContract({
      address: this.daoAddress,
      abi: daoAbi,
      functionName: "getVote",
      args: [proposalId, agentTokenId],
    });

    return {
      ...data,
      choiceLabel: VOTE_CHOICE[data.choice as keyof typeof VOTE_CHOICE] ?? "Unknown",
    };
  }

  /**
   * Fetch all proposal IDs created by a given agent.
   *
   * @param agentTokenId Token ID of the agent.
   * @returns Array of proposal IDs.
   */
  async getProposalsByAgent(agentTokenId: bigint): Promise<readonly bigint[]> {
    return this.publicClient.readContract({
      address: this.daoAddress,
      abi: daoAbi,
      functionName: "getProposalsByAgent",
      args: [agentTokenId],
    });
  }

  /**
   * Fetch the total number of proposals.
   *
   * @returns Total proposal count.
   */
  async getProposalCount(): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.daoAddress,
      abi: daoAbi,
      functionName: "getProposalCount",
    });
  }

  /**
   * Check whether a specific agent has voted on a proposal.
   *
   * @param proposalId   ID of the proposal.
   * @param agentTokenId Token ID of the agent.
   * @returns True if the agent has voted.
   */
  async hasAgentVoted(proposalId: bigint, agentTokenId: bigint): Promise<boolean> {
    return this.publicClient.readContract({
      address: this.daoAddress,
      abi: daoAbi,
      functionName: "hasAgentVoted",
      args: [proposalId, agentTokenId],
    });
  }
}
