// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "forge-std/interfaces/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IAgentEscrow {
    function setReferrer(address agent, address referrer) external;
}

/**
 * @title SETTLEAirdrop
 * @notice Zero-friction onboarding for agents via token airdrop
 * @dev Optimized for adoption velocity with referral system
 *
 * Claim: 1000 SETTLE (no barriers)
 * Referral Bonus: +100 SETTLE to both parties
 */
contract SETTLEAirdrop is ReentrancyGuard {
    // =============================================================
    //                         CONSTANTS
    // =============================================================

    uint256 public constant AIRDROP_AMOUNT = 1000 * 10**18;      // 1000 SETTLE
    uint256 public constant REFERRAL_BONUS = 100 * 10**18;       // 100 SETTLE each

    // Milestone bonuses
    uint256 public constant FIRST_TASK_BONUS = 50 * 10**18;      // 50 SETTLE
    uint256 public constant FIRST_BOUNTY_BONUS = 50 * 10**18;    // 50 SETTLE
    uint256 public constant FIRST_REFERRAL_BONUS = 100 * 10**18; // 100 SETTLE
    uint256 public constant FIVE_REFERRALS_BONUS = 500 * 10**18; // 500 SETTLE

    // =============================================================
    //                          STORAGE
    // =============================================================

    IERC20 public immutable settleToken;
    address public immutable escrowContract;
    address public admin;

    // Claim tracking
    mapping(address => bool) public hasClaimed;
    mapping(address => address) public referredBy;
    mapping(address => uint256) public referralCount;

    // Activity tracking (set by escrow contract)
    mapping(address => uint256) public tasksCompleted;
    mapping(address => uint256) public bountiesPosted;

    // Milestone tracking
    mapping(address => mapping(bytes32 => bool)) public milestonesClaimed;

    // Stats
    uint256 public totalClaimed;
    uint256 public totalReferralBonuses;

    // =============================================================
    //                          EVENTS
    // =============================================================

    event AirdropClaimed(address indexed agent, uint256 amount, address indexed referrer);
    event ReferralBonusPaid(address indexed referrer, address indexed referee, uint256 amount);
    event MilestoneClaimed(address indexed agent, bytes32 indexed milestone, uint256 amount);
    event ActivityRecorded(address indexed agent, string activityType);

    // =============================================================
    //                          ERRORS
    // =============================================================

    error AlreadyClaimed();
    error InvalidReferrer();
    error MilestoneAlreadyClaimed();
    error MilestoneNotEligible();
    error InsufficientBalance();
    error OnlyEscrow();
    error OnlyAdmin();

    // =============================================================
    //                        CONSTRUCTOR
    // =============================================================

    /**
     * @notice Deploy the airdrop contract
     * @param _settleToken Address of the SETTLE token
     * @param _escrowContract Address of the escrow contract (for callbacks)
     */
    constructor(address _settleToken, address _escrowContract) {
        require(_settleToken != address(0), "Invalid token");
        require(_escrowContract != address(0), "Invalid escrow");

        settleToken = IERC20(_settleToken);
        escrowContract = _escrowContract;
        admin = msg.sender;
    }

    // =============================================================
    //                      CLAIM FUNCTIONS
    // =============================================================

    /**
     * @notice Claim airdrop (1000 SETTLE + 100 if referred)
     * @param referrer Optional referrer address (address(0) if none)
     */
    function claim(address referrer) external nonReentrant {
        if (hasClaimed[msg.sender]) revert AlreadyClaimed();

        // Validate referrer
        bool hasValidReferrer = false;
        if (referrer != address(0)) {
            // Referrer must have claimed and not be self
            if (referrer == msg.sender) revert InvalidReferrer();
            if (!hasClaimed[referrer]) revert InvalidReferrer();
            hasValidReferrer = true;
        }

        // Mark as claimed
        hasClaimed[msg.sender] = true;
        totalClaimed++;

        // Calculate total payout
        uint256 agentAmount = AIRDROP_AMOUNT;
        if (hasValidReferrer) {
            agentAmount += REFERRAL_BONUS;
            referredBy[msg.sender] = referrer;
            referralCount[referrer]++;
        }

        // Transfer to claiming agent
        if (settleToken.balanceOf(address(this)) < agentAmount) revert InsufficientBalance();
        settleToken.transfer(msg.sender, agentAmount);

        emit AirdropClaimed(msg.sender, agentAmount, referrer);

        // Register referral in escrow contract for revenue share
        if (hasValidReferrer) {
            try IAgentEscrow(escrowContract).setReferrer(msg.sender, referrer) {} catch {}
        }

        // Pay referrer bonus (only if they have activity - anti-gaming)
        if (hasValidReferrer && _isActiveAgent(referrer)) {
            if (settleToken.balanceOf(address(this)) >= REFERRAL_BONUS) {
                settleToken.transfer(referrer, REFERRAL_BONUS);
                totalReferralBonuses += REFERRAL_BONUS;
                emit ReferralBonusPaid(referrer, msg.sender, REFERRAL_BONUS);
            }
        }
    }

    /**
     * @notice Claim a milestone bonus
     * @param milestone The milestone identifier
     */
    function claimMilestone(bytes32 milestone) external nonReentrant {
        if (milestonesClaimed[msg.sender][milestone]) revert MilestoneAlreadyClaimed();

        uint256 bonus = _getMilestoneBonus(msg.sender, milestone);
        if (bonus == 0) revert MilestoneNotEligible();

        milestonesClaimed[msg.sender][milestone] = true;

        if (settleToken.balanceOf(address(this)) < bonus) revert InsufficientBalance();
        settleToken.transfer(msg.sender, bonus);

        emit MilestoneClaimed(msg.sender, milestone, bonus);
    }

    // =============================================================
    //                    ESCROW CALLBACKS
    // =============================================================

    /**
     * @notice Record task completion (called by escrow)
     * @param worker The worker who completed the task
     */
    function recordTaskCompleted(address worker) external {
        if (msg.sender != escrowContract) revert OnlyEscrow();
        tasksCompleted[worker]++;
        emit ActivityRecorded(worker, "task_completed");
    }

    /**
     * @notice Record bounty posted (called by escrow)
     * @param client The client who posted the bounty
     */
    function recordBountyPosted(address client) external {
        if (msg.sender != escrowContract) revert OnlyEscrow();
        bountiesPosted[client]++;
        emit ActivityRecorded(client, "bounty_posted");
    }

    // =============================================================
    //                     VIEW FUNCTIONS
    // =============================================================

    /**
     * @notice Check if an agent is active (completed task or posted bounty)
     */
    function isActiveAgent(address agent) external view returns (bool) {
        return _isActiveAgent(agent);
    }

    /**
     * @notice Get agent's airdrop status
     */
    function getAgentStatus(address agent) external view returns (
        bool claimed,
        address referrer,
        uint256 referrals,
        uint256 tasks,
        uint256 bounties,
        bool isActive
    ) {
        return (
            hasClaimed[agent],
            referredBy[agent],
            referralCount[agent],
            tasksCompleted[agent],
            bountiesPosted[agent],
            _isActiveAgent(agent)
        );
    }

    /**
     * @notice Get claimable milestone bonus
     */
    function getClaimableMilestone(address agent, bytes32 milestone) external view returns (uint256) {
        if (milestonesClaimed[agent][milestone]) return 0;
        return _getMilestoneBonus(agent, milestone);
    }

    /**
     * @notice Get airdrop stats
     */
    function getStats() external view returns (
        uint256 claimed,
        uint256 referralBonuses,
        uint256 balance
    ) {
        return (
            totalClaimed,
            totalReferralBonuses,
            settleToken.balanceOf(address(this))
        );
    }

    // =============================================================
    //                    INTERNAL FUNCTIONS
    // =============================================================

    function _isActiveAgent(address agent) internal view returns (bool) {
        return tasksCompleted[agent] > 0 || bountiesPosted[agent] > 0;
    }

    function _getMilestoneBonus(address agent, bytes32 milestone) internal view returns (uint256) {
        // First task completed
        if (milestone == keccak256("FIRST_TASK") && tasksCompleted[agent] >= 1) {
            return FIRST_TASK_BONUS;
        }
        // First bounty posted
        if (milestone == keccak256("FIRST_BOUNTY") && bountiesPosted[agent] >= 1) {
            return FIRST_BOUNTY_BONUS;
        }
        // First referral
        if (milestone == keccak256("FIRST_REFERRAL") && referralCount[agent] >= 1) {
            return FIRST_REFERRAL_BONUS;
        }
        // Five referrals
        if (milestone == keccak256("FIVE_REFERRALS") && referralCount[agent] >= 5) {
            return FIVE_REFERRALS_BONUS;
        }
        return 0;
    }

    // =============================================================
    //                      ADMIN FUNCTIONS
    // =============================================================

    /**
     * @notice Withdraw excess tokens (admin only)
     */
    function withdrawExcess(address to, uint256 amount) external {
        if (msg.sender != admin) revert OnlyAdmin();
        settleToken.transfer(to, amount);
    }

    /**
     * @notice Transfer admin role
     */
    function transferAdmin(address newAdmin) external {
        if (msg.sender != admin) revert OnlyAdmin();
        require(newAdmin != address(0), "Invalid admin");
        admin = newAdmin;
    }
}
