#!/usr/bin/env bash
# Deploy AgentDAO to Arc Testnet
# Usage: ./scripts/deploy.sh
#
# Prerequisites:
#   1. Copy .env.example to .env and fill in AGENT_PRIVATE_KEY
#   2. Fund wallet with testnet USDC from https://faucet.circle.com
#   3. Install Foundry: curl -L https://foundry.paradigm.xyz | bash && foundryup

set -e
source .env

echo "🌐 Deploying to Arc Testnet (Chain ID 5042002)"
echo "📍 Deployer: $(cast wallet address $AGENT_PRIVATE_KEY)"

IDENTITY_ADDRESS="${AGENT_IDENTITY_REGISTRY_ADDRESS:-0x5Bef356f89425823FC7eebB3A6ED1A678F3b8233}"
USDC_ADDRESS="0x3600000000000000000000000000000000000000"

echo ""
echo "📋 Deploying AgentDAO..."
DAO_ADDRESS=$(forge create \
  contracts/AgentDAO.sol:AgentDAO \
  --rpc-url "$ARC_RPC_URL" \
  --private-key "$AGENT_PRIVATE_KEY" \
  --constructor-args "$IDENTITY_ADDRESS" "$USDC_ADDRESS" \
  --broadcast \
  --json | jq -r '.deployedTo')

echo "✅ AgentDAO deployed: $DAO_ADDRESS"

echo ""
echo "🔗 Authorising AgentDAO as trusted reputation updater..."
cast send "$IDENTITY_ADDRESS" \
  "setTrustedUpdater(address,bool)" \
  "$DAO_ADDRESS" true \
  --rpc-url "$ARC_RPC_URL" \
  --private-key "$AGENT_PRIVATE_KEY"

echo "✅ Trusted updater set"

echo ""
echo "📝 Updating .env..."
sed -i.bak "s|AGENT_DAO_ADDRESS=.*|AGENT_DAO_ADDRESS=$DAO_ADDRESS|" .env
rm .env.bak 2>/dev/null || true

echo ""
echo "🎉 Deployment complete!"
echo "   AgentDAO: $DAO_ADDRESS"
echo "   View on ArcScan: https://testnet.arcscan.app/address/$DAO_ADDRESS"
