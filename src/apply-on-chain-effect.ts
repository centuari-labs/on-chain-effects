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
    /**
     * The viem PublicClient for the chain the tx was submitted on.
     * Required when `receipt` is not provided; unused (but safe to pass) when
     * a pre-fetched `receipt` is supplied.
     */
    client?: PublicClient;
    /** The pg Pool to open the mutation transaction against. */
    pool: Pool;
    /** Transaction hash produced by the eager-path `writeContract` call. */
    txHash: Hex;
    /**
     * Pre-fetched transaction receipt. When provided, the helper skips
     * `waitForTransactionReceipt` and uses this receipt directly. Useful for
     * callers that already mined the tx and decoded its events (e.g.
     * settlement-engine's `settleBatch`), so they don't pay for a redundant
     * receipt fetch per event.
     */
    receipt?: TransactionReceipt;
    /** 0x-prefixed keccak256 topic0 of the event we require in the receipt. */
    expectedEventTopic: Hex;
    /**
     * When provided, the helper selects the log at exactly this `logIndex`
     * and verifies its `topics[0]` matches `expectedEventTopic`. Required
     * when a single tx may emit multiple logs sharing the same topic + args
     * predicate (e.g. a batch settle where one lender appears in several
     * matches) — without it the helper would only process the first matching
     * log and silently drop the rest. When absent, falls back to match-first
     * behaviour: first log whose topic0 matches and whose args pass the
     * predicate.
     */
    logIndex?: number;
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

export class MissingClientError extends Error {
    constructor() {
        super(
            "applyOnChainEffect requires a `client` when `receipt` is not provided",
        );
        this.name = "MissingClientError";
    }
}

/**
 * The C10 "verify-then-apply" primitive.
 *
 * 1. Obtain the tx receipt: use `args.receipt` if provided, otherwise fetch
 *    via `args.client.waitForTransactionReceipt`.
 * 2. Abort if status != success.
 * 3. Select the log to apply:
 *    - If `args.logIndex` is provided, look up the log at that index and
 *      verify its `topics[0]` matches `expectedEventTopic`.
 *    - Otherwise, find the first log whose `topics[0]` matches.
 *    Decode with the supplied ABI.
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
    const receipt = args.receipt ?? (await fetchReceipt(args));

    if (receipt.status !== "success") {
        return { applied: false, reason: "receipt_reverted" };
    }

    const match = selectLog(receipt, args.expectedEventTopic, args.logIndex);
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

async function fetchReceipt<TArgs>(
    args: ApplyOnChainEffectArgs<TArgs>,
): Promise<TransactionReceipt> {
    if (!args.client) {
        throw new MissingClientError();
    }
    return await args.client.waitForTransactionReceipt({ hash: args.txHash });
}

function selectLog(
    receipt: TransactionReceipt,
    topic0: Hex,
    logIndex: number | undefined,
): MatchedLog | undefined {
    const wanted = topic0.toLowerCase();

    if (logIndex !== undefined) {
        const log = receipt.logs.find((l) => l.logIndex === logIndex);
        if (!log) return undefined;
        const t0 = log.topics[0];
        if (!t0 || t0.toLowerCase() !== wanted) return undefined;
        return {
            data: log.data,
            topics: log.topics as readonly Hex[],
            logIndex: log.logIndex,
        };
    }

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
