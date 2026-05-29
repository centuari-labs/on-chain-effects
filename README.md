# @centuari-labs/on-chain-effects

The **C10 verify-then-apply** idempotency primitive shared between eager-path writers (`backend-v2`, `settlement-engine`, `sweeper-bot`) and the `indexer-v3` tail. Both paths apply the same mutation keyed by `(tx_hash, log_index)`; whichever commits second no-ops.

## Install

This package lives in the private GitHub Packages registry. Consumers need:

1. A `.npmrc` in the repo root (or home dir):

    ```
    @centuari-labs:registry=https://npm.pkg.github.com
    //npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
    ```

2. `NODE_AUTH_TOKEN` env var set to a GitHub PAT with `read:packages` scope (local dev) or to `${{ secrets.GITHUB_TOKEN }}` in GitHub Actions.

Then:

```bash
pnpm add @centuari-labs/on-chain-effects
```

`viem` and `pg` are peer dependencies — the consumer must have them installed.

## Usage

```ts
import {
    applyOnChainEffect,
    type IdempotencyStamp,
} from "@centuari-labs/on-chain-effects";

const result = await applyOnChainEffect({
    client,
    pool,
    txHash,
    expectedEventTopic: CREDITED_TOPIC,
    abi: BalanceLedgerAbi,
    expectedArgsPredicate: (args) => args.user === expectedUser,
    alreadyAppliedCheck: async (tx, stamp) => {
        const row = await tx.query(
            "SELECT applied_by_tx_hash FROM user_balance WHERE user_address = $1 AND asset = $2",
            [userAddressBytea, assetBytea],
        );
        return row.rows[0]?.applied_by_tx_hash?.equals(stamp.txHash);
    },
    mutation: async (tx, args, stamp) => {
        await tx.query(
            `UPDATE user_balance
               SET available = available + $1,
                   applied_by_tx_hash = $2,
                   applied_by_log_index = $3,
                   applied_by_block_hash = $4,
                   applied_by_block_number = $5
             WHERE user_address = $6 AND asset = $7`,
            [
                args.amount,
                stamp.txHash,
                stamp.logIndex,
                stamp.blockHash,
                stamp.blockNumber,
                userAddressBytea,
                assetBytea,
            ],
        );
    },
});
```

Possible `result` shapes:

- `{ applied: true }` — mutation ran and committed.
- `{ applied: false, reason: "receipt_reverted" }` — on-chain tx reverted.
- `{ applied: false, reason: "event_missing" }` — topic not present in receipt.
- `{ applied: false, reason: "args_mismatch" }` — decoded args failed predicate.
- `{ applied: false, reason: "already_stamped" }` — `alreadyAppliedCheck` returned true.

Anything else throws.

## Invariants

1. `mutation` must stamp `applied_by_tx_hash`, `applied_by_log_index`, `applied_by_block_hash`, `applied_by_block_number` on every row it touches.
2. `mutation` runs inside an open `pg` transaction — do not `BEGIN` or `COMMIT` yourself.
3. `expectedArgsPredicate` must be pure and synchronous.

## Per-event mutations (C7)

As of `v0.3.0` the package also owns the per-event upsert SQL itself — not just the wrapper. These tx-agnostic functions are the single source of truth for every stamped mutation on the shared on-chain-state schema, called by **both** the eager-path writers (`backend-v2` `apply-*.ts`, `settlement-engine` `apply-settlement.ts`) **and** the `indexer-v3` tail. The emitted SQL is identical **by construction**, not kept in sync by code-review discipline. Each takes a caller-owned `PoolClient`, runs one parameterised statement, stamps the four `applied_by_*` columns, and returns the affected row count.

| Function | Event | Table |
|---|---|---|
| `applyCreditedMutation` | `BalanceLedger.Credited` | `user_balance.available +=` |
| `applyDebitedMutation` | `BalanceLedger.Debited` | `user_balance.available -=` |
| `applyCollateralFlagSetMutation` | `BalanceLedger.CollateralFlagSet` | `user_balance.used_as_collateral`, `flagged_at` |
| `applyRepaidMutation` | `Centuari.Repaid` | `borrow_position.debt -=` |
| `applyBorrowPositionCreatedMutation` | `Centuari.BorrowPositionCreated` | `borrow_position` upsert |
| `applyLendPositionCreatedMutation` | `Centuari.LendPositionCreated` | `lend_position` upsert |
| `applyLendPositionWithdrawnMutation` | `Centuari.LendPositionWithdrawn` | `lend_position` decrement |
| `applyMarketCreatedMutation` (`v0.4.0`) | `Centuari.MarketCreated` | `market` insert-if-absent |

Plus `isAlreadyStamped(tx, table, pkCondition, pkValues, stamp)` for the idempotency check and `hexToBytea(hex)` for `BYTEA` binding.

**`applyMarketCreatedMutation` is the one deliberate asymmetry.** It takes a **nullable** stamp (`IdempotencyStamp | null`) because the backend registers markets on a daily cron *before* any on-chain `MarketCreated` event exists (the contract only emits that on a market's first settlement). The eager path passes `null` → the row carries NULL `applied_by_*` until the indexer tail observes the first settlement, at which point its `ON CONFLICT (market_id) DO NOTHING` makes the tail-write a no-op and the stamps stay NULL. `market` rows are immutable once created, so the unstamped row is safe and needs no `isAlreadyStamped` guard. A return value of `0` here means the row already existed (the other writer won the race) — never a warning.

## Publishing

Publishes run automatically via `.github/workflows/publish.yml` on any tag matching `v*`.

```bash
# bump version
pnpm version patch  # or minor / major
git push && git push --tags
```

The workflow uses the repo's `GITHUB_TOKEN` with `packages: write` — no PAT setup needed.

## Local iteration

When actively changing the helper and a consumer together:

```bash
# in this repo
pnpm build && pnpm link --global

# in the consumer (backend-v2, indexer-v3, etc.)
pnpm link --global @centuari-labs/on-chain-effects
```

Unlink with `pnpm unlink --global @centuari-labs/on-chain-effects`.

For anything beyond trivial changes, cut a pre-release (`pnpm version prerelease --preid=alpha`) and install the real artifact — `pnpm link` hides packaging bugs (excluded files, broken `exports`).
