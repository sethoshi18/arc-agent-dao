#!/usr/bin/env python3
"""
Deploy AgentDAO to Arc Testnet using py-solc-x + web3.py.
Usage: python scripts/deploy.py
"""

import os
import sys
import json
import time
import requests
from pathlib import Path

from solcx import install_solc, compile_source
from web3 import Web3


# ---------------------------------------------------------------------------
# Receipt polling (avoids web3.wait_for_transaction_receipt timeout issues)
# ---------------------------------------------------------------------------

def wait_for_receipt(rpc_url, tx_hash, timeout=120):
    start = time.time()
    while time.time() - start < timeout:
        resp = requests.post(rpc_url, json={
            "jsonrpc": "2.0", "method": "eth_getTransactionReceipt",
            "params": [tx_hash], "id": 1
        })
        result = resp.json().get("result")
        if result is not None:
            return result
        time.sleep(3)
    raise TimeoutError(f"Transaction {tx_hash} not mined after {timeout}s")


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

def load_config():
    private_key = os.environ.get("AGENT_PRIVATE_KEY")
    if not private_key:
        print("ERROR: AGENT_PRIVATE_KEY environment variable is required")
        sys.exit(1)

    rpc_url = os.environ.get("ARC_RPC_URL", "https://rpc.testnet.arc.network")
    identity_registry = os.environ.get(
        "AGENT_IDENTITY_REGISTRY_ADDRESS",
        "0x5Bef356f89425823FC7eebB3A6ED1A678F3b8233"
    )
    usdc_address = "0x3600000000000000000000000000000000000000"

    return {
        "private_key": private_key,
        "rpc_url": rpc_url,
        "identity_registry": Web3.to_checksum_address(identity_registry),
        "usdc_address": Web3.to_checksum_address(usdc_address),
    }


# ---------------------------------------------------------------------------
# Compile
# ---------------------------------------------------------------------------

def compile_contract(contract_path: Path):
    print("📋 Compiling AgentDAO.sol...")
    install_solc("0.8.24")

    source = contract_path.read_text()
    compiled = compile_source(
        source,
        output_values=["abi", "bin"],
        solc_version="0.8.24",
        optimize=True,
        optimize_runs=200,
    )

    # The key emitted by compile_source for a single-file compile is
    # "<stdin>:ContractName"
    contract_id = "<stdin>:AgentDAO"
    if contract_id not in compiled:
        available = list(compiled.keys())
        print(f"ERROR: Could not find AgentDAO in compiled output. Available: {available}")
        sys.exit(1)

    iface = compiled[contract_id]
    print("   Compilation successful.")
    return iface["abi"], iface["bin"]


# ---------------------------------------------------------------------------
# Deploy
# ---------------------------------------------------------------------------

def deploy(w3: Web3, abi, bytecode, deployer_account, cfg):
    print("🚀 Deploying AgentDAO...")

    contract = w3.eth.contract(abi=abi, bytecode=bytecode)
    nonce = w3.eth.get_transaction_count(deployer_account.address)

    tx = contract.constructor(
        cfg["identity_registry"],
        cfg["usdc_address"]
    ).build_transaction({
        "from": deployer_account.address,
        "nonce": nonce,
        "maxFeePerGas": w3.to_wei(25, "gwei"),
        "maxPriorityFeePerGas": w3.to_wei(2, "gwei"),
    })

    signed = deployer_account.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    tx_hash_hex = tx_hash.hex()
    if not tx_hash_hex.startswith("0x"):
        tx_hash_hex = "0x" + tx_hash_hex

    print(f"   Tx hash: {tx_hash_hex}")
    print("   Waiting for receipt (polling every 3s, up to 120s)...")

    receipt = wait_for_receipt(cfg["rpc_url"], tx_hash_hex)

    if receipt.get("status") == "0x0":
        print("ERROR: Deployment transaction reverted.")
        print(json.dumps(receipt, indent=2))
        sys.exit(1)

    deployed_address = Web3.to_checksum_address(receipt["contractAddress"])
    print(f"✅ AgentDAO deployed: {deployed_address}")
    return deployed_address, receipt


# ---------------------------------------------------------------------------
# Post-deploy: authorise as trusted reputation updater
# ---------------------------------------------------------------------------

IDENTITY_REGISTRY_ABI = [
    {
        "inputs": [
            {"internalType": "address", "name": "updater", "type": "address"},
            {"internalType": "bool",    "name": "trusted", "type": "bool"}
        ],
        "name": "setTrustedUpdater",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    }
]


def set_trusted_updater(w3: Web3, deployer_account, cfg, dao_address: str):
    print("🔗 Authorising as trusted reputation updater...")

    registry = w3.eth.contract(
        address=cfg["identity_registry"],
        abi=IDENTITY_REGISTRY_ABI,
    )
    nonce = w3.eth.get_transaction_count(deployer_account.address)

    tx = registry.functions.setTrustedUpdater(
        Web3.to_checksum_address(dao_address), True
    ).build_transaction({
        "from": deployer_account.address,
        "nonce": nonce,
        "maxFeePerGas": w3.to_wei(25, "gwei"),
        "maxPriorityFeePerGas": w3.to_wei(2, "gwei"),
    })

    signed = deployer_account.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    tx_hash_hex = tx_hash.hex()
    if not tx_hash_hex.startswith("0x"):
        tx_hash_hex = "0x" + tx_hash_hex

    print(f"   Tx hash: {tx_hash_hex}")
    print("   Waiting for receipt...")

    receipt = wait_for_receipt(cfg["rpc_url"], tx_hash_hex)
    if receipt.get("status") == "0x0":
        print("ERROR: setTrustedUpdater transaction reverted.")
        print(json.dumps(receipt, indent=2))
        sys.exit(1)

    print("✅ Trusted updater set")


# ---------------------------------------------------------------------------
# Save deployment info
# ---------------------------------------------------------------------------

def save_deployment(repo_root: Path, dao_address: str, cfg: dict, receipt: dict):
    print("📝 Saving deployment to deployments/arc-testnet.json")

    deployments_dir = repo_root / "deployments"
    deployments_dir.mkdir(exist_ok=True)

    data = {
        "network": "arc-testnet",
        "chainId": 5042002,
        "deployedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "contracts": {
            "AgentDAO": {
                "address": dao_address,
                "txHash": receipt.get("transactionHash", ""),
                "blockNumber": int(receipt.get("blockNumber", "0x0"), 16),
            },
            "AgentIdentityRegistry": {
                "address": cfg["identity_registry"],
            },
            "USDC": {
                "address": cfg["usdc_address"],
            },
        },
    }

    out_path = deployments_dir / "arc-testnet.json"
    out_path.write_text(json.dumps(data, indent=2) + "\n")
    print(f"   Written to {out_path}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    repo_root = Path(__file__).resolve().parent.parent
    contract_path = repo_root / "contracts" / "AgentDAO.sol"

    if not contract_path.exists():
        print(f"ERROR: Contract not found at {contract_path}")
        sys.exit(1)

    cfg = load_config()

    print("🌐 Deploying to Arc Testnet (Chain ID 5042002)")

    w3 = Web3(Web3.HTTPProvider(cfg["rpc_url"]))
    if not w3.is_connected():
        print(f"ERROR: Could not connect to RPC at {cfg['rpc_url']}")
        sys.exit(1)

    deployer = w3.eth.account.from_key(cfg["private_key"])
    print(f"📍 Deployer: {deployer.address}")

    abi, bytecode = compile_contract(contract_path)

    dao_address, receipt = deploy(w3, abi, bytecode, deployer, cfg)

    set_trusted_updater(w3, deployer, cfg, dao_address)

    save_deployment(repo_root, dao_address, cfg, receipt)

    print("")
    print("🎉 Deployment complete!")
    print(f"   AgentDAO         : {dao_address}")
    print(f"   View on ArcScan  : https://testnet.arcscan.app/address/{dao_address}")


if __name__ == "__main__":
    main()
