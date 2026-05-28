import type { PoolClient } from "pg";
import type { Hex } from "viem";
import type { IdempotencyStamp } from "./apply-on-chain-effect.js";

/**
 * Per-event SQL mutations for the shared on-chain-state schema (C7).
 *
 * These are the single source of truth for every stamped upsert that both the
 * eager-path writers (backend-v2, settlement-engine) and the indexer-v3 tail
 * apply. Before C7 each upsert was copy-pasted into 2–3 places and kept
 * identical by code-review discipline; a silent divergence would break C10
 * idempotency on replay. Now the SQL is identical *by construction* — every
 * path calls the same function.
 *
 * Each function is transaction-agnostic: it runs raw SQL on a caller-owned
 * `PoolClient` and does NOT open/commit a transaction, fetch a receipt, or run
 * an idempotency check. The caller supplies the scope:
 *   - eager path: the `PoolClient` inside `applyOnChainEffect`'s BEGIN/COMMIT.
 *   - indexer tail: `ctx.client`, already inside the per-block BEGIN.
 *
 * Every mutation stamps `applied_by_{tx_hash, log_index, block_hash,
 * block_number}` on the row it touches — the indexer tail reads those stamps
 * and no-ops when it later observes the same event. Each function returns the
 * affected row count so decrement callers can preserve their "missing row"
 * warnings; upserts always affect a row.
 */

/** Convert a `0x`-prefixed hex string to a Buffer for a BYTEA column. */
export function hexToBytea(hex: Hex): Buffer {
    const stripped = hex.startsWith("0x") ? hex.slice(2) : hex;
    if (stripped.length % 2 !== 0) {
        throw new Error(`hexToBytea: odd-length hex ${hex}`);
    }
    return Buffer.from(stripped, "hex");
}

export type StampedTable =
    | "user_balance"
    | "lend_position"
    | "borrow_position"
    | "market";

/**
 * True when the target row already carries this exact `(tx_hash, log_index)`
 * stamp — meaning either the eager path re-ran for the same event or the
 * indexer tail got there first. Both paths use this to no-op idempotently.
 *
 * `table` and `pkCondition` are caller-controlled constants (never user
 * input); `pkValues` and the stamp are bound as parameters.
 */
export async function isAlreadyStamped(
    tx: PoolClient,
    table: StampedTable,
    pkCondition: string,
    pkValues: readonly unknown[],
    stamp: IdempotencyStamp,
): Promise<boolean> {
    const res = await tx.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM ${table}
          WHERE ${pkCondition}
            AND applied_by_tx_hash = $${pkValues.length + 1}
            AND applied_by_log_index = $${pkValues.length + 2}`,
        [...pkValues, hexToBytea(stamp.txHash), stamp.logIndex],
    );
    return Boolean(res.rows[0] && Number(res.rows[0].count) > 0);
}

export interface BalanceDeltaArgs {
    user: Hex;
    asset: Hex;
    amount: bigint;
}

export interface CollateralFlagArgs {
    user: Hex;
    asset: Hex;
    used: boolean;
    flaggedAt: bigint;
}

export interface RepaidArgs {
    marketId: Hex;
    borrower: Hex;
    amount: bigint;
}

export interface LendPositionWithdrawnArgs {
    marketId: Hex;
    lender: Hex;
    cbtBurned: bigint;
    amountWithdrawn: bigint;
}

export interface LendPositionCreatedArgs {
    marketId: Hex;
    lender: Hex;
    bondToken: Hex;
    cbtAmount: bigint;
    principal: bigint;
    rate: bigint;
}

export interface BorrowPositionCreatedArgs {
    marketId: Hex;
    borrower: Hex;
    principal: bigint;
    debt: bigint;
    rate: bigint;
}

/**
 * `user_balance.available += delta`. Shared by `BalanceLedger.Credited`
 * (delta = +amount) and `Debited` (delta = -amount). On a brand-new row the
 * upsert seeds `available = delta`, `used_as_collateral = false`,
 * `flagged_at = 0` — matching the historical behaviour of both writers.
 */
async function applyBalanceDelta(
    tx: PoolClient,
    user: Hex,
    asset: Hex,
    delta: bigint,
    stamp: IdempotencyStamp,
): Promise<number> {
    const res = await tx.query(
        `INSERT INTO user_balance
            (user_address, asset, available, used_as_collateral, flagged_at,
             applied_by_tx_hash, applied_by_log_index,
             applied_by_block_hash, applied_by_block_number, updated_at)
         VALUES ($1, $2, $3::numeric, false, 0, $4, $5, $6, $7, now())
         ON CONFLICT (user_address, asset) DO UPDATE SET
            available = user_balance.available + EXCLUDED.available,
            applied_by_tx_hash = EXCLUDED.applied_by_tx_hash,
            applied_by_log_index = EXCLUDED.applied_by_log_index,
            applied_by_block_hash = EXCLUDED.applied_by_block_hash,
            applied_by_block_number = EXCLUDED.applied_by_block_number,
            updated_at = now()`,
        [
            hexToBytea(user),
            hexToBytea(asset),
            delta.toString(),
            hexToBytea(stamp.txHash),
            stamp.logIndex,
            hexToBytea(stamp.blockHash),
            stamp.blockNumber.toString(),
        ],
    );
    return res.rowCount ?? 0;
}

/** `BalanceLedger.Credited` → `user_balance.available += amount`. */
export function applyCreditedMutation(
    tx: PoolClient,
    decoded: BalanceDeltaArgs,
    stamp: IdempotencyStamp,
): Promise<number> {
    return applyBalanceDelta(
        tx,
        decoded.user,
        decoded.asset,
        decoded.amount,
        stamp,
    );
}

/** `BalanceLedger.Debited` → `user_balance.available -= amount`. */
export function applyDebitedMutation(
    tx: PoolClient,
    decoded: BalanceDeltaArgs,
    stamp: IdempotencyStamp,
): Promise<number> {
    return applyBalanceDelta(
        tx,
        decoded.user,
        decoded.asset,
        -decoded.amount,
        stamp,
    );
}

/**
 * `BalanceLedger.CollateralFlagSet` → write `used_as_collateral` + `flagged_at`
 * verbatim. `flagged_at == 0` on unmark is authoritative; repeat-mark is a
 * no-op on `flagged_at` at the contract level and we simply mirror the event.
 *
 * NOTE: this covers ONLY the `user_balance` flag upsert. The companion
 * `pending_collateral_flags` DELETE is a non-stamped, multi-writer,
 * `DELETE WHERE`-idempotent side-effect owned by the callers — it is
 * deliberately NOT part of this mutation.
 */
export async function applyCollateralFlagSetMutation(
    tx: PoolClient,
    decoded: CollateralFlagArgs,
    stamp: IdempotencyStamp,
): Promise<number> {
    const res = await tx.query(
        `INSERT INTO user_balance
            (user_address, asset, used_as_collateral, flagged_at,
             applied_by_tx_hash, applied_by_log_index,
             applied_by_block_hash, applied_by_block_number, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (user_address, asset) DO UPDATE SET
            used_as_collateral = EXCLUDED.used_as_collateral,
            flagged_at = EXCLUDED.flagged_at,
            applied_by_tx_hash = EXCLUDED.applied_by_tx_hash,
            applied_by_log_index = EXCLUDED.applied_by_log_index,
            applied_by_block_hash = EXCLUDED.applied_by_block_hash,
            applied_by_block_number = EXCLUDED.applied_by_block_number,
            updated_at = now()`,
        [
            hexToBytea(decoded.user),
            hexToBytea(decoded.asset),
            decoded.used,
            decoded.flaggedAt.toString(),
            hexToBytea(stamp.txHash),
            stamp.logIndex,
            hexToBytea(stamp.blockHash),
            stamp.blockNumber.toString(),
        ],
    );
    return res.rowCount ?? 0;
}

/**
 * `Centuari.Repaid` → `borrow_position.debt -= amount` (floored at 0).
 * Invariant: does NOT touch `used_as_collateral` — unflag is the user's
 * explicit action through CollateralManager after the 24h lock, never implicit.
 * Returns 0 when no open position matched (caller may warn).
 */
export async function applyRepaidMutation(
    tx: PoolClient,
    decoded: RepaidArgs,
    stamp: IdempotencyStamp,
): Promise<number> {
    const res = await tx.query(
        `UPDATE borrow_position
            SET debt = GREATEST(debt - $3::numeric, 0),
                applied_by_tx_hash = $4,
                applied_by_log_index = $5,
                applied_by_block_hash = $6,
                applied_by_block_number = $7,
                updated_at = now()
          WHERE market_id = $1 AND borrower = $2 AND debt > 0`,
        [
            hexToBytea(decoded.marketId),
            hexToBytea(decoded.borrower),
            decoded.amount.toString(),
            hexToBytea(stamp.txHash),
            stamp.logIndex,
            hexToBytea(stamp.blockHash),
            stamp.blockNumber.toString(),
        ],
    );
    return res.rowCount ?? 0;
}

/**
 * `Centuari.LendPositionWithdrawn` → decrement `lend_position.cbt_balance` and
 * `principal` (both floored at 0). Returns 0 when no positive-balance position
 * matched (caller may warn).
 */
export async function applyLendPositionWithdrawnMutation(
    tx: PoolClient,
    decoded: LendPositionWithdrawnArgs,
    stamp: IdempotencyStamp,
): Promise<number> {
    const res = await tx.query(
        `UPDATE lend_position
            SET cbt_balance = GREATEST(cbt_balance - $3::numeric, 0),
                principal = GREATEST(principal - $4::numeric, 0),
                applied_by_tx_hash = $5,
                applied_by_log_index = $6,
                applied_by_block_hash = $7,
                applied_by_block_number = $8,
                updated_at = now()
          WHERE market_id = $1 AND lender = $2 AND cbt_balance > 0`,
        [
            hexToBytea(decoded.marketId),
            hexToBytea(decoded.lender),
            decoded.cbtBurned.toString(),
            decoded.amountWithdrawn.toString(),
            hexToBytea(stamp.txHash),
            stamp.logIndex,
            hexToBytea(stamp.blockHash),
            stamp.blockNumber.toString(),
        ],
    );
    return res.rowCount ?? 0;
}

/**
 * `Centuari.LendPositionCreated` → upsert a lend position. Accumulates
 * `cbt_balance` / `principal` and takes latest-wins on `bond_token` / `rate`,
 * so multiple fills for the same `(market, lender)` in one tx sum correctly.
 */
export async function applyLendPositionCreatedMutation(
    tx: PoolClient,
    decoded: LendPositionCreatedArgs,
    stamp: IdempotencyStamp,
): Promise<number> {
    const res = await tx.query(
        `INSERT INTO lend_position
            (market_id, lender, bond_token, cbt_balance, principal, rate,
             applied_by_tx_hash, applied_by_log_index,
             applied_by_block_hash, applied_by_block_number, updated_at)
         VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6::numeric,
                 $7, $8, $9, $10, now())
         ON CONFLICT (market_id, lender) DO UPDATE SET
            bond_token = EXCLUDED.bond_token,
            cbt_balance = lend_position.cbt_balance + EXCLUDED.cbt_balance,
            principal = lend_position.principal + EXCLUDED.principal,
            rate = EXCLUDED.rate,
            applied_by_tx_hash = EXCLUDED.applied_by_tx_hash,
            applied_by_log_index = EXCLUDED.applied_by_log_index,
            applied_by_block_hash = EXCLUDED.applied_by_block_hash,
            applied_by_block_number = EXCLUDED.applied_by_block_number,
            updated_at = now()`,
        [
            hexToBytea(decoded.marketId),
            hexToBytea(decoded.lender),
            hexToBytea(decoded.bondToken),
            decoded.cbtAmount.toString(),
            decoded.principal.toString(),
            decoded.rate.toString(),
            hexToBytea(stamp.txHash),
            stamp.logIndex,
            hexToBytea(stamp.blockHash),
            stamp.blockNumber.toString(),
        ],
    );
    return res.rowCount ?? 0;
}

/**
 * `Centuari.BorrowPositionCreated` → upsert a borrow position. Accumulates
 * `principal` / `debt` and takes latest-wins on `rate`.
 */
export async function applyBorrowPositionCreatedMutation(
    tx: PoolClient,
    decoded: BorrowPositionCreatedArgs,
    stamp: IdempotencyStamp,
): Promise<number> {
    const res = await tx.query(
        `INSERT INTO borrow_position
            (market_id, borrower, principal, debt, rate,
             applied_by_tx_hash, applied_by_log_index,
             applied_by_block_hash, applied_by_block_number, updated_at)
         VALUES ($1, $2, $3::numeric, $4::numeric, $5::numeric,
                 $6, $7, $8, $9, now())
         ON CONFLICT (market_id, borrower) DO UPDATE SET
            principal = borrow_position.principal + EXCLUDED.principal,
            debt = borrow_position.debt + EXCLUDED.debt,
            rate = EXCLUDED.rate,
            applied_by_tx_hash = EXCLUDED.applied_by_tx_hash,
            applied_by_log_index = EXCLUDED.applied_by_log_index,
            applied_by_block_hash = EXCLUDED.applied_by_block_hash,
            applied_by_block_number = EXCLUDED.applied_by_block_number,
            updated_at = now()`,
        [
            hexToBytea(decoded.marketId),
            hexToBytea(decoded.borrower),
            decoded.principal.toString(),
            decoded.debt.toString(),
            decoded.rate.toString(),
            hexToBytea(stamp.txHash),
            stamp.logIndex,
            hexToBytea(stamp.blockHash),
            stamp.blockNumber.toString(),
        ],
    );
    return res.rowCount ?? 0;
}
