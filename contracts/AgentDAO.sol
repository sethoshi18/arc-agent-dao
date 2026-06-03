// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// =============================================================================
// Inline Interfaces
// =============================================================================

/**
 * @title IAgentIdentity
 * @notice Interface for the Arc Agent Identity Registry (Layer 1).
 *         Agents are ERC-721 tokens with on-chain reputation.
 */
interface IAgentIdentity {
    struct AgentIdentity {
        address owner;
        string name;
        string metadataURI;
        uint256 reputation;
        uint256 registeredAt;
        bool active;
    }

    /// @notice Returns the full identity record for a registered agent.
    /// @param tokenId The ERC-721 token ID of the agent.
    function getAgent(uint256 tokenId) external view returns (AgentIdentity memory);

    /// @notice Adjusts the reputation of an agent by a signed basis-point delta.
    /// @param tokenId The ERC-721 token ID of the agent.
    /// @param delta   Positive to increase reputation, negative to decrease.
    function adjustReputation(uint256 tokenId, int256 delta) external;
}

/**
 * @title IERC20
 * @notice Minimal ERC-20 interface used exclusively for USDC interactions.
 */
interface IERC20 {
    /// @notice Transfers `amount` tokens from `from` to `to` using the caller's allowance.
    function transferFrom(address from, address to, uint256 amount) external returns (bool);

    /// @notice Transfers `amount` tokens to `to` from the caller's balance.
    function transfer(address to, uint256 amount) external returns (bool);

    /// @notice Returns the token balance of `account`.
    function balanceOf(address account) external view returns (uint256);
}

// =============================================================================
// AgentDAO
// =============================================================================

/**
 * @title AgentDAO
 * @notice Layer 7 of the Arc agentic-commerce stack.
 *
 * @dev Reputation-weighted governance and dispute arbitration for the Arc
 *      agent ecosystem. Registered ERC-8004 agents can create proposals, vote
 *      on them (voting power equals their on-chain reputation in basis points),
 *      and resolve disputes that arise from contested jobs.
 *
 *      Architecture overview
 *      ---------------------
 *      Two proposal types are supported:
 *
 *      1. **Governance proposals** — protocol parameter changes, treasury
 *         decisions, or any community vote. Execution is off-chain; the
 *         contract records the outcome for downstream systems to honour.
 *
 *      2. **Dispute resolution proposals** — when a job enters a Disputed
 *         state in AgentJob or AgentOrchestrator, stakeholders can escalate
 *         to the DAO. The community votes on an outcome and, if the proposal
 *         passes, USDC escrow held in this contract is distributed according
 *         to the chosen DisputeOutcome.
 *
 *      Voting mechanics
 *      ----------------
 *      - Voting power equals the agent's current reputation (bps) at the
 *        time of casting.
 *      - A 3-day voting window is followed by a 1-day execution timelock.
 *      - Quorum requires that forVotes constitute at least 50 % (QUORUM_BPS)
 *        of the total voting power that participated (for + against + abstain).
 *      - A proposal passes when forVotes > againstVotes AND the quorum
 *        threshold is met.
 *
 *      Reputation thresholds (in basis points)
 *      ----------------------------------------
 *      MIN_REPUTATION_TO_PROPOSE  3000 bps (30 %) — proposers need solid rep
 *      MIN_REPUTATION_TO_VOTE     1000 bps (10 %) — low bar for participation
 */
contract AgentDAO {
    // =========================================================================
    // Constants
    // =========================================================================

    /// @notice Arc's native gas token exposed via an ERC-20 interface (6 decimals).
    address public constant USDC = 0x3600000000000000000000000000000000000000;

    /// @notice Duration of the voting period in seconds (3 days).
    uint256 public constant VOTING_PERIOD = 259200;

    /// @notice Timelock delay after voting ends before a proposal can be executed (1 day).
    uint256 public constant EXECUTION_DELAY = 86400;

    /// @notice Minimum reputation (bps) required to create a proposal.
    uint256 public constant MIN_REPUTATION_TO_PROPOSE = 3000;

    /// @notice Minimum reputation (bps) required to cast a vote.
    uint256 public constant MIN_REPUTATION_TO_VOTE = 1000;

    /// @notice Quorum threshold in basis points. forVotes must be >= this
    ///         percentage of total participating votes for a proposal to pass.
    uint256 public constant QUORUM_BPS = 5000;

    // =========================================================================
    // Enums
    // =========================================================================

    /**
     * @notice The two categories of proposals the DAO supports.
     *
     * Governance        - General protocol governance; outcome is advisory.
     * DisputeResolution - Binding resolution of a disputed job with USDC distribution.
     */
    enum ProposalType {
        Governance,
        DisputeResolution
    }

    /**
     * @notice Lifecycle states of a proposal.
     *
     * Active    - Voting is open.
     * Passed    - Voting ended; quorum met and forVotes > againstVotes.
     * Failed    - Voting ended; quorum not met or againstVotes >= forVotes.
     * Executed  - Passed proposal whose side-effects have been applied.
     * Cancelled - Proposer withdrew the proposal before execution.
     */
    enum ProposalStatus {
        Active,
        Passed,
        Failed,
        Executed,
        Cancelled
    }

    /**
     * @notice Choices a voter can make on a proposal.
     *
     * Against - Vote against the proposal.
     * For     - Vote in favour of the proposal.
     * Abstain - Counted toward quorum but not for/against.
     */
    enum VoteChoice {
        Against,
        For,
        Abstain
    }

    /**
     * @notice Possible outcomes when resolving a dispute.
     *
     * None           - Default; no outcome determined yet.
     * ReleaseToAgent - Full escrow released to the disputed agent's owner.
     * RefundToClient - Full escrow refunded to the client.
     * SplitEvenly    - Escrow split 50/50 between agent owner and client.
     */
    enum DisputeOutcome {
        None,
        ReleaseToAgent,
        RefundToClient,
        SplitEvenly
    }

    // =========================================================================
    // Structs
    // =========================================================================

    /**
     * @notice Core record for a DAO proposal.
     * @param id              Auto-incremented unique identifier.
     * @param proposerAgentId ERC-721 token ID of the agent that created the proposal.
     * @param proposalType    Governance or DisputeResolution.
     * @param description     Human-readable proposal description.
     * @param status          Current lifecycle status.
     * @param createdAt       Block timestamp when the proposal was created.
     * @param votingEndsAt    Block timestamp when voting closes.
     * @param forVotes        Aggregate weight of For votes.
     * @param againstVotes    Aggregate weight of Against votes.
     * @param abstainVotes    Aggregate weight of Abstain votes.
     * @param voterCount      Number of distinct agents that have voted.
     * @param executed        Whether the proposal's side-effects have been applied.
     */
    struct Proposal {
        uint256 id;
        uint256 proposerAgentId;
        ProposalType proposalType;
        string description;
        ProposalStatus status;
        uint256 createdAt;
        uint256 votingEndsAt;
        uint256 forVotes;
        uint256 againstVotes;
        uint256 abstainVotes;
        uint256 voterCount;
        bool executed;
    }

    /**
     * @notice Metadata attached to a DisputeResolution proposal.
     * @param jobContractType 0 = AgentJob (Layer 2), 1 = AgentOrchestrator (Layer 4).
     * @param jobId           The ID of the disputed job in the originating contract.
     * @param disputedAgentId Token ID of the agent whose work is being contested.
     * @param client          Address of the client who funded the job.
     * @param escrowAmount    USDC amount (6-decimal) held in this contract for resolution.
     * @param outcome         The DisputeOutcome that will be executed if the proposal passes.
     */
    struct DisputeInfo {
        uint256 jobContractType;
        uint256 jobId;
        uint256 disputedAgentId;
        address client;
        uint256 escrowAmount;
        DisputeOutcome outcome;
    }

    /**
     * @notice Record of a single agent's vote on a proposal.
     * @param agentTokenId Token ID of the voting agent.
     * @param choice       The VoteChoice cast.
     * @param weight       Reputation-based voting weight at time of casting.
     * @param votedAt      Block timestamp when the vote was recorded.
     */
    struct Vote {
        uint256 agentTokenId;
        VoteChoice choice;
        uint256 weight;
        uint256 votedAt;
    }

    // =========================================================================
    // State Variables
    // =========================================================================

    /// @notice Reference to the Arc Agent Identity Registry (Layer 1).
    IAgentIdentity public immutable identityRegistry;

    /// @notice USDC token contract (Arc native gas token with ERC-20 interface).
    IERC20 private immutable _usdc;

    /// @notice Protocol owner (deployer; reserved for future admin functions).
    address public owner;

    /// @dev Auto-incrementing counter for proposal IDs; starts at 1.
    uint256 private _nextProposalId;

    /// @notice Primary storage for proposals keyed by proposalId.
    mapping(uint256 => Proposal) public proposals;

    /// @notice Dispute metadata attached to DisputeResolution proposals.
    mapping(uint256 => DisputeInfo) public disputeInfo;

    /**
     * @notice Individual vote records keyed by (proposalId, agentTokenId).
     * @dev Access: votes[proposalId][agentTokenId].
     */
    mapping(uint256 => mapping(uint256 => Vote)) public votes;

    /**
     * @notice Fast lookup for whether an agent has already voted on a proposal.
     * @dev Access: hasVoted[proposalId][agentTokenId].
     */
    mapping(uint256 => mapping(uint256 => bool)) public hasVoted;

    /// @notice All proposal IDs created by a given agent.
    mapping(uint256 => uint256[]) public proposalsByAgent;

    // =========================================================================
    // Events
    // =========================================================================

    /// @notice Emitted when a new proposal is created.
    event ProposalCreated(
        uint256 indexed proposalId,
        uint256 indexed proposerAgentId,
        ProposalType proposalType,
        string description
    );

    /// @notice Emitted when an agent casts a vote on a proposal.
    event Voted(
        uint256 indexed proposalId,
        uint256 indexed agentTokenId,
        VoteChoice choice,
        uint256 weight
    );

    /// @notice Emitted when a proposal is executed (status transitions to Executed).
    event ProposalExecuted(uint256 indexed proposalId);

    /// @notice Emitted when a proposal is cancelled by its proposer.
    event ProposalCancelled(uint256 indexed proposalId);

    /// @notice Emitted when a dispute proposal is resolved and funds are distributed.
    event DisputeResolved(
        uint256 indexed proposalId,
        uint256 indexed jobId,
        DisputeOutcome outcome,
        uint256 amountToAgent,
        uint256 amountToClient
    );

    // =========================================================================
    // Constructor
    // =========================================================================

    /**
     * @notice Deploys the AgentDAO and wires up dependencies.
     * @param _identityRegistry Address of the Arc Agent Identity Registry.
     * @param usdcAddress       Address of the USDC (ERC-20) contract.
     *                          Pass address(0) to use the canonical Arc constant.
     */
    constructor(address _identityRegistry, address usdcAddress) {
        require(
            _identityRegistry != address(0),
            "AgentDAO: identity registry cannot be zero address"
        );

        identityRegistry = IAgentIdentity(_identityRegistry);

        // Allow the deployer to override the USDC address for testing while
        // defaulting to the Arc canonical constant when address(0) is passed.
        address resolvedUsdc = usdcAddress == address(0) ? USDC : usdcAddress;
        _usdc = IERC20(resolvedUsdc);

        owner = msg.sender;

        // IDs start at 1 so that a mapping returning 0 unambiguously means
        // "not found".
        _nextProposalId = 1;
    }

    // =========================================================================
    // Internal Helpers
    // =========================================================================

    /**
     * @dev Fetches the identity of an agent and reverts if not found / inactive.
     * @param tokenId The ERC-721 token ID of the agent.
     * @return identity The full AgentIdentity record.
     */
    function _requireActiveAgent(uint256 tokenId)
        internal
        view
        returns (IAgentIdentity.AgentIdentity memory identity)
    {
        identity = identityRegistry.getAgent(tokenId);
        require(
            identity.registeredAt != 0,
            "AgentDAO: agent does not exist"
        );
        require(identity.active, "AgentDAO: agent is not active");
    }

    /**
     * @dev Reverts if `msg.sender` is not the owner of the given agent.
     * @param tokenId  The agent to check ownership of.
     * @param identity Pre-fetched identity record (avoids redundant external calls).
     */
    function _requireAgentOwner(
        uint256 tokenId,
        IAgentIdentity.AgentIdentity memory identity
    ) internal view {
        require(
            identity.owner == msg.sender,
            "AgentDAO: caller does not own agent"
        );
        // Suppress unused-variable warning — tokenId used for contextual clarity.
        tokenId;
    }

    /**
     * @dev Creates a Proposal struct, stores it, and emits ProposalCreated.
     *      Shared between governance and dispute proposal creation.
     * @param agentTokenId  Token ID of the proposing agent.
     * @param description   Proposal description text.
     * @param proposalType  Governance or DisputeResolution.
     * @return proposalId   The newly assigned proposal ID.
     */
    function _createProposal(
        uint256 agentTokenId,
        string calldata description,
        ProposalType proposalType
    ) internal returns (uint256 proposalId) {
        // -- Validate agent is active and caller owns it ----------------------
        IAgentIdentity.AgentIdentity memory identity = _requireActiveAgent(agentTokenId);
        _requireAgentOwner(agentTokenId, identity);

        // -- Reputation gate --------------------------------------------------
        require(
            identity.reputation >= MIN_REPUTATION_TO_PROPOSE,
            "AgentDAO: agent reputation below minimum to propose"
        );

        // -- Assign proposal ID -----------------------------------------------
        proposalId = _nextProposalId++;

        // -- Persist proposal -------------------------------------------------
        proposals[proposalId] = Proposal({
            id: proposalId,
            proposerAgentId: agentTokenId,
            proposalType: proposalType,
            description: description,
            status: ProposalStatus.Active,
            createdAt: block.timestamp,
            votingEndsAt: block.timestamp + VOTING_PERIOD,
            forVotes: 0,
            againstVotes: 0,
            abstainVotes: 0,
            voterCount: 0,
            executed: false
        });

        // -- Index by proposer ------------------------------------------------
        proposalsByAgent[agentTokenId].push(proposalId);

        emit ProposalCreated(proposalId, agentTokenId, proposalType, description);
    }

    // =========================================================================
    // Proposal Creation
    // =========================================================================

    /**
     * @notice Creates a governance proposal.
     *
     * @dev Governance proposals are advisory — the contract records whether
     *      they passed or failed, but does not execute any on-chain side-effects.
     *      Downstream systems (UI, off-chain services) should honour the outcome.
     *
     * @param agentTokenId Token ID of the proposing agent (must be owned by caller).
     * @param description  Human-readable proposal description.
     * @return proposalId  The newly assigned proposal ID.
     */
    function createGovernanceProposal(
        uint256 agentTokenId,
        string calldata description
    ) external returns (uint256 proposalId) {
        proposalId = _createProposal(agentTokenId, description, ProposalType.Governance);
    }

    /**
     * @notice Creates a dispute resolution proposal with associated job metadata.
     *
     * @dev The USDC escrow for the dispute should be deposited into this contract
     *      (via depositDisputeEscrow) before or after proposal creation.
     *      The DisputeInfo record stores the resolution parameters; when the
     *      proposal passes and is executed, funds are distributed per the outcome.
     *
     * @param agentTokenId    Token ID of the proposing agent (must be owned by caller).
     * @param description     Human-readable description of the dispute.
     * @param jobContractType 0 = AgentJob, 1 = AgentOrchestrator.
     * @param jobId           ID of the disputed job in the originating contract.
     * @param disputedAgentId Token ID of the agent whose work is contested.
     * @param client          Address of the client who funded the job.
     * @param escrowAmount    USDC amount (6-decimal) expected for resolution.
     * @return proposalId     The newly assigned proposal ID.
     */
    function createDisputeProposal(
        uint256 agentTokenId,
        string calldata description,
        uint256 jobContractType,
        uint256 jobId,
        uint256 disputedAgentId,
        address client,
        uint256 escrowAmount
    ) external returns (uint256 proposalId) {
        require(
            client != address(0),
            "AgentDAO: client cannot be zero address"
        );
        require(
            escrowAmount > 0,
            "AgentDAO: escrowAmount must be greater than zero"
        );

        proposalId = _createProposal(agentTokenId, description, ProposalType.DisputeResolution);

        // -- Store dispute metadata -------------------------------------------
        disputeInfo[proposalId] = DisputeInfo({
            jobContractType: jobContractType,
            jobId: jobId,
            disputedAgentId: disputedAgentId,
            client: client,
            escrowAmount: escrowAmount,
            outcome: DisputeOutcome.None
        });
    }

    // =========================================================================
    // Voting
    // =========================================================================

    /**
     * @notice Cast a vote on an active proposal.
     *
     * @dev Voting weight equals the agent's current reputation at the time of
     *      casting. Each agent may only vote once per proposal. The vote is
     *      immutable once cast.
     *
     * @param proposalId   ID of the proposal to vote on.
     * @param agentTokenId Token ID of the voting agent (must be owned by caller).
     * @param choice       VoteChoice: Against (0), For (1), or Abstain (2).
     */
    function vote(
        uint256 proposalId,
        uint256 agentTokenId,
        VoteChoice choice
    ) external {
        Proposal storage prop = proposals[proposalId];

        // -- Proposal must exist and be Active --------------------------------
        require(prop.id != 0, "AgentDAO: proposal does not exist");
        require(
            prop.status == ProposalStatus.Active,
            "AgentDAO: proposal is not Active"
        );
        require(
            block.timestamp <= prop.votingEndsAt,
            "AgentDAO: voting period has ended"
        );

        // -- Agent must not have already voted --------------------------------
        require(
            !hasVoted[proposalId][agentTokenId],
            "AgentDAO: agent has already voted on this proposal"
        );

        // -- Validate agent ---------------------------------------------------
        IAgentIdentity.AgentIdentity memory identity = _requireActiveAgent(agentTokenId);
        _requireAgentOwner(agentTokenId, identity);

        // -- Reputation gate --------------------------------------------------
        require(
            identity.reputation >= MIN_REPUTATION_TO_VOTE,
            "AgentDAO: agent reputation below minimum to vote"
        );

        // -- Calculate voting weight (= reputation in bps) --------------------
        uint256 weight = identity.reputation;

        // -- Record vote ------------------------------------------------------
        hasVoted[proposalId][agentTokenId] = true;
        votes[proposalId][agentTokenId] = Vote({
            agentTokenId: agentTokenId,
            choice: choice,
            weight: weight,
            votedAt: block.timestamp
        });

        // -- Update tallies ---------------------------------------------------
        if (choice == VoteChoice.For) {
            prop.forVotes += weight;
        } else if (choice == VoteChoice.Against) {
            prop.againstVotes += weight;
        } else {
            prop.abstainVotes += weight;
        }
        prop.voterCount++;

        emit Voted(proposalId, agentTokenId, choice, weight);
    }

    // =========================================================================
    // Proposal Execution
    // =========================================================================

    /**
     * @notice Execute a proposal after the voting period and timelock have elapsed.
     *
     * @dev Determines whether the proposal passed or failed based on:
     *        1. forVotes > againstVotes
     *        2. forVotes >= (totalParticipatingVotes * QUORUM_BPS) / 10000
     *
     *      For governance proposals, the status is simply updated (off-chain
     *      execution). For dispute proposals that pass, USDC is distributed
     *      according to the DisputeOutcome stored in disputeInfo.
     *
     * @param proposalId ID of the proposal to execute.
     */
    function executeProposal(uint256 proposalId) external {
        Proposal storage prop = proposals[proposalId];

        // -- Proposal must exist and still be Active --------------------------
        require(prop.id != 0, "AgentDAO: proposal does not exist");
        require(
            prop.status == ProposalStatus.Active,
            "AgentDAO: proposal is not Active"
        );
        require(!prop.executed, "AgentDAO: proposal has already been executed");

        // -- Voting period must have ended ------------------------------------
        require(
            block.timestamp > prop.votingEndsAt,
            "AgentDAO: voting period has not ended"
        );

        // -- Timelock must have elapsed ---------------------------------------
        require(
            block.timestamp >= prop.votingEndsAt + EXECUTION_DELAY,
            "AgentDAO: execution timelock has not elapsed"
        );

        // -- Determine outcome ------------------------------------------------
        uint256 totalParticipating = prop.forVotes + prop.againstVotes + prop.abstainVotes;
        bool quorumMet = totalParticipating > 0 &&
            prop.forVotes >= (totalParticipating * QUORUM_BPS) / 10_000;
        bool passed = prop.forVotes > prop.againstVotes && quorumMet;

        if (passed) {
            prop.status = ProposalStatus.Passed;
        } else {
            prop.status = ProposalStatus.Failed;
        }

        prop.executed = true;

        // -- Execute side-effects for dispute proposals -----------------------
        if (passed && prop.proposalType == ProposalType.DisputeResolution) {
            _executeDisputeResolution(proposalId);
        }

        emit ProposalExecuted(proposalId);
    }

    /**
     * @dev Internal: distributes USDC escrow according to the DisputeOutcome.
     *      Called only when a DisputeResolution proposal passes.
     *
     * @param proposalId The proposal whose dispute info to execute.
     */
    function _executeDisputeResolution(uint256 proposalId) internal {
        DisputeInfo storage info = disputeInfo[proposalId];
        uint256 amount = info.escrowAmount;
        uint256 amountToAgent = 0;
        uint256 amountToClient = 0;

        if (info.outcome == DisputeOutcome.ReleaseToAgent) {
            // -- Full escrow to the disputed agent's current owner ------------
            address agentOwner = identityRegistry.getAgent(info.disputedAgentId).owner;
            amountToAgent = amount;
            bool ok = _usdc.transfer(agentOwner, amountToAgent);
            require(ok, "AgentDAO: USDC transfer to agent failed");

        } else if (info.outcome == DisputeOutcome.RefundToClient) {
            // -- Full escrow back to the client -------------------------------
            amountToClient = amount;
            bool ok = _usdc.transfer(info.client, amountToClient);
            require(ok, "AgentDAO: USDC transfer to client failed");

        } else if (info.outcome == DisputeOutcome.SplitEvenly) {
            // -- Split 50/50 between agent owner and client -------------------
            address agentOwner = identityRegistry.getAgent(info.disputedAgentId).owner;
            amountToAgent = amount / 2;
            amountToClient = amount - amountToAgent; // remainder goes to client
            bool ok1 = _usdc.transfer(agentOwner, amountToAgent);
            require(ok1, "AgentDAO: USDC transfer to agent failed");
            bool ok2 = _usdc.transfer(info.client, amountToClient);
            require(ok2, "AgentDAO: USDC transfer to client failed");
        }
        // DisputeOutcome.None — no distribution (should not happen for passed proposals)

        emit DisputeResolved(
            proposalId,
            info.jobId,
            info.outcome,
            amountToAgent,
            amountToClient
        );
    }

    // =========================================================================
    // Proposal Cancellation
    // =========================================================================

    /**
     * @notice Cancel an active proposal. Only the original proposer may cancel.
     *
     * @dev The proposal must still be in Active status. Cancelled proposals
     *      cannot be re-activated or executed.
     *
     * @param proposalId ID of the proposal to cancel.
     */
    function cancelProposal(uint256 proposalId) external {
        Proposal storage prop = proposals[proposalId];

        require(prop.id != 0, "AgentDAO: proposal does not exist");
        require(
            prop.status == ProposalStatus.Active,
            "AgentDAO: proposal is not Active"
        );

        // -- Only the proposer's agent owner can cancel -----------------------
        IAgentIdentity.AgentIdentity memory identity = identityRegistry.getAgent(prop.proposerAgentId);
        require(
            identity.owner == msg.sender,
            "AgentDAO: caller is not the proposal creator"
        );

        prop.status = ProposalStatus.Cancelled;
        emit ProposalCancelled(proposalId);
    }

    // =========================================================================
    // Escrow Deposit
    // =========================================================================

    /**
     * @notice Deposit USDC into this contract for dispute resolution escrow.
     *
     * @dev Anyone can deposit — typically the job contract or client transfers
     *      USDC before or after creating the dispute proposal. The caller must
     *      have approved this contract to spend at least `amount` USDC.
     *
     * @param proposalId ID of the dispute proposal the escrow is for.
     * @param amount     USDC amount (6-decimal) to deposit.
     */
    function depositDisputeEscrow(uint256 proposalId, uint256 amount) external {
        require(amount > 0, "AgentDAO: amount must be greater than zero");

        Proposal storage prop = proposals[proposalId];
        require(prop.id != 0, "AgentDAO: proposal does not exist");
        require(
            prop.proposalType == ProposalType.DisputeResolution,
            "AgentDAO: proposal is not a dispute resolution"
        );

        bool ok = _usdc.transferFrom(msg.sender, address(this), amount);
        require(ok, "AgentDAO: USDC transferFrom failed");
    }

    // =========================================================================
    // View Functions
    // =========================================================================

    /**
     * @notice Returns the full Proposal record for a given ID.
     * @param proposalId The proposal to query.
     * @return The Proposal struct. Callers should check `id != 0` for existence.
     */
    function getProposal(uint256 proposalId) external view returns (Proposal memory) {
        return proposals[proposalId];
    }

    /**
     * @notice Returns the DisputeInfo record for a dispute resolution proposal.
     * @param proposalId The proposal to query.
     * @return The DisputeInfo struct. Returns zero-values for non-dispute proposals.
     */
    function getDisputeInfo(uint256 proposalId) external view returns (DisputeInfo memory) {
        return disputeInfo[proposalId];
    }

    /**
     * @notice Returns a specific agent's vote on a proposal.
     * @param proposalId   The proposal to query.
     * @param agentTokenId The agent whose vote to retrieve.
     * @return The Vote struct. Returns zero-values if the agent has not voted.
     */
    function getVote(uint256 proposalId, uint256 agentTokenId)
        external
        view
        returns (Vote memory)
    {
        return votes[proposalId][agentTokenId];
    }

    /**
     * @notice Returns all proposal IDs created by a given agent.
     * @param agentTokenId The agent to query.
     * @return Array of proposal IDs.
     */
    function getProposalsByAgent(uint256 agentTokenId)
        external
        view
        returns (uint256[] memory)
    {
        return proposalsByAgent[agentTokenId];
    }

    /**
     * @notice Returns the total number of proposals created so far.
     * @return The count of proposals (equal to _nextProposalId - 1).
     */
    function getProposalCount() external view returns (uint256) {
        return _nextProposalId - 1;
    }

    /**
     * @notice Checks whether a specific agent has voted on a specific proposal.
     * @param proposalId   The proposal to check.
     * @param agentTokenId The agent to check.
     * @return True if the agent has already voted, false otherwise.
     */
    function hasAgentVoted(uint256 proposalId, uint256 agentTokenId)
        external
        view
        returns (bool)
    {
        return hasVoted[proposalId][agentTokenId];
    }
}
