// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {CoilRouter} from "./CoilRouter.sol";
import {ITroveManager, ISortedTroves, IBorrowerOperationsSignatures} from "./interfaces/IMezo.sol";

/// @title CoilLens
/// @notice Read-only status views for CoilRouter (kept out of the router to stay under EIP-170).
///         The app and the keeper read these; the router itself re-checks every condition when a
///         Guard, Shield or Recoil is fired, so nothing here is trusted on-chain.
contract CoilLens {
    CoilRouter public immutable router;
    ITroveManager public immutable troveManager;
    ISortedTroves public immutable sortedTroves;
    IBorrowerOperationsSignatures public immutable bos;

    constructor(CoilRouter _router) {
        router = _router;
        troveManager = _router.troveManager();
        sortedTroves = _router.sortedTroves();
        bos = _router.bos();
    }

    function _price() internal view returns (uint256) {
        return router.priceFeed().fetchPrice();
    }

    /// @return armed        a Guard is stored for `user`
    /// @return fresh        its signature still matches the user's MUSD nonce and deadline
    /// @return triggered    MUSD's price feed is at or below the trigger
    /// @return recoveryMode MUSD is in Recovery Mode: a Guard can't withdraw collateral, a Shield still repays
    function guardStatus(address user)
        external
        view
        returns (bool armed, bool fresh, bool triggered, bool recoveryMode)
    {
        uint256 price = _price();
        recoveryMode = troveManager.checkRecoveryMode(price);
        CoilRouter.Guard memory g = router.guardOf(user);
        armed = g.signature.length != 0;
        if (!armed) return (false, false, false, recoveryMode);
        fresh = g.nonce == bos.getNonce(user) && block.timestamp <= g.deadline;
        triggered = price <= g.triggerPrice;
    }

    /// @return armed   a Shield is stored for `user`
    /// @return fresh   its signature still matches the MUSD nonce and deadline
    /// @return funded  the Reserve covers the repayment and the bounty
    /// @return byPrice the price trigger is met
    /// @return byQueue the redemption trigger is met (proved within `maxSteps`)
    /// @return ahead   redeemable MUSD ahead of the trove (lower bound if not found)
    function shieldStatus(address user, uint256 maxSteps)
        external
        view
        returns (bool armed, bool fresh, bool funded, bool byPrice, bool byQueue, uint256 ahead)
    {
        CoilRouter.Shield memory s = router.shieldOf(user);
        armed = s.signature.length != 0;
        if (!armed) return (false, false, false, false, false, 0);
        fresh = s.nonce == bos.getNonce(user) && block.timestamp <= s.deadline;
        funded = router.reserveBalance(user) >= uint256(s.repayAmount) + s.bountyMusd;
        uint256 price = _price();
        byPrice = s.triggerPrice != 0 && price <= s.triggerPrice;
        if (s.maxDebtAhead != 0) {
            bool found;
            (ahead, found) = _debtAhead(user, maxSteps, price);
            byQueue = found && ahead <= s.maxDebtAhead;
        }
    }

    /// @return armed     a Recoil is stored for `user`
    /// @return fresh     its signatures still match the MUSD nonce and deadline
    /// @return triggered the trove's ICR is at or above the trigger
    /// @return icr       the trove's current ICR
    /// @return capacity  MUSD the trove may still borrow under MUSD's borrowing capacity
    function recoilStatus(address user)
        external
        view
        returns (bool armed, bool fresh, bool triggered, uint256 icr, uint256 capacity)
    {
        icr = troveManager.getCurrentICR(user, _price());
        (, uint256 principal, uint256 interest,,,) = troveManager.getEntireDebtAndColl(user);
        uint256 cap = troveManager.getTroveMaxBorrowingCapacity(user);
        capacity = cap > principal + interest ? cap - principal - interest : 0;
        CoilRouter.Recoil memory r = router.recoilOf(user);
        armed = r.signature.length != 0;
        if (!armed) return (false, false, false, icr, capacity);
        fresh = r.nonce == bos.getNonce(user) && block.timestamp <= r.deadline;
        triggered = icr >= r.triggerIcr;
    }

    /// @notice MUSD of debt that redemptions would take before reaching `user`'s trove.
    function debtAhead(address user, uint256 maxSteps) external view returns (uint256 ahead, bool found) {
        return _debtAhead(user, maxSteps, _price());
    }

    /// Same walk as CoilRouter._debtAhead: from the queue's tail, skipping troves under MCR.
    function _debtAhead(address user, uint256 maxSteps, uint256 price)
        internal
        view
        returns (uint256 ahead, bool found)
    {
        uint256 cap = router.MAX_QUEUE_STEPS();
        if (maxSteps > cap) maxSteps = cap;
        uint256 mcr = router.MCR();
        uint256 gasComp = router.GAS_COMPENSATION();
        address cur = sortedTroves.getLast();
        for (uint256 i; i < maxSteps && cur != address(0); ++i) {
            if (cur == user) return (ahead, true);
            if (troveManager.getCurrentICR(cur, price) >= mcr) {
                (, uint256 principal, uint256 interest,,,) = troveManager.getEntireDebtAndColl(cur);
                uint256 debt = principal + interest;
                if (debt > gasComp) ahead += debt - gasComp;
            }
            cur = sortedTroves.getPrev(cur);
        }
        return (ahead, cur == user);
    }

    /// Reserves as (MUSD, BTC) and the pool fee in bps.
    function poolState() external view returns (uint256 reserveMusd, uint256 reserveBtc, uint256 feeBps_) {
        (uint256 r0, uint256 r1,) = router.pool().getReserves();
        (reserveMusd, reserveBtc) = router.musdIsToken0() ? (r0, r1) : (r1, r0);
        feeBps_ = router.poolFactory().getFee(address(router.pool()), false);
    }
}
