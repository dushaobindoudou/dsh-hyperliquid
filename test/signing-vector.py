"""Generate deterministic L1-signing vectors with the OFFICIAL SDK for cross-validation."""
import json
from eth_account import Account
from hyperliquid.utils.signing import sign_l1_action, action_hash

PK = "0x" + "01" * 32
wallet = Account.from_key(PK)

# Case 1: mainnet order action (short keys, string px/sz), no vault
action1 = {
    "type": "order",
    "orders": [{"a": 0, "b": True, "p": "82534", "s": "0.01", "r": False, "t": {"limit": {"tif": "Ioc"}}}],
    "grouping": "na",
}
nonce1 = 1700000000000
sig1 = sign_l1_action(wallet, action1, None, nonce1, None, True)
hash1 = action_hash(action1, None, nonce1, None).hex()

# Case 2: testnet cancel action, with vault
action2 = {"type": "cancel", "cancels": [{"a": 1, "o": 12345}]}
nonce2 = 1700000000001
VAULT = "0x1234567890abcdef1234567890abcdef12345678"
sig2 = sign_l1_action(wallet, action2, VAULT, nonce2, None, False)
hash2 = action_hash(action2, VAULT, nonce2, None).hex()

# Case 3: updateLeverage mainnet
action3 = {"type": "updateLeverage", "asset": 3, "isCross": True, "leverage": 5}
nonce3 = 1700000000002
sig3 = sign_l1_action(wallet, action3, None, nonce3, None, True)
hash3 = action_hash(action3, None, nonce3, None).hex()

# Case 4: testnet grouped parent + TP + SL, exactly the normalTpsl wire shape.
action4 = {
    "type": "order",
    "orders": [
        {"a": 0, "b": True, "p": "80000", "s": "0.001", "r": False, "t": {"limit": {"tif": "Gtc"}}, "c": "0x11111111111111111111111111111111"},
        {"a": 0, "b": False, "p": "90000", "s": "0.001", "r": True, "t": {"trigger": {"isMarket": True, "triggerPx": "90000", "tpsl": "tp"}}},
        {"a": 0, "b": False, "p": "70000", "s": "0.001", "r": True, "t": {"trigger": {"isMarket": True, "triggerPx": "70000", "tpsl": "sl"}}},
    ],
    "grouping": "normalTpsl",
}
nonce4 = 1700000000003
sig4 = sign_l1_action(wallet, action4, None, nonce4, None, False)
hash4 = action_hash(action4, None, nonce4, None).hex()

print(json.dumps({
    "address": wallet.address,
    "case1": {"hash": hash1, **sig1},
    "case2": {"hash": hash2, **sig2},
    "case3": {"hash": hash3, **sig3},
    "case4": {"hash": hash4, **sig4},
}, indent=1))
