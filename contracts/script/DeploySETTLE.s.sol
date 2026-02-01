// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {SETTLEToken} from "../src/SETTLEToken.sol";
import {SETTLEAirdrop} from "../src/SETTLEAirdrop.sol";

/**
 * @title DeploySETTLEScript
 * @notice Deploys SETTLE token and airdrop contracts
 *
 * Deployment sequence:
 * 1. Deploy SETTLEToken (airdrop allocation goes to deployer)
 * 2. Deploy SETTLEAirdrop
 * 3. Grant MINTER_ROLE to airdrop contract
 * 4. Transfer airdrop allocation to airdrop contract
 *
 * Required environment variables:
 * - PRIVATE_KEY: Deployer private key
 * - TREASURY_ADDRESS: Treasury multisig address
 * - ESCROW_CONTRACT_ADDRESS: Existing AgentEscrow contract
 */
contract DeploySETTLEScript is Script {
    function run() external returns (SETTLEToken token, SETTLEAirdrop airdrop) {
        // Load environment
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        address escrowContract = vm.envAddress("ESCROW_CONTRACT_ADDRESS");

        console.log("Deploying SETTLE contracts...");
        console.log("Treasury:", treasury);
        console.log("Escrow:", escrowContract);

        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy token
        token = new SETTLEToken(treasury);
        console.log("SETTLEToken deployed at:", address(token));

        // 2. Deploy airdrop
        airdrop = new SETTLEAirdrop(address(token), escrowContract);
        console.log("SETTLEAirdrop deployed at:", address(airdrop));

        // 3. Grant minter role to airdrop
        token.addMinter(address(airdrop));
        console.log("Granted MINTER_ROLE to airdrop");

        // 4. Transfer airdrop allocation
        uint256 airdropAmount = token.AIRDROP_ALLOCATION();
        token.transfer(address(airdrop), airdropAmount);
        console.log("Transferred", airdropAmount / 1e18, "SETTLE to airdrop");

        vm.stopBroadcast();

        // Log final state
        console.log("\n=== Deployment Complete ===");
        console.log("Token:", address(token));
        console.log("Airdrop:", address(airdrop));
        console.log("Airdrop balance:", token.balanceOf(address(airdrop)) / 1e18, "SETTLE");
        console.log("Treasury balance:", token.balanceOf(treasury) / 1e18, "SETTLE");

        return (token, airdrop);
    }
}

/**
 * @title VerifySETTLEScript
 * @notice Verify deployed SETTLE contracts
 */
contract VerifySETTLEScript is Script {
    function run() external view {
        address tokenAddress = vm.envAddress("SETTLE_TOKEN_ADDRESS");
        address airdropAddress = vm.envAddress("SETTLE_AIRDROP_ADDRESS");

        SETTLEToken token = SETTLEToken(tokenAddress);
        SETTLEAirdrop airdrop = SETTLEAirdrop(airdropAddress);

        console.log("=== SETTLE Contract Verification ===");
        console.log("Token:", tokenAddress);
        console.log("Airdrop:", airdropAddress);
        console.log("");
        console.log("Token total supply:", token.totalSupply() / 1e18, "SETTLE");
        console.log("Airdrop balance:", token.balanceOf(airdropAddress) / 1e18, "SETTLE");
        console.log("Airdrop is minter:", token.isMinter(airdropAddress));
        console.log("");

        (uint256 claimed, uint256 referralBonuses, uint256 balance) = airdrop.getStats();
        console.log("Total claimed:", claimed);
        console.log("Referral bonuses paid:", referralBonuses / 1e18, "SETTLE");
        console.log("Remaining balance:", balance / 1e18, "SETTLE");
    }
}
