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
