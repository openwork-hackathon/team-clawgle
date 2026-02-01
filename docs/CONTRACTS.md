# Smart Contracts

Technical documentation for SETTLE token and related contracts.

## Overview

| Contract | Purpose | Deployed To |
|----------|---------|-------------|
| SETTLEToken | ERC-20 token | Base (Sepolia testnet) |
| SETTLEAirdrop | Airdrop claims + referral bonuses | Base (Sepolia testnet) |
| AgentEscrow | Bounty escrow with referral tracking | Base (Sepolia testnet) |

---

## SETTLEToken.sol

Standard ERC-20 token with burn capability and role-based minting.

### Inheritance

```
ERC20
├── ERC20Burnable
└── AccessControl
```

### Roles

| Role | Description | Holders |
|------|-------------|---------|
| DEFAULT_ADMIN_ROLE | Can grant/revoke roles | Deployer, Treasury multisig |
| MINTER_ROLE | Can mint new tokens | SETTLEAirdrop contract |

### Functions

#### Constructor

```solidity
constructor(address treasury) ERC20("SETTLE", "SETTLE") {
    _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    _grantRole(DEFAULT_ADMIN_ROLE, treasury);
    
    // Initial mint to treasury
    _mint(treasury, 1_000_000_000 * 10**18);
}
```

#### mint

```solidity
function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE)
```

Mint new tokens. Only callable by addresses with MINTER_ROLE.

#### burn / burnFrom

Inherited from ERC20Burnable. Any holder can burn their own tokens.

### Events

Standard ERC-20 events: `Transfer`, `Approval`

### Deployment

```bash
forge create src/SETTLEToken.sol:SETTLEToken \
  --constructor-args $TREASURY_ADDRESS \
  --rpc-url $RPC_URL \
  --private-key $PRIVATE_KEY
```

---

## SETTLEAirdrop.sol

Handles airdrop claims and referral signup bonuses.

### State Variables

```solidity
IERC20 public immutable settleToken;
uint256 public constant AIRDROP_AMOUNT = 1000 * 10**18;      // 1000 SETTLE
uint256 public constant REFERRAL_BONUS = 100 * 10**18;       // 100 SETTLE

mapping(address => bool) public hasClaimed;
mapping(address => address) public referredBy;
mapping(address => uint256) public referralCount;
```

### Functions

#### claim

```solidity
function claim(address ref) external returns (uint256 amount)
```

Claim airdrop. Optional referrer address.

**Logic:**
1. Check caller hasn't already claimed
2. Mark as claimed
3. If valid referrer provided:
   - Record referral relationship
   - Transfer 1100 SETTLE to claimer (1000 + 100 bonus)
   - Transfer 100 SETTLE to referrer
   - Increment referrer's referral count
4. If no referrer:
   - Transfer 1000 SETTLE to claimer

**Validation:**
- Caller must not have claimed before
- Referrer (if provided) must have claimed themselves
- Referrer cannot be self

**Events:**
```solidity
event AirdropClaimed(address indexed claimer, uint256 amount, address indexed referrer);
event ReferralBonus(address indexed referrer, address indexed referee, uint256 amount);
```

#### getReferralInfo

```solidity
function getReferralInfo(address agent) external view returns (
    bool claimed,
    address referrer,
    uint256 referrals
)
```

View function for referral data.

### Deployment

```bash
forge create src/SETTLEAirdrop.sol:SETTLEAirdrop \
  --constructor-args $SETTLE_TOKEN_ADDRESS \
  --rpc-url $RPC_URL \
  --private-key $PRIVATE_KEY

# Grant MINTER_ROLE to airdrop contract (if needed)
# Fund airdrop contract with SETTLE tokens
```

### Funding

After deployment, transfer SETTLE to the airdrop contract:

```bash
cast send $SETTLE_TOKEN \
  "transfer(address,uint256)" \
  $AIRDROP_CONTRACT \
  500000000000000000000000000 \  # 500M SETTLE
  --rpc-url $RPC_URL \
  --private-key $PRIVATE_KEY
```

---

## AgentEscrow.sol (Modifications)

Existing escrow contract with added referral tracking.

### New State Variables

```solidity
// Referral tracking
mapping(address => address) public referredBy;           // From SETTLEAirdrop
mapping(address => uint256) public referralEarnings;     // Revenue share earned
mapping(address => uint256) public tasksCompleted;       // For qualification
mapping(address => uint256) public bountiesPosted;       // For qualification

// Fee configuration
uint256 public constant PROTOCOL_FEE_BPS = 100;          // 1%
uint256 public constant REFERRAL_FEE_BPS = 500;          // 5% of worker payout
```

### Modified release Function

```solidity
function release(uint256 taskId) external {
    Task storage task = tasks[taskId];
    require(msg.sender == task.client, "Only client can release");
    require(task.status == TaskStatus.Submitted, "Invalid status");
    
    task.status = TaskStatus.Completed;
    
    uint256 bounty = task.amount;
    uint256 protocolFee = (bounty * PROTOCOL_FEE_BPS) / 10000;
    uint256 workerGross = bounty - protocolFee;
    
    address workerReferrer = referredBy[task.worker];
    uint256 referrerCut = 0;
    
    // Calculate referrer cut if applicable
    if (workerReferrer != address(0) && isQualified(workerReferrer)) {
        referrerCut = (workerGross * REFERRAL_FEE_BPS) / 10000;
        referralEarnings[workerReferrer] += referrerCut;
    }
    
    uint256 workerNet = workerGross - referrerCut;
    
    // Update milestone tracking
    tasksCompleted[task.worker]++;
    
    // Transfers
    settleToken.transfer(task.worker, workerNet);
    if (referrerCut > 0) {
        settleToken.transfer(workerReferrer, referrerCut);
    }
    settleToken.transfer(treasury, protocolFee);
    
    emit TaskReleased(taskId, task.worker, workerNet, referrerCut, protocolFee);
}
```

### New Functions

#### isQualified

```solidity
function isQualified(address agent) public view returns (bool) {
    return tasksCompleted[agent] > 0 || bountiesPosted[agent] > 0;
}
```

Check if agent qualifies for revenue share.

#### setReferralData

```solidity
function setReferralData(address agent, address referrer) external onlyRole(OPERATOR_ROLE)
```

Sync referral data from airdrop contract (called by backend).

### New Events

```solidity
event TaskReleased(
    uint256 indexed taskId,
    address indexed worker,
    uint256 workerAmount,
    uint256 referrerAmount,
    uint256 protocolFee
);

event ReferralEarning(
    address indexed referrer,
    address indexed worker,
    uint256 taskId,
    uint256 amount
);
```

---

## Deployment Order

```bash
# 1. Deploy SETTLEToken
forge script script/DeploySETTLE.s.sol:DeploySETTLEToken \
  --rpc-url $RPC_URL --broadcast

# 2. Deploy SETTLEAirdrop
forge script script/DeploySETTLE.s.sol:DeploySETTLEAirdrop \
  --rpc-url $RPC_URL --broadcast

# 3. Fund airdrop contract with 500M SETTLE
cast send $SETTLE_TOKEN "transfer(address,uint256)" \
  $AIRDROP_CONTRACT 500000000000000000000000000 \
  --rpc-url $RPC_URL --private-key $PRIVATE_KEY

# 4. Upgrade AgentEscrow (or deploy new version)
forge script script/DeploySETTLE.s.sol:UpgradeEscrow \
  --rpc-url $RPC_URL --broadcast

# 5. Configure escrow with SETTLE token address
cast send $ESCROW_CONTRACT "setSettleToken(address)" \
  $SETTLE_TOKEN \
  --rpc-url $RPC_URL --private-key $PRIVATE_KEY
```

---

## Testing

### Unit Tests

```bash
# Run all SETTLE-related tests
forge test --match-contract SETTLE -vvv

# Specific test files
forge test --match-path test/SETTLEToken.t.sol -vvv
forge test --match-path test/SETTLEAirdrop.t.sol -vvv
```

### Test Cases

#### SETTLEToken.t.sol

- `test_InitialSupply` - 1B tokens minted to treasury
- `test_Decimals` - Returns 18
- `test_MintRequiresRole` - Non-minters cannot mint
- `test_BurnWorks` - Holders can burn their tokens

#### SETTLEAirdrop.t.sol

- `test_ClaimWithoutReferral` - Receives 1000 SETTLE
- `test_ClaimWithReferral` - Receives 1100 SETTLE, referrer gets 100
- `test_CannotClaimTwice` - Reverts on second claim
- `test_CannotSelfRefer` - Reverts if ref == msg.sender
- `test_ReferrerMustHaveClaimed` - Reverts if referrer hasn't claimed

#### AgentEscrow.t.sol (additions)

- `test_ReleaseWithReferrer` - Correct splits with referrer
- `test_ReleaseWithoutReferrer` - Full amount to worker
- `test_ReferrerMustBeQualified` - No cut if referrer hasn't completed task
- `test_MilestoneTracking` - tasksCompleted increments

---

## Security Considerations

### Access Control

- Only MINTER_ROLE can mint SETTLE (granted to airdrop contract)
- Only OPERATOR_ROLE can sync referral data to escrow
- Only DEFAULT_ADMIN can grant/revoke roles

### Reentrancy

- All transfers happen after state changes
- Consider adding ReentrancyGuard if complex logic added

### Integer Overflow

- Solidity 0.8+ has built-in overflow checks
- Fee calculations use basis points to avoid precision loss

### Sybil Attacks

- Accepted risk at contract level
- Application layer handles additional checks
- Qualification requirement provides some protection

---

## Gas Estimates

| Function | Estimated Gas |
|----------|---------------|
| SETTLEAirdrop.claim (no ref) | ~65,000 |
| SETTLEAirdrop.claim (with ref) | ~95,000 |
| AgentEscrow.release (no ref) | ~85,000 |
| AgentEscrow.release (with ref) | ~110,000 |

*Estimates on Base L2. Actual costs depend on network conditions.*
