import { describe, expect, jest, test } from "@jest/globals";
import type { Pool, PoolClient } from "pg";
import {
    type Hex,
    type PublicClient,
    type TransactionReceipt,
    encodeEventTopics,
    keccak256,
    toHex,
} from "viem";
import {
    applyOnChainEffect,
    MissingClientError,
} from "../apply-on-chain-effect.js";

const SIG = "Sample(bytes32,address,uint256)" as const;
const TOPIC0 = keccak256(toHex(SIG));

const ABI = [
    {
        type: "event",
        name: "Sample",
        inputs: [
            { name: "id", type: "bytes32", indexed: true },
            { name: "who", type: "address", indexed: true },
            { name: "value", type: "uint256", indexed: false },
        ],
    },
] as const;

interface SampleArgs {
    id: Hex;
    who: Hex;
    value: bigint;
}

const TX_HASH =
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;
const BLOCK_HASH =
    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex;
const OTHER_TOPIC =
    "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as Hex;

function encodeSampleLog(args: {
    id: Hex;
    who: Hex;
    value: bigint;
    logIndex: number;
}) {
    const topics = encodeEventTopics({
        abi: ABI,
        eventName: "Sample",
        args: { id: args.id, who: args.who },
    });
    const data = `0x${args.value.toString(16).padStart(64, "0")}` as Hex;
    return {
        address: "0x0000000000000000000000000000000000000001" as Hex,
        blockHash: BLOCK_HASH,
        blockNumber: 100n,
        data,
        logIndex: args.logIndex,
        removed: false,
        topics: topics as readonly Hex[],
        transactionHash: TX_HASH,
        transactionIndex: 0,
    };
}

function buildReceipt(
    logs: ReturnType<typeof encodeSampleLog>[],
    status: "success" | "reverted" = "success",
): TransactionReceipt {
    return {
        blockHash: BLOCK_HASH,
        blockNumber: 100n,
        contractAddress: null,
        cumulativeGasUsed: 21000n,
        effectiveGasPrice: 1n,
        from: "0x0000000000000000000000000000000000000002" as Hex,
        gasUsed: 21000n,
        logs: logs as never,
        logsBloom: "0x" as Hex,
        status,
        to: "0x0000000000000000000000000000000000000003" as Hex,
        transactionHash: TX_HASH,
        transactionIndex: 0,
        type: "eip1559",
    } as unknown as TransactionReceipt;
}

function makePoolMock(): {
    pool: Pool;
    client: jest.Mocked<Pick<PoolClient, "query" | "release">>;
    queries: string[];
} {
    const queries: string[] = [];
    const client = {
        query: jest.fn(async (sql: unknown) => {
            queries.push(String(sql));
            return { rows: [], rowCount: 0 };
        }),
        release: jest.fn(),
    } as unknown as jest.Mocked<Pick<PoolClient, "query" | "release">>;
    const pool = {
        connect: jest.fn(async () => client),
    } as unknown as Pool;
    return { pool, client, queries };
}

const ID =
    "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;
const WHO = "0x4444444444444444444444444444444444444444" as Hex;

describe("applyOnChainEffect", () => {
    describe("pre-fetched receipt path", () => {
        test("applies the mutation and returns { applied: true } on happy path", async () => {
            const { pool, queries } = makePoolMock();
            const mutation = jest.fn(async () => {});
            const receipt = buildReceipt([
                encodeSampleLog({ id: ID, who: WHO, value: 42n, logIndex: 3 }),
            ]);

            const res = await applyOnChainEffect<SampleArgs>({
                pool,
                receipt,
                txHash: TX_HASH,
                expectedEventTopic: TOPIC0,
                abi: ABI,
                expectedArgsPredicate: (a) => a.value === 42n,
                mutation,
            });

            expect(res).toEqual({ applied: true });
            expect(mutation).toHaveBeenCalledTimes(1);
            const [, decoded, stamp] = mutation.mock.calls[0] as unknown as [
                PoolClient,
                SampleArgs,
                unknown,
            ];
            expect(decoded.value).toBe(42n);
            expect(stamp).toMatchObject({
                txHash: TX_HASH,
                blockHash: BLOCK_HASH,
                blockNumber: 100n,
                logIndex: 3,
            });
            expect(queries).toContain("BEGIN");
            expect(queries).toContain("COMMIT");
        });

        test("returns receipt_reverted without opening a pg tx", async () => {
            const { pool, client } = makePoolMock();
            const mutation = jest.fn(async () => {});
            const receipt = buildReceipt(
                [encodeSampleLog({ id: ID, who: WHO, value: 1n, logIndex: 0 })],
                "reverted",
            );

            const res = await applyOnChainEffect<SampleArgs>({
                pool,
                receipt,
                txHash: TX_HASH,
                expectedEventTopic: TOPIC0,
                abi: ABI,
                expectedArgsPredicate: () => true,
                mutation,
            });

            expect(res).toEqual({
                applied: false,
                reason: "receipt_reverted",
            });
            expect(mutation).not.toHaveBeenCalled();
            expect(client.query).not.toHaveBeenCalled();
        });

        test("returns event_missing when no log matches topic0", async () => {
            const { pool } = makePoolMock();
            const mutation = jest.fn(async () => {});
            const receipt = buildReceipt([
                {
                    ...encodeSampleLog({
                        id: ID,
                        who: WHO,
                        value: 1n,
                        logIndex: 0,
                    }),
                    topics: [OTHER_TOPIC] as readonly Hex[],
                },
            ]);

            const res = await applyOnChainEffect<SampleArgs>({
                pool,
                receipt,
                txHash: TX_HASH,
                expectedEventTopic: TOPIC0,
                abi: ABI,
                expectedArgsPredicate: () => true,
                mutation,
            });

            expect(res).toEqual({ applied: false, reason: "event_missing" });
            expect(mutation).not.toHaveBeenCalled();
        });

        test("returns args_mismatch when predicate fails", async () => {
            const { pool } = makePoolMock();
            const mutation = jest.fn(async () => {});
            const receipt = buildReceipt([
                encodeSampleLog({ id: ID, who: WHO, value: 42n, logIndex: 0 }),
            ]);

            const res = await applyOnChainEffect<SampleArgs>({
                pool,
                receipt,
                txHash: TX_HASH,
                expectedEventTopic: TOPIC0,
                abi: ABI,
                expectedArgsPredicate: (a) => a.value === 99n,
                mutation,
            });

            expect(res).toEqual({ applied: false, reason: "args_mismatch" });
            expect(mutation).not.toHaveBeenCalled();
        });

        test("returns already_stamped without calling mutation", async () => {
            const { pool } = makePoolMock();
            const mutation = jest.fn(async () => {});
            const receipt = buildReceipt([
                encodeSampleLog({ id: ID, who: WHO, value: 42n, logIndex: 0 }),
            ]);

            const res = await applyOnChainEffect<SampleArgs>({
                pool,
                receipt,
                txHash: TX_HASH,
                expectedEventTopic: TOPIC0,
                abi: ABI,
                expectedArgsPredicate: () => true,
                alreadyAppliedCheck: async () => true,
                mutation,
            });

            expect(res).toEqual({
                applied: false,
                reason: "already_stamped",
            });
            expect(mutation).not.toHaveBeenCalled();
        });

        test("rolls back pg tx when mutation throws", async () => {
            const { pool, queries } = makePoolMock();
            const mutation = jest.fn(async () => {
                throw new Error("boom");
            });
            const receipt = buildReceipt([
                encodeSampleLog({ id: ID, who: WHO, value: 42n, logIndex: 0 }),
            ]);

            await expect(
                applyOnChainEffect<SampleArgs>({
                    pool,
                    receipt,
                    txHash: TX_HASH,
                    expectedEventTopic: TOPIC0,
                    abi: ABI,
                    expectedArgsPredicate: () => true,
                    mutation,
                }),
            ).rejects.toThrow("boom");

            expect(queries).toContain("BEGIN");
            expect(queries).toContain("ROLLBACK");
            expect(queries).not.toContain("COMMIT");
        });
    });

    describe("logIndex-targeted selection", () => {
        test("picks the log at the given logIndex, not the first topic match", async () => {
            const { pool } = makePoolMock();
            const mutation = jest.fn(async () => {});
            const receipt = buildReceipt([
                encodeSampleLog({ id: ID, who: WHO, value: 100n, logIndex: 2 }),
                encodeSampleLog({ id: ID, who: WHO, value: 200n, logIndex: 5 }),
                encodeSampleLog({ id: ID, who: WHO, value: 300n, logIndex: 7 }),
            ]);

            const res = await applyOnChainEffect<SampleArgs>({
                pool,
                receipt,
                txHash: TX_HASH,
                expectedEventTopic: TOPIC0,
                logIndex: 5,
                abi: ABI,
                expectedArgsPredicate: () => true,
                mutation,
            });

            expect(res).toEqual({ applied: true });
            const [, decoded, stamp] = mutation.mock.calls[0] as unknown as [
                PoolClient,
                SampleArgs,
                { logIndex: number },
            ];
            expect(decoded.value).toBe(200n);
            expect(stamp.logIndex).toBe(5);
        });

        test("returns event_missing when logIndex does not exist in receipt", async () => {
            const { pool } = makePoolMock();
            const mutation = jest.fn(async () => {});
            const receipt = buildReceipt([
                encodeSampleLog({ id: ID, who: WHO, value: 100n, logIndex: 2 }),
            ]);

            const res = await applyOnChainEffect<SampleArgs>({
                pool,
                receipt,
                txHash: TX_HASH,
                expectedEventTopic: TOPIC0,
                logIndex: 99,
                abi: ABI,
                expectedArgsPredicate: () => true,
                mutation,
            });

            expect(res).toEqual({ applied: false, reason: "event_missing" });
            expect(mutation).not.toHaveBeenCalled();
        });

        test("returns event_missing when logIndex points at a different topic", async () => {
            const { pool } = makePoolMock();
            const mutation = jest.fn(async () => {});
            const receipt = buildReceipt([
                {
                    ...encodeSampleLog({
                        id: ID,
                        who: WHO,
                        value: 1n,
                        logIndex: 4,
                    }),
                    topics: [OTHER_TOPIC] as readonly Hex[],
                },
                encodeSampleLog({ id: ID, who: WHO, value: 2n, logIndex: 5 }),
            ]);

            const res = await applyOnChainEffect<SampleArgs>({
                pool,
                receipt,
                txHash: TX_HASH,
                expectedEventTopic: TOPIC0,
                logIndex: 4,
                abi: ABI,
                expectedArgsPredicate: () => true,
                mutation,
            });

            expect(res).toEqual({ applied: false, reason: "event_missing" });
            expect(mutation).not.toHaveBeenCalled();
        });
    });

    describe("client-fetched receipt path", () => {
        test("falls back to waitForTransactionReceipt when receipt is absent", async () => {
            const { pool } = makePoolMock();
            const mutation = jest.fn(async () => {});
            const receipt = buildReceipt([
                encodeSampleLog({ id: ID, who: WHO, value: 42n, logIndex: 0 }),
            ]);
            const waitForTransactionReceipt = jest.fn(async () => receipt);
            const client = {
                waitForTransactionReceipt,
            } as unknown as PublicClient;

            const res = await applyOnChainEffect<SampleArgs>({
                client,
                pool,
                txHash: TX_HASH,
                expectedEventTopic: TOPIC0,
                abi: ABI,
                expectedArgsPredicate: () => true,
                mutation,
            });

            expect(res).toEqual({ applied: true });
            expect(waitForTransactionReceipt.mock.calls[0]).toEqual([
                { hash: TX_HASH },
            ]);
        });

        test("throws MissingClientError when neither receipt nor client is provided", async () => {
            const { pool } = makePoolMock();

            await expect(
                applyOnChainEffect<SampleArgs>({
                    pool,
                    txHash: TX_HASH,
                    expectedEventTopic: TOPIC0,
                    abi: ABI,
                    expectedArgsPredicate: () => true,
                    mutation: async () => {},
                }),
            ).rejects.toBeInstanceOf(MissingClientError);
        });
    });
});
