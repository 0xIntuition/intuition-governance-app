import { deployment } from "./deployment";
import { decodeStoredEvents, receiptSchema, type StoredReceipt } from "./events";

// One key per transaction prevents concurrent tabs importing different receipts
// from overwriting one shared array. No build ID: imports survive releases.
export const storagePrefix = `intuition-governance:v1:${deployment.chainId}:${deployment.dao.toLowerCase()}:${deployment.plugin.toLowerCase()}:`;
export const MAX_IMPORTS = 100;
const MAX_RECORD_LENGTH = 1_000_000;
export function loadReceipts(storage: Storage): { receipts: StoredReceipt[]; warnings: string[] } {
  const receipts: StoredReceipt[] = [];
  const warnings: string[] = [];
  try {
    const keys = Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter(
      (k): k is string => !!k?.startsWith(storagePrefix)
    );
    if (keys.length > MAX_IMPORTS)
      warnings.push("Only the first 100 saved transactions are loaded. Remove older imports to make room.");
    for (const key of keys.slice(0, MAX_IMPORTS)) {
      try {
        const raw = storage.getItem(key);
        if (!raw || raw.length > MAX_RECORD_LENGTH) throw new Error("Invalid record");
        const receipt = receiptSchema.parse(JSON.parse(raw));
        if (key !== storagePrefix + receipt.transactionHash || !decodeStoredEvents(receipt).length)
          throw new Error("Invalid evidence");
        receipts.push(receipt);
      } catch {
        warnings.push("A saved transaction could not be read. Clear local history or reimport its hash.");
      }
    }
  } catch {
    warnings.push("Local storage is unavailable. Enable site storage to retain imported history.");
  }
  return { receipts, warnings };
}
export function saveReceipt(storage: Storage, receipt: StoredReceipt) {
  const validated = receiptSchema.parse(receipt);
  const key = storagePrefix + validated.transactionHash;
  const count = Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter((k) =>
    k?.startsWith(storagePrefix)
  ).length;
  if (!storage.getItem(key) && count >= MAX_IMPORTS)
    throw new Error("Local history is full (100 transactions). Remove an import before adding another.");
  const serialized = JSON.stringify(validated);
  if (serialized.length > MAX_RECORD_LENGTH) throw new Error("This receipt is too large to retain in local history.");
  try {
    storage.setItem(key, serialized);
  } catch {
    throw new Error("The receipt was verified, but could not be saved. Check browser storage space and retry.");
  }
}
export function removeReceipt(storage: Storage, hash: string) {
  storage.removeItem(storagePrefix + hash);
}
export function clearReceipts(storage: Storage) {
  const keys = Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter(
    (k): k is string => !!k?.startsWith(storagePrefix)
  );
  keys.forEach((key) => storage.removeItem(key));
}
