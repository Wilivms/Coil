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

    function getNonce(address user) external view returns (uint256);
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
}

interface IPriceFeed {
    /// BTC/USD with 18 decimals, the same price MUSD uses for liquidations.
    function fetchPrice() external view returns (uint256);
}
