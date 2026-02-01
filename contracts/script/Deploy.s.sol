// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {AgentEscrow} from "../src/AgentEscrow.sol";

contract DeployScript is Script {
    function run() external returns (AgentEscrow) {
        // Get deployer private key from environment
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address arbitrator = vm.envAddress("ARBITRATOR_ADDRESS");

        vm.startBroadcast(deployerPrivateKey);

        AgentEscrow escrow = new AgentEscrow(arbitrator);

        vm.stopBroadcast();

        return escrow;
    }
}
