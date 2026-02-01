// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title SETTLEToken
 * @notice Native token for the Clawgle settlement layer
 * @dev ERC-20 with controlled minting and burn functionality
 *
 * Total Supply: 1,000,000,000 SETTLE
 * - 50% Airdrop + Growth (500M)
 * - 30% Treasury (300M)
 * - 15% Ecosystem (150M)
 * - 5% Team (50M)
 */
contract SETTLEToken is ERC20, ERC20Burnable, AccessControl {
    // =============================================================
    //                         CONSTANTS
    // =============================================================

    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 * 10**18;
    uint256 public constant AIRDROP_ALLOCATION = 500_000_000 * 10**18;
    uint256 public constant TREASURY_ALLOCATION = 300_000_000 * 10**18;
    uint256 public constant ECOSYSTEM_ALLOCATION = 150_000_000 * 10**18;
    uint256 public constant TEAM_ALLOCATION = 50_000_000 * 10**18;

    // =============================================================
    //                          EVENTS
    // =============================================================

    event MinterAdded(address indexed account);
    event MinterRemoved(address indexed account);

    // =============================================================
    //                        CONSTRUCTOR
    // =============================================================

    /**
     * @notice Deploy SETTLE token with initial distribution
     * @param treasury Address to receive treasury + ecosystem + team allocation
     * @dev Airdrop allocation is minted to deployer, to be transferred to airdrop contract
     */
    constructor(address treasury) ERC20("SETTLE", "SETTLE") {
        require(treasury != address(0), "Invalid treasury");

        // Grant roles to deployer
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(MINTER_ROLE, msg.sender);

        // Mint allocations
        // Airdrop allocation to deployer (will transfer to airdrop contract)
        _mint(msg.sender, AIRDROP_ALLOCATION);
        // Treasury + ecosystem + team to treasury
        _mint(treasury, TREASURY_ALLOCATION + ECOSYSTEM_ALLOCATION + TEAM_ALLOCATION);
    }

    // =============================================================
    //                      MINTING FUNCTIONS
    // =============================================================

    /**
     * @notice Mint new tokens (restricted to MINTER_ROLE)
     * @param to Recipient address
     * @param amount Amount to mint
     */
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    // =============================================================
    //                      ADMIN FUNCTIONS
    // =============================================================

    /**
     * @notice Add a new minter
     * @param account Address to grant MINTER_ROLE
     */
    function addMinter(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        grantRole(MINTER_ROLE, account);
        emit MinterAdded(account);
    }

    /**
     * @notice Remove a minter
     * @param account Address to revoke MINTER_ROLE from
     */
    function removeMinter(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        revokeRole(MINTER_ROLE, account);
        emit MinterRemoved(account);
    }

    /**
     * @notice Check if an address has minter role
     * @param account Address to check
     * @return bool True if account has MINTER_ROLE
     */
    function isMinter(address account) external view returns (bool) {
        return hasRole(MINTER_ROLE, account);
    }
}
