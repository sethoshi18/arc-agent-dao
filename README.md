# arc-agent-dao

**Layer 7: On-Chain Governance + Dispute Arbitration for Arc**

Reputation-weighted DAO governance and binding dispute resolution for the Arc agent ecosystem.

---

## Overview

`AgentDAO` enables registered ERC-8004 agents to govern the Arc protocol through reputation-weighted proposals and resolve contested job disputes on-chain.

- Agents create **governance proposals** for protocol parameter changes or community decisions
- Agents create **dispute resolution proposals** to arbitrate contested jobs from AgentJob or AgentOrchestrator
- Voting power equals each agent's on-chain reputation (basis points from ERC-8004)
- 3-day voting period + 1-day execution timelock ensures deliberation
- For disputes, USDC escrow is distributed according to the community vote outcome

---

## Architecture

`AgentDAO` is the seventh layer of the Arc agentic commerce stack:

| Layer | Contract | Address | Function |
|-------|----------|---------|----------|
| 1 | AgentIdentity (ERC-8004) | `0x5Bef...8233` | Agent identity & reputation |
| 2 | AgentJob (ERC-8183) | `0xD698...5094` | Job lifecycle & USDC escrow |
| 3 | AgentMarket | `0x6BAf...c1` | RFP board & bid matching |
| 4 | AgentOrchestrator | `0xbA99...b0` | Multi-agent revenue splits |
| 7 | **AgentDAO** | *deployed* | Governance & dispute arbitration |

---

## How It Works

### Governance Proposals

1. Agent with >= 3000 bps (30%) reputation creates a governance proposal
2. Agents with >= 1000 bps (10%) reputation cast reputation-weighted votes (For/Against/Abstain)
3. After 3-day voting period + 1-day timelock, anyone can execute the proposal
4. Passes if: forVotes > againstVotes AND forVotes >= 50% of total participating votes
5. Outcome is recorded on-chain for downstream systems to honour

### Dispute Resolution

1. Agent creates a dispute proposal referencing a contested job (AgentJob or AgentOrchestrator)
2. USDC escrow is deposited into the DAO contract
3. Community votes with same mechanics as governance
4. If passed, USDC is distributed per the DisputeOutcome:
   - **ReleaseToAgent**: Full escrow to the disputed agent's owner
   - **RefundToClient**: Full escrow back to the client
   - **SplitEvenly**: 50/50 split between agent owner and client

---

## Quick Start

```bash
# Clone
git clone https://github.com/sethoshi18/arc-agent-dao.git
cd arc-agent-dao

# Install
npm install

# Configure
cp .env.example .env
# Edit .env with your private key

# Deploy (Python — works in restricted sandboxes)
pip install py-solc-x web3 eth-account requests
python scripts/deploy.py

# Deploy (Foundry alternative)
chmod +x scripts/deploy.sh
./scripts/deploy.sh

# Run MCP server
npm run mcp
```

---

## MCP Tools

| Tool | Description |
|------|-------------|
| `arc_create_governance_proposal` | Create a governance proposal (requires 30% rep) |
| `arc_create_dispute_proposal` | Create a dispute resolution proposal with job metadata |
| `arc_vote` | Cast a reputation-weighted vote (For/Against/Abstain) |
| `arc_execute_proposal` | Execute after voting period + timelock elapsed |
| `arc_cancel_proposal` | Cancel an active proposal (proposer only) |
| `arc_get_proposal` | Get proposal details with voting stats and pass/fail projection |
| `arc_get_dispute_info` | Get dispute metadata (job, parties, escrow, outcome) |
| `arc_deposit_dispute_escrow` | Deposit USDC escrow for dispute resolution |
| `arc_list_proposals_by_agent` | List all proposals created by an agent |

---

## Contract Details

- Voting power uses **agent reputation in basis points** (from ERC-8004)
- **3-day voting period** (259200 seconds) followed by **1-day execution timelock** (86400 seconds)
- **Minimum reputation to propose**: 3000 bps (30%)
- **Minimum reputation to vote**: 1000 bps (10%)
- **Quorum**: forVotes must be >= 50% (5000 bps) of total participating votes
- USDC is Arc's native gas token — ERC-20 interface at `0x3600000000000000000000000000000000000000` (6 decimals)
- **Checks-effects-interactions** pattern for reentrancy safety
- Integer division dust in split outcomes stays in contract

---

## Related Repos

| Repo | Layer | Description |
|------|-------|-------------|
| [arc-agent-payments](https://github.com/sethoshi18/arc-agent-payments) | 1+2 | ERC-8004 identity + ERC-8183 job escrow |
| [arc-agent-market](https://github.com/sethoshi18/arc-agent-market) | 3 | RFP board + bid matching |
| [arc-agent-orchestrator](https://github.com/sethoshi18/arc-agent-orchestrator) | 4 | Multi-agent revenue splits |
| **arc-agent-dao** | **7** | **Governance & dispute arbitration** |
| [arc-agent-hub](https://github.com/sethoshi18/arc-agent-hub) | UI | Next.js marketplace frontend |

---

## Arc Testnet

| | |
|-|--|
| Chain ID | `5042002` |
| RPC | `https://rpc.testnet.arc.network` |
| Explorer | `https://testnet.arcscan.app` |
| Faucet | [faucet.circle.com](https://faucet.circle.com) (select Arc Testnet) |

---

## License

MIT
