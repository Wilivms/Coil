# End-to-end run on Mezo testnet (4 Nov 2026)

Every CoilRouter v3 flow, live, in one sitting: `cd keeper && E2E_PRIVATE_KEY=0x... npm run e2e`.
Wallet `0x329A…34ab`, BTC at 80,2xx (MUSD PriceFeed), not in Recovery Mode. Each protection was armed already due;
the always-on keeper (GitHub Actions, wallet `0x09b6…e2A1`) fired **all three on its own** before the script's
fallback timer ran out.

| # | Step | By | Tx |
|---|---|---|---|
| 1 | coil (0.03 BTC → 0.066 BTC trove, 2.2×) | user | [`0x30d165e7…`](https://explorer.test.mezo.org/tx/0x30d165e770f796bd3cb1a0a6e546a7867e1940e36e5a2c5265c8c4e281393fc9) |
| 2 | depositReserve (MUSD into sMUSD) | user | [`0xfd156346…`](https://explorer.test.mezo.org/tx/0xfd156346da66d7f1e9d02e29632b4310cfb71e47025964c0a55a6d54c4088e70) |
| 3 | armShield (repay 100 MUSD, due now) | user | [`0x74f1587b…`](https://explorer.test.mezo.org/tx/0x74f1587bebfa9980a7aef640e770ca53933d2f5dae5147745685b394ad13780a) |
| 4 | **fireShield** | **keeper** | [`0xc5d1d4c2…`](https://explorer.test.mezo.org/tx/0xc5d1d4c2bdb380496faf75bcc4e6401b3ae50483c61492fe46c83cc68fbdde53) |
| 5 | relever (+0.01 BTC) | user | [`0x846f58cb…`](https://explorer.test.mezo.org/tx/0x846f58cb8b5798d13b6cb22ade5b963865fc44cc40472a5563b0a13327d9fdca) |
| 6 | armRecoil (trigger at MCR) | user | [`0x4ae8f7a0…`](https://explorer.test.mezo.org/tx/0x4ae8f7a04380b29c55eeebcfb04761678aa9677755c98f5aaa5c967a5f1d946f) |
| 7 | **fireRecoil** (+0.005 BTC) | **keeper** | [`0xc6176c4a…`](https://explorer.test.mezo.org/tx/0xc6176c4aa4fab70e6f65d9efe99448ba1f77d3680362968ff51f3e9d23ab5b6b) |
| 8 | armGuard (repay 300 MUSD, minBtcOut signed) | user | [`0x208cfccb…`](https://explorer.test.mezo.org/tx/0x208cfccb3cb20f4bc3a9e07b73c82821d42fbce9bee011b5dba2e0ad4b00513a) |
| 9 | **fireGuard** | **keeper** | [`0x5908cbdf…`](https://explorer.test.mezo.org/tx/0x5908cbdf292679bfda8edca549cf68859d68c3cb84dfbd93d4907aa17647265d) |
| 10 | deleverage (repay 200 MUSD) | user | [`0x98dff4e4…`](https://explorer.test.mezo.org/tx/0x98dff4e42f4855fd33465677763445b2bf74d474eb8888e6df197e3c3119795a) |
| 11 | pushIncentives (MUSD → MUSD/BTC gauge) | anyone | [`0x98b623f3…`](https://explorer.test.mezo.org/tx/0x98b623f36576c9242b9f03af6a5464ef30c6757840c61104b407d70962ca22ae) |
| 12 | withdrawReserve (yield included) | user | [`0xb1459cd6…`](https://explorer.test.mezo.org/tx/0xb1459cd64a2e730722bfb143bd86cf90857ba8ed6d435d5b4540dc778cb57d33) |
| 13 | unwind (trove closed, BTC back) | user | [`0x6d4366f4…`](https://explorer.test.mezo.org/tx/0x6d4366f4eb14fb095204b603bddd02f9ac268f1345aee9613f3c8c37fd4c0fc4) |

Result: trove opened, protected three ways, levered up twice, partly deleveraged and closed; the router ended with 0 BTC
and 0 loose MUSD (invariants R5/R6 hold on-chain too).

## Found by this run

The first `relever` attempt ([`0xcc6e…50bd`](https://explorer.test.mezo.org/tx/0xcc6e3448e169c6e54b7576817567e26fb4826507077cb85c9bfd82b0d28e50bd)) passed
simulation and then reverted on-chain: with zero hints MUSD's SortedTroves walks the 350-trove list, and the bare gas
estimate left an inner call short (63/64 rule). Fixed: the keeper and this script now send 1.5× the estimate; the app
already computes real insert hints (`insertHints` in `app/src/lib/actions.ts`).

## v4 run (11 Nov 2026): the pool 5.5% off the oracle

On 10 Nov the testnet MUSD/BTC pool priced BTC 5.5% above MUSD's PriceFeed, past the 5% owner cap: v3 refused every
coil and every leverage-up, for everyone. v4 (`0x17e0…7F03`) lets a borrower accept a wider gap for a trade **they send
themselves** (`deviationBps`, at most 20%, the app sets it from the live quote and shows it before signing). Keeper-fired
flows never get that choice. Same wallet, same script (`npm run e2e`), with the gap still there:

| # | Step | Tx |
|---|---|---|
| 1 | coil at a 5.5% pool/oracle gap (own tolerance 7.5%) | [`0x936fa5b7…`](https://explorer.test.mezo.org/tx/0x936fa5b7dc50db1a97bdec55eb1e3dc07267deca43dae8b696700b56fcb2a7ea) |
| 2 | depositReserve | [`0x792cfe2f…`](https://explorer.test.mezo.org/tx/0x792cfe2f555f1a32f978bb98c2327db4d9ee4da78cec26dc9321074188445cfd) |
| 3 | armShield | [`0x67e4e76f…`](https://explorer.test.mezo.org/tx/0x67e4e76fefe50f182bf792c13f4822784381ace9cf904857d337da13f43b3291) |
| 4 | fireShield | [`0x2b612f5f…`](https://explorer.test.mezo.org/tx/0x2b612f5f6041a62adceaae7d6ab21041d0fd445d9ef8ce0a748da8f2dabee075) |
| 5 | relever at the same gap (own tolerance 7.5%) | [`0x053a71c3…`](https://explorer.test.mezo.org/tx/0x053a71c309604334e58598c3d1027176beed73f93148bc2937b4bcd5336c4768) |
| 6 | armRecoil | [`0x0a1c8691…`](https://explorer.test.mezo.org/tx/0x0a1c86910c6d5b36ae42f49a74f016ede85ce83c067e866b519d8bca80f453a3) |
| 7 | fireRecoil **refused** by the 3% bound: a keeper may not buy BTC 5.5% dear for the user | — |
| 8 | disarmRecoil | [`0xe2d7843a…`](https://explorer.test.mezo.org/tx/0xe2d7843ad4c9a36244b02508b1ce73385d8b80c6037523950f4020c66bef599d) |
| 9 | armGuard | [`0xd857d9b7…`](https://explorer.test.mezo.org/tx/0xd857d9b7f76c3df126e3f8245448911b9416d2e60ccbdfab14682d6155fc77b8) |
| 10 | fireGuard (selling BTC into a pool where it is dear: within the bound) | [`0xb5a843f8…`](https://explorer.test.mezo.org/tx/0xb5a843f837c5c19a7040d72891ae7b8c949955190926c43f4987440bfda3a67c) |
| 11 | deleverage | [`0xc3c957c7…`](https://explorer.test.mezo.org/tx/0xc3c957c78d6da562bd9cfea3f90617ddec95f4d36212b3b1729a8b8252bb1ab7) |
| 12 | pushIncentives | [`0xd88e5252…`](https://explorer.test.mezo.org/tx/0xd88e52521cb669b77e63361ca9b579aba0c22ceadaf1788db7dccfca39aa6c69) |
| 13 | withdrawReserve | [`0x61bb3d19…`](https://explorer.test.mezo.org/tx/0x61bb3d19416c24b1349b4c16e8529a3f7af2c1a9786b00faa511038f02587f1d) |
| 14 | unwind | [`0x621863b3…`](https://explorer.test.mezo.org/tx/0x621863b3f004f20decbc5dc0eda568fd56497652462a1b7682e9e3f45da290e9) |

Two more things this run found and fixed in the keeper and the script: the RPC once estimated 32,742 gas for a
`fireShield` that used 4.7M (hintless SortedTroves walk), so sends now use a 1.5M floor; and 1.5× a large estimate can
pass Mezo's 10M block limit, so sends are capped at 9.5M.

## v4 run with insert hints (11 Nov 2026, 05:15 CET)

Same 14 steps, now with SortedTroves insert hints from MUSD's HintHelpers on every call (keeper and script; the app
already had them). The keeper fired the Shield and the Guard on its own; the Recoil was refused by the 3% bound again
(pool still ~6% off the oracle).

| Step | Tx |
|---|---|
| coil | [`0xc31acdd3…`](https://explorer.test.mezo.org/tx/0xc31acdd3b70752de3c50a8444b068f38342310687a19de9b5cfb1d9124be24b8) |
| fireShield (keeper) | [`0x545502b1…`](https://explorer.test.mezo.org/tx/0x545502b160ec07db691e97463ff49017f53e1661453ad071a7737cfcc075f70a) |
| relever | [`0x62d53d04…`](https://explorer.test.mezo.org/tx/0x62d53d042644ab677e2e6cf79204154205f8e5c79722e402906c0c8e02a47bcf) |
| fireRecoil | refused by the oracle bound, then `disarmRecoil` [`0xc2dfe03e…`](https://explorer.test.mezo.org/tx/0xc2dfe03e56e228ef4e76b1b79dfba2039429c17656e140b0c6e7ed5fbbf36e92) |
| fireGuard (keeper) | [`0xfc469bdb…`](https://explorer.test.mezo.org/tx/0xfc469bdbef91d731278a850da5b7e0c6e5266df487d2303973ba876201cfe513) |
| deleverage | [`0x3f24338b…`](https://explorer.test.mezo.org/tx/0x3f24338b3f85d5c3eb4e497d0a445a402f1ff0cfb03a7006cb9623dfe95f36d4) |
| unwind | [`0xdf119fff…`](https://explorer.test.mezo.org/tx/0xdf119fff7c9bee3d22099876a92280a57715fc549e76540786c0a780090fcb3f) |

Mezo charges at least half of a transaction's gas limit, so with hints in place the send floor drops from 1.5M to 600k.

## Through the app's own UI (11 Nov 2026)

`app/e2e/ui-e2e.mjs` drives the live site like a person would: a real browser (Playwright), the real UI, and a test
wallet injected as `window.ethereum` that signs with a local key. Every click is a real testnet transaction.

    cd app && E2E_KEY_FILE=path/to/key node e2e/ui-e2e.mjs      # APP_URL defaults to the live site

| Click in the app | Tx |
|---|---|
| Coil 0.025 BTC at 2x (Sign and coil) | [`0xdc38cc75…`](https://explorer.test.mezo.org/tx/0xdc38cc75fc654a48d74e452438bc9483eb862bcc77ddef8111f0fb74502351d8) |
| Guard: "Test it now" | [`0x8a079cea…`](https://explorer.test.mezo.org/tx/0x8a079ceace03ed766e7e82fa8d05eb4c022702cd6c1baf5c4da0fba80c5d3ddf) |
| Leverage up +0.25x | [`0x33055ece…`](https://explorer.test.mezo.org/tx/0x33055ecedec21868a3243a832b59334db9c373356857982187b91700f075d24f) |
| Deleverage 10% | [`0x6120f205…`](https://explorer.test.mezo.org/tx/0x6120f205db922f69cabf604d7f240b5ad5141a337e5a36bb524cd85bc5765ed3) |
| Unwind | [`0x72d81a47…`](https://explorer.test.mezo.org/tx/0x72d81a478c11ed30b98dcd0f113e4dae3f05cf0515926119ecf88d879604d909) |

The Guard armed from the app was fired by the keeper on its own between "Test it now" and "Leverage up".

Found by these runs and fixed in the app:
- A leverage-up **succeeded** on-chain while Mezo's RPC answered "method handler crashed" to the receipt poll, and the
  app showed "Leverage up failed". Confirmations now ride out transient RPC errors; a transaction that went through can
  no longer show as failed.
- "Fire it yourself" racing the keeper showed a raw revert; it now says the protection was already fired.
- Test-only: the injected wallet retries RPC hiccups during gas estimation, as a person would press retry.

### Reserve, Shield and Recoil through the UI (`FLOW=protect`)

| Click in the app | Tx |
|---|---|
| Coil 0.025 BTC at 2x | [`0x6720d8f8…`](https://explorer.test.mezo.org/tx/0x6720d8f89db3644a6ab85fea17855383e687fac198e7100402375ede7cf71963) |
| Reserve: Max, Add (approve + deposit into sMUSD) | [`0x4121a4a5…`](https://explorer.test.mezo.org/tx/0x4121a4a5ec27e36fc60e505b7e2b94064c619dd7f9a21bdda2bb4ca566cc7cdb) |
| Shield: "Test it now" | [`0x3b7304d9…`](https://explorer.test.mezo.org/tx/0x3b7304d9fa589c19e383cb1d09e5c33e82620c7e6bd7b3952162d8d41ac913f8) |
| **Keeper fires the Shield 3 blocks later** | [`0xf858c448…`](https://explorer.test.mezo.org/tx/0xf858c4483775876165eff77793e559a53e38414e126e58927cd074f8a2332a4a) |
| Recoil: "Test it now"; the pool is past the 3% bound, so the app offers Wait or Lever up now → "Lever up now" | [`0x58a72004…`](https://explorer.test.mezo.org/tx/0x58a720045630d0296fa4353af817697d76c9de9a37c4fc70af87edecb80d7c61) |
| Reserve: Withdraw all (yield included) | [`0x1c281d18…`](https://explorer.test.mezo.org/tx/0x1c281d187613b4a29eeb2f7d14f6279c3d1f5ca3f355b20a3240f01e7e199d77) |
| Unwind | [`0x741659cd…`](https://explorer.test.mezo.org/tx/0x741659cd56f0308089d193a3fe30106ae82053052f59a789010a5b4d51e89706) |

Found by this run and fixed: Mezo testnet's RPC failed the wallet's gas estimate twice ("invalid parameters"), which a
real wallet shows as an error. The app now estimates gas itself, retries the RPC's transient failures, and hands the
wallet a gas limit (a real revert is never retried).

## Edge cases with a second test wallet (11 Nov 2026)

Test wallet A (`0x2f8d…ea94`, listed as a team wallet on /proof) covered what normal use doesn't reach:

| What | How | Tx |
|---|---|---|
| A plain MUSD trove (not opened with Coil) at 112%, the front of the redemption queue | `keeper/scenario.mjs open-tail` | [`0xb8505192…`](https://explorer.test.mezo.org/tx/0xb8505192d1fbe9933fbc7cbe3604b71d2e59aaf69f44a163f1818acac9519cd6) |
| **A redemption bot already on testnet redeemed it, under 2 minutes later**: exactly the risk Coil is built for | not us: `0xD13F…6c67` | [`0xef69c012…`](https://explorer.test.mezo.org/tx/0xef69c012303d870e04a1fb7d1f4efe81e32ea8124dacccd9eb5dd68aa7e6c979) |
| Claim the leftover BTC (0.00597 BTC) from the app's banner | UI, `FLOW=claim` | [`0xa10138d2…`](https://explorer.test.mezo.org/tx/0xa10138d225682d9b23769327969c5a235897956d0c26330b2511f12e115b3f63) |
| Move a Reserve left on v2 back to the wallet, **on a phone** (iPhone 13 emulation) | UI, `MOBILE=1 FLOW=v2move` | [`0xbecb5e2b…`](https://explorer.test.mezo.org/tx/0xbecb5e2b77b38de32107764bba140967fb0e9f79279735ca68ca443cb55f40ef) |
| 4x coil, Reserve, Shield on the **redemption-queue trigger only** (price off, ≤ 250k MUSD ahead; 12,324 stood ahead) | UI, `FLOW=queue` | [`0x2ac212b5…`](https://explorer.test.mezo.org/tx/0x2ac212b5dd8e7036ef2836d6812dadd43bca65a40d70c77f29568551262e22b6) |
| **Another wallet fires it from the read-only view** (`#/app?address=…`, "Fire it yourself"), keeper paused: `byQueue = true`, 1,235 MUSD repaid, the 5 MUSD bounty to wallet A | UI, `FLOW=fire-other` | [`0xca1197da…`](https://explorer.test.mezo.org/tx/0xca1197dabe9dbab09aa7f5d921b38f38ed95919202c70f062fc963aba1268877) |
| Unwind | UI, `FLOW=unwind` | [`0xc380b68f…`](https://explorer.test.mezo.org/tx/0xc380b68fed8271b0d4bf83870f7a930af1ad51defafb686aa99a7244c5a18ca8) |

Found and fixed: the app let you arm a Shield bigger than your Reserve with only a status pill to say so; it now warns
before you sign that the Shield can't fire until the Reserve covers it.

Not reachable on testnet right now: a keeper-fired Recoil. The pool sits ~7% from the oracle and the contract refuses to
let a keeper buy BTC past 3%, by design; it fired on v3 when the gap was small ([`0xc6176c4a…`](https://explorer.test.mezo.org/tx/0xc6176c4aa4fab70e6f65d9efe99448ba1f77d3680362968ff51f3e9d23ab5b6b)).

## The timelock at work (11–12 Nov 2026)

CoilRouter v4's owner is CoilTimelock `0x1e56…9D33` (OpenZeppelin TimelockController, 24 h delay, no admin, anyone executes).
Its first operation turns on the 0.10% opening fee:

| Step | Tx |
|---|---|
| `schedule(router, 0, setFee(10), 0x0, "fee-0.10pct", 86400)` by a proposer | [`0x24f83642…`](https://explorer.test.mezo.org/tx/0x24f8364241596e901b97b4e2d83d1a7b3aa7ae2a5dc041d69713e07a8868c3d0) |
| `execute(…)` once the 24 h passed, from a third team wallet (`0xb9c2…E9cc`), not a proposer | [`0x92fd9b15…`](https://explorer.test.mezo.org/tx/0x92fd9b15a536d3aed9e3964f75b59cf610191c487e73ad53cb52b2632fbd27c0) (block 16722941) |

After: `feeBps()` reads 10. Operation id `0x853f7cf9…c900`.

## Fee live: full E2E after the timelock (12 Nov 2026, 00:41 Paris)

Third team wallet `0xb9c2…E9cc`, `keeper/e2e.mjs`, deposit 0.025 BTC at 3x, CoilRouter v4 with `feeBps = 10`.

**The fee:** the coil tx sent 0.025 BTC; the treasury `0xcFe7…b368` balance rose by exactly **0.000025 BTC (0.10%)** in that block
(16723129, read with `getBalance` at block − 1 and block). The fee is paid in BTC, so it shows as a balance change, not a log.

| Step | Tx |
|---|---|
| coil | [`0x5659ce58…`](https://explorer.test.mezo.org/tx/0x5659ce5811aea4c08c46a3aa0188a3449c9c6ca65fa59c16bf5126209852f03e) |
| approve MUSD | [`0x62262b2d…`](https://explorer.test.mezo.org/tx/0x62262b2dd4575f13b753a4ec5db2512dbf25b39901f2f6b9185b4ab3d8536ae6) |
| depositReserve | [`0xaf2131ac…`](https://explorer.test.mezo.org/tx/0xaf2131ac5a804dc0539641021f9ba79374ebc42ebd9b16badb5e444119172f14) |
| armShield | [`0xe160fc60…`](https://explorer.test.mezo.org/tx/0xe160fc60b53269c584b3bef4d1b7de927f5e23c6ad36759c4d53e5c0f9ea3b86) |
| fireShield | [`0x6d9e5264…`](https://explorer.test.mezo.org/tx/0x6d9e526448bd435ed89262da55d09bf00020b8ce3d1f5525e6e694ed43315251) |
| relever | [`0x7348a9a4…`](https://explorer.test.mezo.org/tx/0x7348a9a49dbd9141b15030962f4f426e0d87ce667792dfc2194b3469cb52d2b7) |
| armRecoil | [`0x35900629…`](https://explorer.test.mezo.org/tx/0x35900629b36441034d3d6bd8d1e2856c8bc3a2d3801efd6d5fd4df88b7c602ea) |
| fireRecoil refused (PriceDeviation) | refused on-chain, by design |
| disarmRecoil | [`0x3796b734…`](https://explorer.test.mezo.org/tx/0x3796b734bf8b1f36a5527b6dc38bb6949eb6b0e503f94c4fc93402e48a805691) |
| armGuard | [`0xfef8843d…`](https://explorer.test.mezo.org/tx/0xfef8843dd24987d98a6eecfff0e108cb607cd0e45532bd4d3441e1e9c10c6911) |
| fireGuard | [`0x93bde60a…`](https://explorer.test.mezo.org/tx/0x93bde60a751f5f5b0256ecd802aa5b44d2f8e30f6161db6c12012909aa37da71) |
| deleverage | [`0x568a47ff…`](https://explorer.test.mezo.org/tx/0x568a47ff235050d7cf00d717bde1f2698b255720bddfd67fe01d4514c87c5ec4) |
| pushIncentives | [`0x05da8dad…`](https://explorer.test.mezo.org/tx/0x05da8dad112e4259784ec44a23df1d9c958a687dfb92d8ebb2ca73fba4f1383e) |
| withdrawReserve | [`0x252c4a18…`](https://explorer.test.mezo.org/tx/0x252c4a18ba6151c359e9ec30b3f9d83f8d463bcd4e79a71b091758c61727ca5b) |
| unwind | [`0x36b1c6f3…`](https://explorer.test.mezo.org/tx/0x36b1c6f33816f2d388e8055cc40091d60e6cf50d1ca7ce4723f64224bceba6cc) |

Shield and Guard were fired by the script after its 60 s wait: the always-on keeper's chain had stopped on a GitHub
`startup_failure` at 20:22 UTC and the 5-minute schedule had not restarted it. It was restarted by hand at 23:45 UTC.
Wallet: 0.0500 → 0.0475 BTC, 189 MUSD left (fees, pool gap and gas across 14 transactions).

## Outside wallets (12 Nov 2026)

### First outside wallet (02:04 Paris)

`0xA6108e8c84da72313E27C7Ab542D3d2e48fCD22e`, not a team wallet, used the live app through `#/try`:

| Step | Tx |
|---|---|
| Coil (with the 0.10% fee and the gauge share) | [`0x263eddff…`](https://explorer.test.mezo.org/tx/0x263eddff089608e8fea702087d52a357d571e0aea7723bee3e3b5458a5517997) |
| Arm Guard | [`0xbd0b5ddc…`](https://explorer.test.mezo.org/tx/0xbd0b5ddce29ef563dd24e118368ec653bbb1a7359baccd38bf518682a682d18b) |
| **Guard fired by the always-on keeper** (`0x09b6…e2a1`), 77 s after the coil | [`0x54aa8d19…`](https://explorer.test.mezo.org/tx/0x54aa8d1945236793e66fb4a372ef57320dc6407ce70c1f1a865d1368e26a5ee0) |
| Reserve deposit | [`0x2a9ea4cf…`](https://explorer.test.mezo.org/tx/0x2a9ea4cf621bf7414e96bb4fc2ca9da93b662fafbfbb19afc598d9e162fe502a) |
| Arm Recoil | [`0x262faee6…`](https://explorer.test.mezo.org/tx/0x262faee622a6ee2be130e8a42ffdbab752cfba64742c0ee57a38dd26c565d396) |
| Unwind | [`0x53f994b6…`](https://explorer.test.mezo.org/tx/0x53f994b63be0addeaf44869a0226c2ba8f53a1bf2767cce69184fe119613a297) |

### Second outside wallet (02:14 Paris)

`0xdd7449a2C4112B9f325d164886Dfd992CC508E9c`, not a team wallet:

| Step | Tx |
|---|---|
| Coil | [`0x071b2e3a…`](https://explorer.test.mezo.org/tx/0x071b2e3a751c710c0b174369754d3590b8e7e7602abac4760171b4c0462395df) |
| Arm Guard | [`0x48747797…`](https://explorer.test.mezo.org/tx/0x48747797fab68ddd3c5007da29b11e6f3713855b49bbf4c45860d0125af359bf) |
| Reserve deposit | [`0xd2b7b214…`](https://explorer.test.mezo.org/tx/0xd2b7b21420634720bebb5e0f255e153048cad801e20b9050f1ec3dcb74ebe980) |
| Arm Shield | [`0xb4ade53b…`](https://explorer.test.mezo.org/tx/0xb4ade53b00df069e229484089ad3a78099deab4b5e70315b04739edefae8fa2c) |
| Deleverage (by the user) | [`0xb70d622e…`](https://explorer.test.mezo.org/tx/0xb70d622eb478322dd1dfc10683772fe5d47eeeeb08fced8fc9b9a3d787d293fb) |
| Unwind | [`0xc5e93a1b…`](https://explorer.test.mezo.org/tx/0xc5e93a1bb0fdd72739fd2ba07d2cbfba2c9245ad838a4cb25e09b7d414f4f612) |

### Third outside wallet (10:41 Paris)

`0x056053003138F87A3ad010B5e79429baCC0070E2`, not a team wallet:

| Step | Tx |
|---|---|
| Coil | [`0x852b1570…`](https://explorer.test.mezo.org/tx/0x852b1570b71e086211929f9fa3396f5302da983db1465f2909b5b253f9f6a77b) |
| Arm Guard | [`0x7240567c…`](https://explorer.test.mezo.org/tx/0x7240567c2365a9ad8b54cee76c3c1fd7122486b3b2ce2a58011cae8cd2de1a27) |
| Reserve deposit | [`0x6792bd36…`](https://explorer.test.mezo.org/tx/0x6792bd36329bc4697f15f9d6d1c2a957e0ffc90451dff4b9398807509ce6f203) |
| Arm Shield | [`0x7e55c953…`](https://explorer.test.mezo.org/tx/0x7e55c95374f5e887ff70cbd17798b8eca7d7e4fb3a91b8b3d651bdd97bbc35a4) |
| Deleverage (by the user) | [`0x0c859e31…`](https://explorer.test.mezo.org/tx/0x0c859e3168e7755ad51eb1ef005ee7facdd8341b27bdc78b3c44a4420398e9dc) |
