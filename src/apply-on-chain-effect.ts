import type { Pool, PoolClient } from "pg";
import {
    type Hex,
    type PublicClient,
    type TransactionReceipt,
    decodeEventLog,
} from "viem";

export interface IdempotencyStamp {
    txHash: Hex;
    logIndex: number;
    blockHash: Hex;
    blockNumber: bigint;
}

export interface ApplyOnChainEffectArgs<TArgs> {
    /** The viem PublicClient for the chain the tx was submitted on. */
    client: PublicClient;
    /** The pg Pool to open the mutation transaction against. */
    pool: Pool;
    /** Transaction hash produced by the eager-path `writeContract` call. */
    txHash: Hex;
    /** 0x-prefixed keccak256 topic0 of the event we require in the receipt. */
    expectedEventTopic: Hex;
    /** ABI fragment used to decode the event. */
    abi: readonly unknown[];
    /** Runs AFTER decode, BEFORE opening the pg tx — reject if args are wrong. */
    expectedArgsPredicate: (decoded: TArgs) => boolean;
    /** Runs inside a pg tx. Must write the stamp onto every row it mutates. */
    mutation: (
        tx: PoolClient,
        decoded: TArgs,
        stamp: IdempotencyStamp,
    ) => Promise<void>;
    /**
     * Optional early-out: called with the stamp BEFORE decode/mutate. Return
     * true to signal "already applied, skip". Consumers implement this by
     * checking their target row's applied_by_tx_hash.
     */
    alreadyAppliedCheck?: (
        tx: PoolClient,
        stamp: IdempotencyStamp,
    ) => Promise<boolean>;
}

export type ApplyOnChainEffectResult =
    | { applied: true }
    | {
          applied: false;
          reason:
              | "already_stamped"
              | "receipt_reverted"
              | "event_missing"
              | "args_mismatch";
      };

export class ReceiptRevertedError extends Error {
    constructor(txHash: Hex) {
        super(`receipt reverted for ${txHash}`);
        this.name = "ReceiptRevertedError";
    }
}

export class EventMissingError extends Error {
    constructor(txHash: Hex, topic: Hex) {
        super(`event with topic ${topic} not found in receipt for ${txHash}`);
        this.name = "EventMissingError";
    }
}

export class UnexpectedEventArgsError extends Error {
    constructor(txHash: Hex) {
        super(`decoded event args failed predicate for ${txHash}`);
        this.name = "UnexpectedEventArgsError";
    }
}

/**
 * The C10 "verify-then-apply" primitive.
 *
 * 1. Fetch the tx receipt.
 * 2. Abort if status != success.
 * 3. Find the log matching `expectedEventTopic`, decode with the supplied ABI.
 * 4. Run `expectedArgsPredicate` — abort on mismatch.
 * 5. Open a pg transaction; run `alreadyAppliedCheck` (if present); run
 *    `mutation` with the idempotency stamp; commit.
 *
 * The mutation MUST stamp applied_by_{tx_hash, log_index, block_hash,
 * block_number} on every row it touches. The indexer tail reads those stamps
 * and no-ops when it observes the same event later.
 */
export async function applyOnChainEffect<TArgs>(
    args: ApplyOnChainEffectArgs<TArgs>,
): Promise<ApplyOnChainEffectResult> {
    const receipt = await args.client.waitForTransactionReceipt({
        hash: args.txHash,
    });

    if (receipt.status !== "success") {
        return { applied: false, reason: "receipt_reverted" };
    }

    const match = findMatchingLog(receipt, args.expectedEventTopic);
    if (!match) {
        return { applied: false, reason: "event_missing" };
    }

    const decoded = decodeEventLog({
        abi: args.abi as never,
        data: match.data,
        topics: match.topics as never,
    });

    const typed = decoded.args as unknown as TArgs;
    if (!args.expectedArgsPredicate(typed)) {
        return { applied: false, reason: "args_mismatch" };
    }

    const stamp: IdempotencyStamp = {
        txHash: args.txHash,
        logIndex: match.logIndex,
        blockHash: receipt.blockHash,
        blockNumber: receipt.blockNumber,
    };

    const tx = await args.pool.connect();
    try {
        await tx.query("BEGIN");
        if (args.alreadyAppliedCheck) {
            const already = await args.alreadyAppliedCheck(tx, stamp);
            if (already) {
                await tx.query("ROLLBACK");
                return { applied: false, reason: "already_stamped" };
            }
        }
        await args.mutation(tx, typed, stamp);
        await tx.query("COMMIT");
        return { applied: true };
    } catch (err) {
        await tx.query("ROLLBACK");
        throw err;
    } finally {
        tx.release();
    }
}

interface MatchedLog {
    data: Hex;
    topics: readonly Hex[];
    logIndex: number;
}

function findMatchingLog(
    receipt: TransactionReceipt,
    topic0: Hex,
): MatchedLog | undefined {
    const wanted = topic0.toLowerCase();
    for (const log of receipt.logs) {
        const t0 = log.topics[0];
        if (!t0) continue;
        if (t0.toLowerCase() === wanted) {
            return {
                data: log.data,
                topics: log.topics as readonly Hex[],
                logIndex: log.logIndex,
            };
        }
    }
    return undefined;
}
