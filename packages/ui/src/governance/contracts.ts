import { keccak256, parseAbi, toHex } from "viem";
export { OptimisticTokenVotingPluginAbi as pluginAbi } from "./plugin-abi";
export const proposerPermissionId = keccak256(toHex("PROPOSER_PERMISSION"));
export const daoPermissionsAbi = parseAbi([
  "function hasPermission(address where,address who,bytes32 permissionId,bytes data) view returns (bool)",
  "function grant(address where,address who,bytes32 permissionId)",
]);
export const votesAbi = parseAbi([
  "function trustBonding() view returns (address)",
  "function getVotes(address) view returns (uint256)",
  "function getPastVotes(address,uint256) view returns (uint256)",
  "function getPastTotalSupply(uint256) view returns (uint256)",
]);
export const timelockAbi = parseAbi([
  "function execute(address target,uint256 value,bytes payload,bytes32 predecessor,bytes32 salt) payable",
  "function executeBatch(address[] targets,uint256[] values,bytes[] payloads,bytes32 predecessor,bytes32 salt) payable",
  "function getTimestamp(bytes32) view returns (uint256)",
  "function isOperationReady(bytes32) view returns (bool)",
  "function getMinDelay() view returns (uint256)",
  "event CallScheduled(bytes32 indexed id,uint256 indexed index,address target,uint256 value,bytes data,bytes32 predecessor,uint256 delay)",
  "event Cancelled(bytes32 indexed id)",
  "event CallExecuted(bytes32 indexed id,uint256 indexed index,address target,uint256 value,bytes data)",
]);
export const proxyAdminAbi = parseAbi([
  "function upgradeAndCall(address proxy,address implementation,bytes data) payable",
  "function upgrade(address proxy,address implementation)",
]);
