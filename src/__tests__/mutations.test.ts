import { describe, expect, jest, test } from "@jest/globals";
import type { PoolClient } from "pg";
import type { Hex } from "viem";
import type { IdempotencyStamp } from "../apply-on-chain-effect.js";
import {
    applyBorrowPositionCreatedMutation,
    applyCollateralFlagSetMutation,
    applyCreditedMutation,
    applyDebitedMutation,
    applyLendPositionCreatedMutation,
    applyLendPositionWithdrawnMutation,
    applyRepaidMutation,
    hexToBytea,
    isAlreadyStamped,
} from "../mutations.js";

const TX =
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;
const BLOCK =
    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex;
const USER = `0x${"11".repeat(20)}` as Hex;
const ASSET = `0x${"22".repeat(20)}` as Hex;
const MARKET = `0x${"33".repeat(32)}` as Hex;
const BOND = `0x${"44".repeat(20)}` as Hex;

const STAMP: IdempotencyStamp = {
    txHash: TX,
    logIndex: 3,
    blockHash: BLOCK,
    blockNumber: 100n,
};

/** Collapse whitespace so SQL snapshots aren't brittle to reformatting. */
const norm = (sql: string): string => sql.replace(/\s+/g, " ").trim();

function makeTxMock(rowCount = 1, rows: unknown[] = []) {
    const calls: { sql: string; params: unknown[] }[] = [];
    const query = jest.fn(async (sql: unknown, params?: unknown) => {
        calls.push({
            sql: norm(String(sql)),
            params: (params as unknown[]) ?? [],
        });
        return { rows, rowCount };
    });
    const tx = { query } as unknown as PoolClient;
    return { tx, calls, query };
}

describe("hexToBytea", () => {
    test("strips 0x and decodes to a Buffer", () => {
        expect(hexToBytea("0xdeadbeef")).toEqual(
            Buffer.from("deadbeef", "hex"),
        );
    });

    test("accepts a value without 0x prefix", () => {
        expect(hexToBytea("deadbeef" as Hex)).toEqual(
            Buffer.from("deadbeef", "hex"),
        );
    });

    test("throws on odd-length hex", () => {
        expect(() => hexToBytea("0xabc" as Hex)).toThrow("odd-length");
    });
});

describe("balance delta mutations", () => {
    test("applyCreditedMutation writes available += amount", async () => {
        const { tx, calls } = makeTxMock();
        const rows = await applyCreditedMutation(
            tx,
            { user: USER, asset: ASSET, amount: 42n },
            STAMP,
        );

        expect(rows).toBe(1);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.sql).toMatchSnapshot();
        expect(calls[0]?.params).toEqual([
            hexToBytea(USER),
            hexToBytea(ASSET),
            "42",
            hexToBytea(TX),
            3,
            hexToBytea(BLOCK),
            "100",
        ]);
    });

    test("applyDebitedMutation writes a negative delta", async () => {
        const { tx, calls } = makeTxMock();
        await applyDebitedMutation(
            tx,
            { user: USER, asset: ASSET, amount: 42n },
            STAMP,
        );

        // Same upsert SQL as credit — only the delta sign differs.
        expect(calls[0]?.sql).toMatchSnapshot();
        expect(calls[0]?.params[2]).toBe("-42");
    });

    test("credit and debit emit byte-identical SQL", async () => {
        const credit = makeTxMock();
        const debit = makeTxMock();
        await applyCreditedMutation(
            credit.tx,
            { user: USER, asset: ASSET, amount: 1n },
            STAMP,
        );
        await applyDebitedMutation(
            debit.tx,
            { user: USER, asset: ASSET, amount: 1n },
            STAMP,
        );
        expect(credit.calls[0]?.sql).toBe(debit.calls[0]?.sql);
    });
});

describe("collateral flag mutation", () => {
    test("applyCollateralFlagSetMutation writes flag + flagged_at verbatim", async () => {
        const { tx, calls } = makeTxMock();
        const rows = await applyCollateralFlagSetMutation(
            tx,
            { user: USER, asset: ASSET, used: true, flaggedAt: 1234n },
            STAMP,
        );

        expect(rows).toBe(1);
        expect(calls[0]?.sql).toMatchSnapshot();
        expect(calls[0]?.params).toEqual([
            hexToBytea(USER),
            hexToBytea(ASSET),
            true,
            "1234",
            hexToBytea(TX),
            3,
            hexToBytea(BLOCK),
            "100",
        ]);
    });

    test("unmark carries flagged_at = 0 and used = false", async () => {
        const { tx, calls } = makeTxMock();
        await applyCollateralFlagSetMutation(
            tx,
            { user: USER, asset: ASSET, used: false, flaggedAt: 0n },
            STAMP,
        );
        expect(calls[0]?.params[2]).toBe(false);
        expect(calls[0]?.params[3]).toBe("0");
    });
});

describe("position mutations", () => {
    test("applyRepaidMutation decrements debt floored at 0", async () => {
        const { tx, calls } = makeTxMock();
        const rows = await applyRepaidMutation(
            tx,
            { marketId: MARKET, borrower: USER, amount: 7n },
            STAMP,
        );

        expect(rows).toBe(1);
        expect(calls[0]?.sql).toMatchSnapshot();
        expect(calls[0]?.params).toEqual([
            hexToBytea(MARKET),
            hexToBytea(USER),
            "7",
            hexToBytea(TX),
            3,
            hexToBytea(BLOCK),
            "100",
        ]);
    });

    test("applyRepaidMutation returns 0 when no open position matched", async () => {
        const { tx } = makeTxMock(0);
        const rows = await applyRepaidMutation(
            tx,
            { marketId: MARKET, borrower: USER, amount: 7n },
            STAMP,
        );
        expect(rows).toBe(0);
    });

    test("applyLendPositionWithdrawnMutation decrements cbt + principal", async () => {
        const { tx, calls } = makeTxMock();
        await applyLendPositionWithdrawnMutation(
            tx,
            {
                marketId: MARKET,
                lender: USER,
                cbtBurned: 5n,
                amountWithdrawn: 6n,
            },
            STAMP,
        );
        expect(calls[0]?.sql).toMatchSnapshot();
        expect(calls[0]?.params).toEqual([
            hexToBytea(MARKET),
            hexToBytea(USER),
            "5",
            "6",
            hexToBytea(TX),
            3,
            hexToBytea(BLOCK),
            "100",
        ]);
    });

    test("applyLendPositionCreatedMutation upserts a lend position", async () => {
        const { tx, calls } = makeTxMock();
        await applyLendPositionCreatedMutation(
            tx,
            {
                marketId: MARKET,
                lender: USER,
                bondToken: BOND,
                cbtAmount: 8n,
                principal: 9n,
                rate: 10n,
            },
            STAMP,
        );
        expect(calls[0]?.sql).toMatchSnapshot();
        expect(calls[0]?.params).toEqual([
            hexToBytea(MARKET),
            hexToBytea(USER),
            hexToBytea(BOND),
            "8",
            "9",
            "10",
            hexToBytea(TX),
            3,
            hexToBytea(BLOCK),
            "100",
        ]);
    });

    test("applyBorrowPositionCreatedMutation upserts a borrow position", async () => {
        const { tx, calls } = makeTxMock();
        await applyBorrowPositionCreatedMutation(
            tx,
            {
                marketId: MARKET,
                borrower: USER,
                principal: 11n,
                debt: 12n,
                rate: 13n,
            },
            STAMP,
        );
        expect(calls[0]?.sql).toMatchSnapshot();
        expect(calls[0]?.params).toEqual([
            hexToBytea(MARKET),
            hexToBytea(USER),
            "11",
            "12",
            "13",
            hexToBytea(TX),
            3,
            hexToBytea(BLOCK),
            "100",
        ]);
    });
});

describe("isAlreadyStamped", () => {
    test("returns true when a matching stamp row exists", async () => {
        const { tx, calls } = makeTxMock(1, [{ count: "1" }]);
        const result = await isAlreadyStamped(
            tx,
            "user_balance",
            "user_address = $1 AND asset = $2",
            [hexToBytea(USER), hexToBytea(ASSET)],
            STAMP,
        );

        expect(result).toBe(true);
        expect(calls[0]?.sql).toContain("FROM user_balance");
        expect(calls[0]?.sql).toContain("applied_by_tx_hash = $3");
        expect(calls[0]?.sql).toContain("applied_by_log_index = $4");
        expect(calls[0]?.params).toEqual([
            hexToBytea(USER),
            hexToBytea(ASSET),
            hexToBytea(TX),
            3,
        ]);
    });

    test("returns false when count is 0", async () => {
        const { tx } = makeTxMock(1, [{ count: "0" }]);
        const result = await isAlreadyStamped(
            tx,
            "borrow_position",
            "market_id = $1 AND borrower = $2",
            [hexToBytea(MARKET), hexToBytea(USER)],
            STAMP,
        );
        expect(result).toBe(false);
    });
});
