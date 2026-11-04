// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {
    IERC20Min,
    IERC20Approve,
    IMezoPool,
    IMezoPoolFactory,
    IPoolCallee,
    IBorrowerOperationsSignatures,
    ITroveManager,
    IPriceFeed,
    ISortedTroves,
    IMUSDSavingsRate,
    IReward
} from "./interfaces/IMezo.sol";

/// @title CoilRouter v3
/// @notice Leveraged BTC on Mezo in one transaction, without ever taking custody of the trove,
///         plus two protections that keep the position alive: Guard and Shield.
///
///         Coil (open):   flash-swap BTC out of the MUSD/BTC pool -> open the user's trove with
///                        deposit + flashed BTC via `openTroveWithSignature` -> pay the pool back
///                        with the MUSD the trove just minted. Leftover MUSD goes to the user.
///         Unwind:        flash-swap MUSD -> `closeTroveWithSignature` repays the debt and sends the
///                        collateral here -> pay the pool in BTC -> send the rest to the user.
///         Deleverage:    same as unwind but partial, through `adjustTroveWithSignature`.
///         Guard:         a pre-signed deleverage plus a trigger price and a minimum BTC out. Anyone can
///                        execute it once MUSD's own price feed is at or below the trigger.
///                        Works for any Mezo trove, opened with Coil or not.
///         Reserve:       MUSD the user parks in Mezo's sMUSD vault through Coil. It earns the sMUSD
///                        yield while it waits, and only two things can move it: its owner, or the
///                        owner's signed Shield repaying the owner's own trove.
///         Relever:       the reverse of deleverage: flash BTC in, borrow more MUSD against it.
///         Recoil:        a pre-signed relever a keeper runs once the trove's ratio is back above a
///                        trigger (BTC went up, or a redemption shrank the debt): the position goes
///                        back to its target leverage on its own.
///         Incentives:    a capped share of each coil's MUSD goes to the MUSD/BTC pool's gauge
///                        incentives, so the pool Coil trades against gets deeper.
///         Shield:        a pre-signed `repayMUSD` funded by the Reserve. It fires when the price falls
///                        to a trigger, or when the trove is about to be redeemed: less than
///                        `maxDebtAhead` MUSD of debt stands before it in the redemption queue. It only
///                        repays debt, so it also works in Recovery Mode, where collateral can't leave.
///
/// @dev    Every swap is bounded by MUSD's own PriceFeed (`maxDeviationBps`), on top of the user's
///         signed limits, so a keeper or a sandwich can never move the pool and take the difference.
///         Mezo specifics this contract relies on:
///         - BTC is the native coin AND an ERC-20 precompile (0x7b7c…0000) over the same balance, so
///           BTC received from the pool can be forwarded as `msg.value`, and BTC is paid to the pool
///           with an ERC-20 `transfer`.
///         - The trove always belongs to the signer (`borrower`); Coil is only the `recipient` of
///           the MUSD / collateral that it needs to settle the flash swap within the same tx.
///         - BTC arriving by native call (collateral from MUSD's ActivePool) is only accepted while a
///           flow is running, so a signature used directly against MUSD cannot strand funds here.
///         - No forwarder, no meta-transactions, no upgradability, no admin path to user funds.
contract CoilRouter is IPoolCallee {
    // ---------------------------------------------------------------- constants

    uint8 private constant IDLE = 1;
    uint8 private constant OPEN = 2;
    uint8 private constant CLOSE = 3;
    uint8 private constant DELEVER = 4;
    uint8 private constant RESERVE = 5;
    uint8 private constant RELEVER = 6;

    /// MUSD gas compensation held in the GasPool for every trove (LiquityBase.MUSD_GAS_COMPENSATION).
    uint256 public constant GAS_COMPENSATION = 200e18;
    /// MUSD's minimum collateral ratio; troves under it are skipped by redemptions.
    uint256 public constant MCR = 1.1e18;
    /// Extra MUSD flashed on close to absorb interest rounding; refunded to the user.
    uint256 public constant CLOSE_BUFFER = 1e15;
    uint256 public constant MAX_FEE_BPS = 50; // 0.50% cap on the protocol fee
    uint256 public constant MAX_BOUNTY_BPS = 200; // 2.00% cap on a Guard keeper bounty
    uint256 public constant MAX_SHIELD_BOUNTY = 25e18; // 25 MUSD cap on a Shield keeper bounty
    uint256 public constant MAX_INCENTIVE_BPS = 20; // 0.20% of a coil's debt to gauge incentives, at most
    /// Hard cap on how far a swap may price away from MUSD's PriceFeed (5%).
    uint256 public constant MAX_DEVIATION_BPS = 500;
    /// Upper bound on the redemption-queue walk done by `fireShield` and `debtAhead`.
    uint256 public constant MAX_QUEUE_STEPS = 200;

    // ---------------------------------------------------------------- immutables

    IBorrowerOperationsSignatures public immutable bos;
    ITroveManager public immutable troveManager;
    IPriceFeed public immutable priceFeed;
    ISortedTroves public immutable sortedTroves;
    IMUSDSavingsRate public immutable savings;
    IMezoPool public immutable pool;
    IMezoPoolFactory public immutable poolFactory;
    address public immutable musd;
    address public immutable btc;
    bool public immutable musdIsToken0;

    // ---------------------------------------------------------------- storage

    address public owner;
    address public treasury;
    uint16 public feeBps;
    /// How far (bps) the MUSD paid or received in a swap may differ from the PriceFeed value.
    /// MUSD has traded around $0.98-0.99, so a zero tolerance would block every coil.
    uint16 public maxDeviationBps = 300;

    uint8 private _flow = IDLE;

    /// Share (bps of the debt) of each coil's MUSD sent to the pool's gauge incentives.
    uint16 public incentiveBps;
    /// Mezo Pools incentive contract of the MUSD/BTC gauge.
    address public incentiveTarget;
    /// MUSD collected for incentives, waiting for `pushIncentives`.
    uint256 public pendingIncentives;

    struct Guard {
        uint128 triggerPrice; // BTC/USD, 18 decimals
        uint128 collWithdrawal; // BTC the signed adjustment withdraws
        uint128 debtRepay; // MUSD the signed adjustment repays
        uint128 minBtcOut; // BTC the user must receive, bounty included
        uint64 deadline; // signature deadline
        uint16 bountyBps; // share of the released BTC paid to the keeper
        uint64 nonce; // MUSD signature nonce the signature was made for (staleness check)
        bytes signature; // EIP-712 AdjustTrove signature, recipient = this contract
    }

    struct Shield {
        uint128 repayAmount; // MUSD the signed RepayMUSD repays from the Reserve
        uint128 triggerPrice; // fire at or below this BTC/USD price (0 = off)
        uint128 maxDebtAhead; // fire when at most this much MUSD is ahead in the redemption queue (0 = off)
        uint128 bountyMusd; // MUSD paid to the keeper from the Reserve
        uint64 deadline;
        uint64 nonce;
        bytes signature; // EIP-712 RepayMUSD signature
    }

    struct Recoil {
        uint128 triggerIcr; // fire once the trove's ICR is at or above this (18 decimals)
        uint128 addColl; // BTC flashed in as collateral, signed as `assetAmount`
        uint128 debtIncrease; // MUSD borrowed, signed
        uint64 deadline;
        uint16 bountyBps; // share of `debtIncrease` paid to the keeper in MUSD
        uint64 nonce;
        bytes signature; // AdjustTrove(0, debtIncrease, true, addColl, borrower, recipient = this)
        bytes refinanceSig; // optional Refinance signed one nonce earlier, to reset borrowing capacity
    }

    mapping(address => Guard) private _guards;
    mapping(address => Recoil) private _recoils;
    mapping(address => Shield) private _shields;

    /// MUSD each user holds in the Reserve, yield already settled into it.
    mapping(address => uint256) public reserveOf;
    mapping(address => uint256) private _yieldDebt;
    uint256 public totalReserve;
    /// sMUSD yield per Reserve MUSD, scaled by 1e18.
    uint256 public accYieldPerShare;

    // ---------------------------------------------------------------- events

    event Coiled(
        address indexed user,
        uint256 deposit,
        uint256 totalColl,
        uint256 debtAmount,
        uint256 flashBtc,
        uint256 musdPaidToPool,
        uint256 musdRefund
    );
    event Unwound(address indexed user, uint256 musdRepaid, uint256 btcOut);
    event Delevered(address indexed user, uint256 collWithdrawn, uint256 debtRepaid, uint256 btcOut);
    event GuardArmed(
        address indexed user,
        uint256 triggerPrice,
        uint256 collWithdrawal,
        uint256 debtRepay,
        uint256 minBtcOut,
        uint256 bountyBps,
        uint256 deadline
    );
    event GuardDisarmed(address indexed user);
    event GuardFired(
        address indexed user, address indexed keeper, uint256 price, uint256 btcToUser, uint256 bounty
    );
    event ReserveDeposited(address indexed user, uint256 amount);
    event ReserveWithdrawn(address indexed user, uint256 amount);
    event YieldHarvested(uint256 amount);
    event ShieldArmed(
        address indexed user,
        uint256 repayAmount,
        uint256 triggerPrice,
        uint256 maxDebtAhead,
        uint256 bountyMusd,
        uint256 deadline
    );
    event ShieldDisarmed(address indexed user);
    event ShieldFired(
        address indexed user,
        address indexed keeper,
        bool byRedemptionQueue,
        uint256 price,
        uint256 repaid,
        uint256 bounty
    );
    event Relevered(address indexed user, uint256 collAdded, uint256 debtAdded, uint256 musdOut);
    event RecoilArmed(
        address indexed user, uint256 triggerIcr, uint256 addColl, uint256 debtIncrease, uint256 bountyBps, uint256 deadline
    );
    event RecoilDisarmed(address indexed user);
    event RecoilFired(address indexed user, address indexed keeper, uint256 icr, uint256 musdToUser, uint256 bounty);
    event IncentivesAccrued(address indexed user, uint256 amount);
    event IncentivesPushed(address indexed target, uint256 amount);
    event IncentivesChanged(address target, uint256 bps);
    event FeeChanged(uint256 feeBps);
    event MaxDeviationChanged(uint256 maxDeviationBps);
    event TreasuryChanged(address treasury);
    event OwnerChanged(address owner);

    // ---------------------------------------------------------------- errors

    error Busy();
    error Unauthorized();
    error BadPool();
    error NothingToFlash();
    error DebtTooSmall(uint256 debtAmount, uint256 musdOwed);
    error InsufficientLiquidity();
    error NoDebt();
    error CollateralShort(uint256 btcAvailable, uint256 btcOwed);
    error Slippage(uint256 btcOut, uint256 minBtcOut);
    error PriceDeviation(uint256 paidUsd, uint256 fairUsd);
    error NoGuard();
    error NoShield();
    error GuardExpired();
    error NotTriggered(uint256 price, uint256 triggerPrice);
    error ReserveShort(uint256 available, uint256 needed);
    error BadParam();
    error UnexpectedBtc();
    error TransferFailed();

    // ---------------------------------------------------------------- setup

    constructor(
        address _bos,
        address _troveManager,
        address _priceFeed,
        address _sortedTroves,
        address _savings,
        address _pool,
        address _musd,
        address _btc,
        address _treasury
    ) {
        if (IMezoPool(_pool).stable()) revert BadPool();
        address t0 = IMezoPool(_pool).token0();
        address t1 = IMezoPool(_pool).token1();
        bool m0;
        if (t0 == _musd && t1 == _btc) m0 = true;
        else if (!(t0 == _btc && t1 == _musd)) revert BadPool();
        if (IMUSDSavingsRate(_savings).musdToken() != _musd) revert BadParam();

        bos = IBorrowerOperationsSignatures(_bos);
        troveManager = ITroveManager(_troveManager);
        priceFeed = IPriceFeed(_priceFeed);
        sortedTroves = ISortedTroves(_sortedTroves);
        savings = IMUSDSavingsRate(_savings);
        pool = IMezoPool(_pool);
        poolFactory = IMezoPoolFactory(IMezoPool(_pool).factory());
        musd = _musd;
        btc = _btc;
        musdIsToken0 = m0;
        owner = msg.sender;
        treasury = _treasury;
        IERC20Approve(_musd).approve(_savings, type(uint256).max);
    }

    modifier lock(uint8 flow) {
        if (_flow != IDLE) revert Busy();
        _flow = flow;
        _;
        _flow = IDLE;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    /// Collateral released by MUSD arrives here by native call. Accept it only mid-flow.
    receive() external payable {
        if (_flow == IDLE || _flow == RESERVE || _flow == RELEVER) revert UnexpectedBtc();
    }

    // ---------------------------------------------------------------- coil (open)

    /// @notice Open a leveraged trove in one transaction.
    /// @param totalColl   Collateral of the new trove (deposit after fee + flashed BTC). Signed as `assetAmount`.
    /// @param debtAmount  MUSD the trove mints to this contract. Must cover the pool repayment; the rest is refunded.
    /// @param signature   EIP-712 `OpenTrove(totalColl, debtAmount, borrower=msg.sender, recipient=this, nonce, deadline)`
    ///                    for MUSD's BorrowerOperationsSignatures.
    function coil(
        uint256 totalColl,
        uint256 debtAmount,
        address upperHint,
        address lowerHint,
        bytes calldata signature,
        uint256 deadline
    ) external payable lock(OPEN) returns (uint256 musdRefund) {
        uint256 fee = (msg.value * feeBps) / 10_000;
        uint256 deposit = msg.value - fee;
        if (totalColl <= deposit) revert NothingToFlash();
        uint256 flashBtc = totalColl - deposit;

        uint256 musdBefore = IERC20Min(musd).balanceOf(address(this));
        bytes memory inner =
            abi.encode(msg.sender, totalColl, debtAmount, upperHint, lowerHint, deadline, signature);
        _flash(false, flashBtc, abi.encode(OPEN, inner));

        uint256 musdAfter = IERC20Min(musd).balanceOf(address(this));
        musdRefund = musdAfter - musdBefore;
        uint256 incentive = (debtAmount * incentiveBps) / 10_000;
        if (incentive > musdRefund) incentive = musdRefund;
        if (incentive > 0) {
            pendingIncentives += incentive;
            musdRefund -= incentive;
            emit IncentivesAccrued(msg.sender, incentive);
        }
        if (musdRefund > 0) _sendToken(musd, msg.sender, musdRefund);
        if (fee > 0) _sendBtc(treasury, fee);

        emit Coiled(
            msg.sender, deposit, totalColl, debtAmount, flashBtc, debtAmount - musdRefund - incentive, musdRefund
        );
    }

    // ---------------------------------------------------------------- relever (leverage up)

    /// @notice Add `addColl` BTC (flash-swapped from the pool) and borrow `debtIncrease` MUSD to pay
    ///         for it, in one transaction. The MUSD left after paying the pool is sent to you.
    /// @param signature    EIP-712 `AdjustTrove(0, debtIncrease, true, addColl, borrower=msg.sender, recipient=this, nonce, deadline)`.
    /// @param refinanceSig Optional `Refinance(borrower, interestRate, nonce, deadline)` signed one nonce
    ///                     BEFORE `signature`: MUSD's borrowing capacity only resets on refinance.
    function relever(
        uint256 addColl,
        uint256 debtIncrease,
        address upperHint,
        address lowerHint,
        bytes calldata signature,
        bytes calldata refinanceSig,
        uint256 deadline,
        uint256 minMusdOut
    ) external lock(RELEVER) returns (uint256 musdOut) {
        musdOut = _relever(msg.sender, addColl, debtIncrease, upperHint, lowerHint, signature, refinanceSig, deadline);
        if (musdOut < minMusdOut) revert Slippage(musdOut, minMusdOut);
        if (musdOut > 0) _sendToken(musd, msg.sender, musdOut);
        emit Relevered(msg.sender, addColl, debtIncrease, musdOut);
    }

    // ---------------------------------------------------------------- recoil (signed re-leverage)

    /// @notice Store a pre-signed relever that a keeper may run once the trove's ratio is at or
    ///         above `triggerIcr`: after BTC rises, or after a redemption shrank the debt.
    function armRecoil(
        uint128 triggerIcr,
        uint128 addColl,
        uint128 debtIncrease,
        uint16 bountyBps,
        uint64 deadline,
        bytes calldata signature,
        bytes calldata refinanceSig
    ) external {
        if (bountyBps > MAX_BOUNTY_BPS || deadline <= block.timestamp || triggerIcr < MCR) revert BadParam();
        if (addColl == 0 || debtIncrease == 0 || signature.length == 0) revert BadParam();
        _recoils[msg.sender] = Recoil({
            triggerIcr: triggerIcr,
            addColl: addColl,
            debtIncrease: debtIncrease,
            deadline: deadline,
            bountyBps: bountyBps,
            nonce: uint64(bos.getNonce(msg.sender)),
            signature: signature,
            refinanceSig: refinanceSig
        });
        emit RecoilArmed(msg.sender, triggerIcr, addColl, debtIncrease, bountyBps, deadline);
    }

    function disarmRecoil() external {
        delete _recoils[msg.sender];
        emit RecoilDisarmed(msg.sender);
    }

    /// @notice Execute `user`'s Recoil. Pays the caller `bountyBps` of the MUSD borrowed.
    function fireRecoil(address user, address upperHint, address lowerHint)
        external
        lock(RELEVER)
        returns (uint256 bounty)
    {
        Recoil memory r = _recoils[user];
        if (r.signature.length == 0) revert NoGuard();
        if (block.timestamp > r.deadline) revert GuardExpired();
        uint256 icr = troveManager.getCurrentICR(user, priceFeed.fetchPrice());
        if (icr < r.triggerIcr) revert NotTriggered(icr, r.triggerIcr);
        delete _recoils[user];

        uint256 musdOut =
            _relever(user, r.addColl, r.debtIncrease, upperHint, lowerHint, r.signature, r.refinanceSig, r.deadline);
        bounty = (uint256(r.debtIncrease) * r.bountyBps) / 10_000;
        if (bounty > musdOut) revert Slippage(musdOut, bounty);
        if (bounty > 0) _sendToken(musd, msg.sender, bounty);
        if (musdOut > bounty) _sendToken(musd, user, musdOut - bounty);

        emit Relevered(user, r.addColl, r.debtIncrease, musdOut);
        emit RecoilFired(user, msg.sender, icr, musdOut - bounty, bounty);
    }

    // ---------------------------------------------------------------- gauge incentives

    /// @notice Send the collected MUSD to the MUSD/BTC gauge's incentives. Anyone can call.
    function pushIncentives() external lock(RESERVE) returns (uint256 amount) {
        amount = pendingIncentives;
        address target = incentiveTarget;
        if (amount == 0 || target == address(0)) return 0;
        pendingIncentives = 0;
        IERC20Approve(musd).approve(target, amount);
        IReward(target).notifyRewardAmount(musd, amount);
        emit IncentivesPushed(target, amount);
    }

    // ---------------------------------------------------------------- unwind (close)

    /// @notice Close the caller's whole trove in one transaction and receive the net BTC.
    /// @param signature EIP-712 `CloseTrove(borrower=msg.sender, recipient=this, nonce, deadline)`.
    function unwind(bytes calldata signature, uint256 deadline, uint256 minBtcOut)
        external
        lock(CLOSE)
        returns (uint256 btcOut)
    {
        uint256 musdOwed = closeAmount(msg.sender);
        uint256 btcBefore = address(this).balance;
        uint256 musdBefore = IERC20Min(musd).balanceOf(address(this));

        _flash(true, musdOwed, abi.encode(CLOSE, abi.encode(msg.sender, deadline, signature)));

        btcOut = address(this).balance - btcBefore;
        if (btcOut < minBtcOut) revert Slippage(btcOut, minBtcOut);
        // The flash is fully burned by MUSD except the rounding buffer, which goes back to the user.
        uint256 musdLeft = IERC20Min(musd).balanceOf(address(this)) - musdBefore;
        if (musdLeft > 0) _sendToken(musd, msg.sender, musdLeft);
        _sendBtc(msg.sender, btcOut);

        emit Unwound(msg.sender, musdOwed - musdLeft, btcOut);
    }

    // ---------------------------------------------------------------- deleverage (partial)

    /// @notice Repay `debtRepay` MUSD and withdraw `collWithdrawal` BTC in one transaction,
    ///         funding the repayment with a flash swap. The BTC left after paying the pool is sent to you.
    /// @param signature EIP-712 `AdjustTrove(collWithdrawal, debtRepay, false, 0, borrower=msg.sender, recipient=this, nonce, deadline)`.
    function deleverage(
        uint256 collWithdrawal,
        uint256 debtRepay,
        address upperHint,
        address lowerHint,
        bytes calldata signature,
        uint256 deadline,
        uint256 minBtcOut
    ) external lock(DELEVER) returns (uint256 btcOut) {
        btcOut = _delever(msg.sender, collWithdrawal, debtRepay, upperHint, lowerHint, signature, deadline);
        if (btcOut < minBtcOut) revert Slippage(btcOut, minBtcOut);
        _sendBtc(msg.sender, btcOut);
        emit Delevered(msg.sender, collWithdrawal, debtRepay, btcOut);
    }

    // ---------------------------------------------------------------- guard (signed stop-loss)

    /// @notice Store a pre-signed deleverage that anyone may execute once BTC/USD <= `triggerPrice`.
    ///         Works for any trove the caller owns, whether or not it was opened with Coil.
    /// @param minBtcOut BTC the deleverage must release (before the keeper bounty), or the Guard reverts.
    /// @dev    The signature only authorises one exact adjustment with this contract as recipient.
    ///         Any other signed trove operation by the user bumps the MUSD nonce and makes it stale.
    function armGuard(
        uint128 triggerPrice,
        uint128 collWithdrawal,
        uint128 debtRepay,
        uint128 minBtcOut,
        uint16 bountyBps,
        uint64 deadline,
        bytes calldata signature
    ) external {
        if (bountyBps > MAX_BOUNTY_BPS || deadline <= block.timestamp || triggerPrice == 0) revert BadParam();
        if (collWithdrawal == 0 || debtRepay == 0 || minBtcOut == 0 || signature.length == 0) revert BadParam();
        _guards[msg.sender] = Guard({
            triggerPrice: triggerPrice,
            collWithdrawal: collWithdrawal,
            debtRepay: debtRepay,
            minBtcOut: minBtcOut,
            deadline: deadline,
            bountyBps: bountyBps,
            nonce: uint64(bos.getNonce(msg.sender)),
            signature: signature
        });
        emit GuardArmed(msg.sender, triggerPrice, collWithdrawal, debtRepay, minBtcOut, bountyBps, deadline);
    }

    function disarmGuard() external {
        delete _guards[msg.sender];
        emit GuardDisarmed(msg.sender);
    }

    /// @notice Execute `user`'s Guard. Pays the caller `bountyBps` of the BTC released.
    /// @dev    The swap inside is bounded by the PriceFeed, and the result by the user's `minBtcOut`.
    function fireGuard(address user, address upperHint, address lowerHint)
        external
        lock(DELEVER)
        returns (uint256 bounty)
    {
        Guard memory g = _guards[user];
        if (g.signature.length == 0) revert NoGuard();
        if (block.timestamp > g.deadline) revert GuardExpired();
        uint256 price = priceFeed.fetchPrice();
        if (price > g.triggerPrice) revert NotTriggered(price, g.triggerPrice);
        delete _guards[user];

        uint256 btcOut =
            _delever(user, g.collWithdrawal, g.debtRepay, upperHint, lowerHint, g.signature, g.deadline);
        if (btcOut < g.minBtcOut) revert Slippage(btcOut, g.minBtcOut);
        bounty = (btcOut * g.bountyBps) / 10_000;
        if (bounty > 0) _sendBtc(msg.sender, bounty);
        _sendBtc(user, btcOut - bounty);

        emit Delevered(user, g.collWithdrawal, g.debtRepay, btcOut);
        emit GuardFired(user, msg.sender, price, btcOut - bounty, bounty);
    }

    // ---------------------------------------------------------------- reserve (MUSD in sMUSD)

    /// @notice Park MUSD in the Reserve. It goes straight into Mezo's sMUSD vault and earns its yield.
    function depositReserve(uint256 amount) external lock(RESERVE) {
        if (amount == 0) revert BadParam();
        _harvest();
        _settle(msg.sender);
        if (!IERC20Approve(musd).transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        savings.deposit(amount);
        reserveOf[msg.sender] += amount;
        totalReserve += amount;
        _yieldDebt[msg.sender] = (reserveOf[msg.sender] * accYieldPerShare) / 1e18;
        emit ReserveDeposited(msg.sender, amount);
    }

    /// @notice Take MUSD back out of the Reserve, yield included. Only the owner of the Reserve can.
    function withdrawReserve(uint256 amount) external lock(RESERVE) {
        _harvest();
        _settle(msg.sender);
        if (amount == type(uint256).max) amount = reserveOf[msg.sender];
        if (amount == 0 || amount > reserveOf[msg.sender]) revert ReserveShort(reserveOf[msg.sender], amount);
        _takeFromReserve(msg.sender, amount);
        _sendToken(musd, msg.sender, amount);
        emit ReserveWithdrawn(msg.sender, amount);
    }

    /// @notice Pull the yield sMUSD owes the Reserve and credit it to depositors. Anyone can call.
    function harvest() external lock(RESERVE) {
        _harvest();
    }

    // ---------------------------------------------------------------- shield (reserve-funded repay)

    /// @notice Store a pre-signed `RepayMUSD` that a keeper may execute from the caller's Reserve.
    /// @param repayAmount  MUSD repaid, exactly the amount signed.
    /// @param triggerPrice Fire at or below this BTC/USD price (0 disables the price trigger).
    /// @param maxDebtAhead Fire when at most this much MUSD is ahead of the trove in the redemption
    ///                     queue (0 disables the redemption trigger).
    /// @param bountyMusd   MUSD paid to the keeper from the Reserve, at most `MAX_SHIELD_BOUNTY`.
    /// @param signature    EIP-712 `RepayMUSD(repayAmount, borrower=msg.sender, nonce, deadline)`.
    function armShield(
        uint128 repayAmount,
        uint128 triggerPrice,
        uint128 maxDebtAhead,
        uint128 bountyMusd,
        uint64 deadline,
        bytes calldata signature
    ) external {
        if (repayAmount == 0 || signature.length == 0 || deadline <= block.timestamp) revert BadParam();
        if (triggerPrice == 0 && maxDebtAhead == 0) revert BadParam();
        if (bountyMusd > MAX_SHIELD_BOUNTY) revert BadParam();
        _shields[msg.sender] = Shield({
            repayAmount: repayAmount,
            triggerPrice: triggerPrice,
            maxDebtAhead: maxDebtAhead,
            bountyMusd: bountyMusd,
            deadline: deadline,
            nonce: uint64(bos.getNonce(msg.sender)),
            signature: signature
        });
        emit ShieldArmed(msg.sender, repayAmount, triggerPrice, maxDebtAhead, bountyMusd, deadline);
    }

    function disarmShield() external {
        delete _shields[msg.sender];
        emit ShieldDisarmed(msg.sender);
    }

    /// @notice Execute `user`'s Shield: repay their trove from their Reserve.
    /// @param maxSteps How far to walk the redemption queue to prove the redemption trigger.
    function fireShield(address user, address upperHint, address lowerHint, uint256 maxSteps)
        external
        lock(RESERVE)
        returns (uint256 bounty)
    {
        Shield memory s = _shields[user];
        if (s.signature.length == 0) revert NoShield();
        if (block.timestamp > s.deadline) revert GuardExpired();
        uint256 price = priceFeed.fetchPrice();
        bool byPrice = s.triggerPrice != 0 && price <= s.triggerPrice;
        bool byQueue;
        if (!byPrice && s.maxDebtAhead != 0) {
            (uint256 ahead, bool found) = _debtAhead(user, s.maxDebtAhead, maxSteps, price);
            byQueue = found && ahead <= s.maxDebtAhead;
        }
        if (!byPrice && !byQueue) revert NotTriggered(price, s.triggerPrice);
        delete _shields[user];

        _harvest();
        _settle(user);
        bounty = s.bountyMusd;
        uint256 needed = uint256(s.repayAmount) + bounty;
        if (reserveOf[user] < needed) revert ReserveShort(reserveOf[user], needed);
        _takeFromReserve(user, needed);

        // MUSD burns the repayment from the caller (this contract).
        bos.repayMUSDWithSignature(s.repayAmount, upperHint, lowerHint, user, s.signature, s.deadline);
        if (bounty > 0) _sendToken(musd, msg.sender, bounty);

        emit ShieldFired(user, msg.sender, byQueue, price, s.repayAmount, bounty);
    }

    // ---------------------------------------------------------------- flash swap callback

    /// @inheritdoc IPoolCallee
    function hook(address sender, uint256 amount0, uint256 amount1, bytes calldata data) external {
        if (msg.sender != address(pool) || sender != address(this)) revert Unauthorized();
        if (_flow != OPEN && _flow != CLOSE && _flow != DELEVER && _flow != RELEVER) revert Unauthorized();
        (uint8 op, bytes memory inner) = abi.decode(data, (uint8, bytes));
        if (op != _flow) revert Unauthorized();

        (uint256 rMusd, uint256 rBtc) = _reserves();
        uint256 price = priceFeed.fetchPrice();

        if (op == RELEVER) {
            (
                address user,
                uint256 addColl,
                uint256 debtIncrease,
                address upperHint,
                address lowerHint,
                uint256 deadline,
                bytes memory signature
            ) = abi.decode(inner, (address, uint256, uint256, address, address, uint256, bytes));
            bos.adjustTroveWithSignature{value: addColl}(
                0, debtIncrease, true, upperHint, lowerHint, user, address(this), signature, deadline
            );
            uint256 flashBtc = musdIsToken0 ? amount1 : amount0;
            uint256 musdIn = _amountIn(flashBtc, rMusd, rBtc);
            if (musdIn > debtIncrease) revert DebtTooSmall(debtIncrease, musdIn);
            _checkDeviation(musdIn, (flashBtc * price) / 1e18);
            _sendToken(musd, address(pool), musdIn);
        } else if (op == OPEN) {
            (
                address user,
                uint256 totalColl,
                uint256 debtAmount,
                address upperHint,
                address lowerHint,
                uint256 deadline,
                bytes memory signature
            ) = abi.decode(inner, (address, uint256, uint256, address, address, uint256, bytes));

            // The flashed BTC is already in our balance (ERC-20 precompile == native balance).
            bos.openTroveWithSignature{value: totalColl}(
                debtAmount, upperHint, lowerHint, user, address(this), signature, deadline
            );
            uint256 flashBtc = musdIsToken0 ? amount1 : amount0;
            uint256 musdIn = _amountIn(flashBtc, rMusd, rBtc);
            if (musdIn > debtAmount) revert DebtTooSmall(debtAmount, musdIn);
            // MUSD paid (valued at $1) vs the BTC bought at the PriceFeed price.
            _checkDeviation(musdIn, (flashBtc * price) / 1e18);
            _sendToken(musd, address(pool), musdIn);
        } else if (op == CLOSE) {
            (address user, uint256 deadline, bytes memory signature) =
                abi.decode(inner, (address, uint256, bytes));
            bos.closeTroveWithSignature(user, address(this), signature, deadline);
            _repayPoolInBtc(musdIsToken0 ? amount0 : amount1, rMusd, rBtc, price);
        } else {
            (
                address user,
                uint256 collWithdrawal,
                uint256 debtRepay,
                address upperHint,
                address lowerHint,
                uint256 deadline,
                bytes memory signature
            ) = abi.decode(inner, (address, uint256, uint256, address, address, uint256, bytes));
            bos.adjustTroveWithSignature(
                collWithdrawal, debtRepay, false, upperHint, lowerHint, user, address(this), signature, deadline
            );
            _repayPoolInBtc(musdIsToken0 ? amount0 : amount1, rMusd, rBtc, price);
        }
    }

    // ---------------------------------------------------------------- views

    /// MUSD the pool wants for `btcOut` BTC (exact-out quote on the volatile curve, fee included).
    function quoteMusdForBtc(uint256 btcOut) external view returns (uint256) {
        (uint256 rMusd, uint256 rBtc) = _reserves();
        return _amountIn(btcOut, rMusd, rBtc);
    }

    /// BTC the pool wants for `musdOut` MUSD.
    function quoteBtcForMusd(uint256 musdOut) external view returns (uint256) {
        (uint256 rMusd, uint256 rBtc) = _reserves();
        return _amountIn(musdOut, rBtc, rMusd);
    }

    /// MUSD that must be flashed to close `user`'s trove (debt minus the 200 MUSD gas compensation).
    /// @dev `getEntireDebtAndColl` already folds pending redistributions into principal and interest.
    function closeAmount(address user) public view returns (uint256) {
        (, uint256 principal, uint256 interest,,,) = troveManager.getEntireDebtAndColl(user);
        uint256 debt = principal + interest;
        if (debt <= GAS_COMPENSATION) revert NoDebt();
        return debt - GAS_COMPENSATION + CLOSE_BUFFER;
    }

    function guardOf(address user) external view returns (Guard memory) {
        return _guards[user];
    }

    function recoilOf(address user) external view returns (Recoil memory) {
        return _recoils[user];
    }

    function shieldOf(address user) external view returns (Shield memory) {
        return _shields[user];
    }

    /// Reserve balance including yield not yet settled.
    function reserveBalance(address user) public view returns (uint256) {
        uint256 r = reserveOf[user];
        uint256 accrued = (r * accYieldPerShare) / 1e18;
        return accrued > _yieldDebt[user] ? r + accrued - _yieldDebt[user] : r;
    }

    // ---------------------------------------------------------------- admin

    function setFee(uint16 _feeBps) external onlyOwner {
        if (_feeBps > MAX_FEE_BPS) revert BadParam();
        feeBps = _feeBps;
        emit FeeChanged(_feeBps);
    }

    function setMaxDeviation(uint16 _bps) external onlyOwner {
        if (_bps == 0 || _bps > MAX_DEVIATION_BPS) revert BadParam();
        maxDeviationBps = _bps;
        emit MaxDeviationChanged(_bps);
    }

    /// Point incentives at the MUSD/BTC gauge's incentive contract and set the share (capped).
    function setIncentives(address target, uint16 bps) external onlyOwner {
        if (bps > MAX_INCENTIVE_BPS || (bps > 0 && target == address(0))) revert BadParam();
        incentiveTarget = target;
        incentiveBps = bps;
        emit IncentivesChanged(target, bps);
    }

    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert BadParam();
        treasury = _treasury;
        emit TreasuryChanged(_treasury);
    }

    function setOwner(address _owner) external onlyOwner {
        if (_owner == address(0)) revert BadParam();
        owner = _owner;
        emit OwnerChanged(_owner);
    }

    // ---------------------------------------------------------------- internals

    function _delever(
        address user,
        uint256 collWithdrawal,
        uint256 debtRepay,
        address upperHint,
        address lowerHint,
        bytes memory signature,
        uint256 deadline
    ) internal returns (uint256 btcOut) {
        uint256 btcBefore = address(this).balance;
        bytes memory inner =
            abi.encode(user, collWithdrawal, debtRepay, upperHint, lowerHint, deadline, signature);
        _flash(true, debtRepay, abi.encode(DELEVER, inner));
        btcOut = address(this).balance - btcBefore;
    }

    function _relever(
        address user,
        uint256 addColl,
        uint256 debtIncrease,
        address upperHint,
        address lowerHint,
        bytes memory signature,
        bytes memory refinanceSig,
        uint256 deadline
    ) internal returns (uint256 musdOut) {
        if (refinanceSig.length != 0) bos.refinanceWithSignature(upperHint, lowerHint, user, refinanceSig, deadline);
        uint256 musdBefore = IERC20Min(musd).balanceOf(address(this));
        bytes memory inner = abi.encode(user, addColl, debtIncrease, upperHint, lowerHint, deadline, signature);
        _flash(false, addColl, abi.encode(RELEVER, inner));
        musdOut = IERC20Min(musd).balanceOf(address(this)) - musdBefore;
    }

    /// Flash-swap `amount` of MUSD (`outMusd`) or BTC out of the pool to this contract.
    function _flash(bool outMusd, uint256 amount, bytes memory data) internal {
        bool out0 = outMusd == musdIsToken0;
        pool.swap(out0 ? amount : 0, out0 ? 0 : amount, address(this), data);
    }

    function _repayPoolInBtc(uint256 musdOut, uint256 rMusd, uint256 rBtc, uint256 price) internal {
        uint256 btcIn = _amountIn(musdOut, rBtc, rMusd);
        // BTC paid (at the PriceFeed price) vs the MUSD bought, valued at $1.
        _checkDeviation((btcIn * price) / 1e18, musdOut);
        uint256 available = address(this).balance;
        if (btcIn > available) revert CollateralShort(available, btcIn);
        _sendToken(btc, address(pool), btcIn);
    }

    /// Revert when the USD value paid into the pool exceeds the fair USD value received by more than
    /// `maxDeviationBps`. Pool fee and price impact count against the same budget.
    function _checkDeviation(uint256 paidUsd, uint256 fairUsd) internal view {
        if (paidUsd * 10_000 > fairUsd * (10_000 + maxDeviationBps)) revert PriceDeviation(paidUsd, fairUsd);
    }

    /// Walk the redemption queue from its tail (lowest nominal ICR, redeemed first) up to `user`,
    /// summing the debt redemptions would take first. Troves under MCR are skipped, like redemptions do.
    /// Stops early once `stopAbove` is exceeded.
    function _debtAhead(address user, uint256 stopAbove, uint256 maxSteps, uint256 price)
        internal
        view
        returns (uint256 ahead, bool found)
    {
        if (maxSteps > MAX_QUEUE_STEPS) maxSteps = MAX_QUEUE_STEPS;
        address cur = sortedTroves.getLast();
        for (uint256 i; i < maxSteps && cur != address(0); ++i) {
            if (cur == user) return (ahead, true);
            if (troveManager.getCurrentICR(cur, price) >= MCR) {
                (, uint256 principal, uint256 interest,,,) = troveManager.getEntireDebtAndColl(cur);
                uint256 debt = principal + interest;
                if (debt > GAS_COMPENSATION) ahead += debt - GAS_COMPENSATION;
                if (ahead > stopAbove) return (ahead, false);
            }
            cur = sortedTroves.getPrev(cur);
        }
        return (ahead, cur == user);
    }

    /// Claim the yield sMUSD owes this contract, put it back to work and credit it per Reserve MUSD.
    function _harvest() internal {
        if (totalReserve == 0) return;
        uint256 before = IERC20Min(musd).balanceOf(address(this));
        savings.claimYield();
        uint256 y = IERC20Min(musd).balanceOf(address(this)) - before;
        if (y == 0) return;
        savings.deposit(y);
        accYieldPerShare += (y * 1e18) / totalReserve;
        emit YieldHarvested(y);
    }

    /// Fold a user's accrued yield into their Reserve balance.
    function _settle(address user) internal {
        uint256 r = reserveOf[user];
        uint256 accrued = (r * accYieldPerShare) / 1e18;
        uint256 debt = _yieldDebt[user];
        if (accrued > debt) {
            uint256 pending = accrued - debt;
            r += pending;
            reserveOf[user] = r;
            totalReserve += pending;
        }
        _yieldDebt[user] = (r * accYieldPerShare) / 1e18;
    }

    /// Debit `amount` from `user`'s Reserve and bring that MUSD out of sMUSD into this contract.
    /// sMUSD pays any outstanding yield on withdraw; that extra is put back and credited to everyone.
    function _takeFromReserve(address user, uint256 amount) internal {
        reserveOf[user] -= amount;
        totalReserve -= amount;
        _yieldDebt[user] = (reserveOf[user] * accYieldPerShare) / 1e18;
        uint256 before = IERC20Min(musd).balanceOf(address(this));
        savings.withdraw(amount);
        uint256 got = IERC20Min(musd).balanceOf(address(this)) - before;
        if (got > amount) {
            uint256 extra = got - amount;
            if (totalReserve > 0) {
                savings.deposit(extra);
                accYieldPerShare += (extra * 1e18) / totalReserve;
                emit YieldHarvested(extra);
            } else {
                // Last depositor out: nobody else to credit, so the yield goes to them.
                _sendToken(musd, user, extra);
            }
        }
    }

    /// Exact-out input for the volatile (x*y) curve after the pool fee:
    /// (rIn + in*(1-fee)) * (rOut - out) >= rIn * rOut.
    function _amountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut)
        internal
        view
        returns (uint256)
    {
        if (amountOut >= reserveOut) revert InsufficientLiquidity();
        uint256 fee = poolFactory.getFee(address(pool), false);
        return (reserveIn * amountOut * 10_000) / ((reserveOut - amountOut) * (10_000 - fee)) + 1;
    }

    function _reserves() internal view returns (uint256 rMusd, uint256 rBtc) {
        (uint256 r0, uint256 r1,) = pool.getReserves();
        (rMusd, rBtc) = musdIsToken0 ? (r0, r1) : (r1, r0);
    }

    function _sendToken(address token, address to, uint256 amount) internal {
        if (!IERC20Min(token).transfer(to, amount)) revert TransferFailed();
    }

    function _sendBtc(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
