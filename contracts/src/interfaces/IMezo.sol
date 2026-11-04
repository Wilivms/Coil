// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Minimal interfaces for the Mezo contracts Coil talks to.
/// Sources: github.com/mezo-org/musd (solidity/contracts) and github.com/mezo-org/tigris (Pool.sol).

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// Aerodrome-style basic pool used by Mezo Pools (MUSD/BTC volatile pool).
interface IMezoPool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function stable() external view returns (bool);
    function factory() external view returns (address);
    function getReserves() external view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast);
    /// Optimistically sends tokens to `to`, calls `IPoolCallee(to).hook(...)` when `data` is non-empty,
    /// then checks the constant-product invariant (after fees).
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

interface IMezoPoolFactory {
    /// Fee in basis points over 10_000 (30 = 0.30%).
    function getFee(address pool, bool stable) external view returns (uint256);
}

interface IPoolCallee {
    function hook(address sender, uint256 amount0, uint256 amount1, bytes calldata data) external;
}

/// MUSD's EIP-712 entry point: lets a third party act on a trove the borrower signed for.
interface IBorrowerOperationsSignatures {
    function openTroveWithSignature(
        uint256 debtAmount,
        address upperHint,
        address lowerHint,
        address borrower,
        address recipient,
        bytes memory signature,
        uint256 deadline
    ) external payable;

    function closeTroveWithSignature(address borrower, address recipient, bytes memory signature, uint256 deadline)
        external;

    function adjustTroveWithSignature(
        uint256 collWithdrawal,
        uint256 debtChange,
        bool isDebtIncrease,
        address upperHint,
        address lowerHint,
        address borrower,
        address recipient,
        bytes memory signature,
        uint256 deadline
    ) external payable;

    function repayMUSDWithSignature(
        uint256 amount,
        address upperHint,
        address lowerHint,
        address borrower,
        bytes memory signature,
        uint256 deadline
    ) external;

    /// Re-prices the trove at the current global rate and resets its borrowing capacity to
    /// coll * price / 110% (MUSD only lowers that capacity otherwise). Charges MUSD's refinancing fee.
    function refinanceWithSignature(
        address upperHint,
        address lowerHint,
        address borrower,
        bytes memory signature,
        uint256 deadline
    ) external;

    function getNonce(address user) external view returns (uint256);
}

/// Mezo Pools incentive (bribe) contract of a gauge: rewards veBTC voters for that pool.
interface IReward {
    function notifyRewardAmount(address token, uint256 amount) external;
}

/// MUSD's redemption queue: sorted by nominal ICR (principal only), highest first.
/// Redemptions start at `getLast()` and walk towards `getFirst()` with `getPrev`.
interface ISortedTroves {
    function getLast() external view returns (address);
    function getPrev(address id) external view returns (address);
    function contains(address id) external view returns (bool);
}

/// Mezo's MUSD savings vault (sMUSD). Not ERC-4626: shares are 1:1 with MUSD and yield is paid
/// separately in MUSD through `claimYield`. Testnet 0x6f461c68…7e16, mainnet 0xb4D498…51CC.
interface IMUSDSavingsRate {
    function deposit(uint256 amount) external;
    function withdraw(uint256 amount) external;
    function claimYield() external returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function musdToken() external view returns (address);
}

interface IERC20Approve {
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface ITroveManager {
    function getEntireDebtAndColl(address borrower)
        external
        view
        returns (
            uint256 coll,
            uint256 principal,
            uint256 interest,
            uint256 pendingCollateral,
            uint256 pendingPrincipal,
            uint256 pendingInterest
        );

    /// 0 nonExistent, 1 active, 2 closedByOwner, 3 closedByLiquidation, 4 closedByRedemption
    function getTroveStatus(address borrower) external view returns (uint256);

    function getCurrentICR(address borrower, uint256 price) external view returns (uint256);

    function checkRecoveryMode(uint256 price) external view returns (bool);

    /// MUSD caps a trove's debt at coll * price / 110% measured at open (or last refinance);
    /// adding collateral does not raise it.
    function getTroveMaxBorrowingCapacity(address borrower) external view returns (uint256);
}

interface IPriceFeed {
    /// BTC/USD with 18 decimals, the same price MUSD uses for liquidations.
    function fetchPrice() external view returns (uint256);
}
