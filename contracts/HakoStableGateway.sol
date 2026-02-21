// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/interfaces/IERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./shared/VaultMath.sol";
import "./stable/HakoStableGatewayStorage.sol";
import "./stable/HakoStableGatewayTypes.sol";

/// @title Hako Stable Gateway
/// @notice Remote-chain custody gateway for stablecoin deposits, withdrawal request handling, and payout execution.
/// @dev UUPS-upgradeable contract with role-based controls and optional external ERC-4626 asset allocation.
contract HakoStableGateway is
    Initializable,
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable,
    HakoStableGatewayTypes
{
    using SafeERC20 for IERC20;

    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant WITHDRAW_FINALIZER_ROLE = keccak256("WITHDRAW_FINALIZER_ROLE");
    bytes32 public constant ASSET_MANAGER_ROLE = keccak256("ASSET_MANAGER_ROLE");
    bytes32 public constant CONFIG_MANAGER_ROLE = keccak256("CONFIG_MANAGER_ROLE");

    /// @dev Locks implementation contract to prevent direct initialization.
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializes gateway roles and token configuration.
    /// @param initialOwner Initial admin/operator address.
    /// @param allowedDepositTokens List of allowed gateway deposit tokens.
    /// @param minDepositValue Minimum allowed normalized deposit amount (18 decimals).
    function initialize(address initialOwner, address[] calldata allowedDepositTokens, uint256 minDepositValue)
        external
        initializer
    {
        if (initialOwner == address(0)) revert ZeroAddress();
        if (minDepositValue == 0) revert AmountZero();

        __AccessControl_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, initialOwner);
        _grantRole(UPGRADER_ROLE, initialOwner);
        _grantRole(GUARDIAN_ROLE, initialOwner);
        _grantRole(WITHDRAW_FINALIZER_ROLE, initialOwner);
        _grantRole(ASSET_MANAGER_ROLE, initialOwner);
        _grantRole(CONFIG_MANAGER_ROLE, initialOwner);

        HakoStableGatewayStorage.Layout storage layout_ = HakoStableGatewayStorage.layout();
        layout_.minDepositNormalized = minDepositValue;

        emit GatewayMinDepositUpdated(0, minDepositValue);

        for (uint256 i = 0; i < allowedDepositTokens.length; i++) {
            _addAllowedDepositToken(allowedDepositTokens[i]);
        }
    }

    // ---------------------------------------------------------------------
    // Pause Controls
    // ---------------------------------------------------------------------

    /// @notice Pauses gateway operational flows.
    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    /// @notice Unpauses gateway operational flows.
    function unpause() external onlyRole(GUARDIAN_ROLE) {
        _unpause();
    }

    // ---------------------------------------------------------------------
    // Configuration
    // ---------------------------------------------------------------------

    /// @notice Adds a token that can be deposited into the gateway.
    /// @param token ERC20 token address.
    function addAllowedDepositToken(address token) external onlyRole(CONFIG_MANAGER_ROLE) {
        _addAllowedDepositToken(token);
    }

    /// @notice Removes a token from the gateway deposit allowlist.
    /// @param token ERC20 token address.
    function removeAllowedDepositToken(address token) external onlyRole(CONFIG_MANAGER_ROLE) {
        HakoStableGatewayStorage.Layout storage layout_ = HakoStableGatewayStorage.layout();
        if (!layout_.allowedDepositToken[token]) return;

        layout_.allowedDepositToken[token] = false;
        emit GatewayAllowedDepositTokenUpdated(token, layout_.depositTokenDecimals[token], false);
    }

    /// @notice Updates the minimum normalized deposit amount.
    /// @param minDepositValue Minimum deposit value in normalized units.
    function setMinDeposit(uint256 minDepositValue) external onlyRole(CONFIG_MANAGER_ROLE) {
        if (minDepositValue == 0) revert AmountZero();

        HakoStableGatewayStorage.Layout storage layout_ = HakoStableGatewayStorage.layout();
        uint256 oldMin = layout_.minDepositNormalized;
        layout_.minDepositNormalized = minDepositValue;

        emit GatewayMinDepositUpdated(oldMin, minDepositValue);
    }

    /// @notice Enables or disables an external ERC-4626 vault for gateway allocation.
    /// @param vault ERC-4626 vault address.
    /// @param allowed Whether this vault is allowlisted.
    function setExternalVaultAllowed(address vault, bool allowed) external onlyRole(CONFIG_MANAGER_ROLE) {
        if (vault == address(0)) revert ZeroAddress();

        HakoStableGatewayStorage.layout().allowedExternalVault[vault] = allowed;
        emit ExternalVaultAllowlistUpdated(vault, allowed);
    }

    // ---------------------------------------------------------------------
    // Deposit Flows
    // ---------------------------------------------------------------------

    /// @notice Deposits an allowlisted stablecoin into the gateway.
    /// @param token Deposit token address.
    /// @param amount Raw amount in token decimals.
    /// @param receiver EVM receiver identity for this deposit.
    function deposit(address token, uint256 amount, address receiver) external nonReentrant whenNotPaused {
        if (receiver == address(0)) revert ZeroAddress();
        _recordDeposit(token, amount, receiver);
    }

    // ---------------------------------------------------------------------
    // Withdrawal Request Flows
    // ---------------------------------------------------------------------

    /// @notice Creates a local withdrawal request for this gateway chain.
    /// @param token Withdrawal token address.
    /// @param amountToken Requested payout amount in token decimals.
    /// @param receiver Payout receiver address on this chain.
    /// @return requestId Created withdrawal request id.
    function requestWithdrawal(address token, uint256 amountToken, address receiver)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 requestId)
    {
        if (receiver == address(0)) revert ZeroAddress();

        uint8 decimals = _requireAllowedToken(token);
        if (amountToken == 0) revert AmountZero();

        uint256 amountNormalized = VaultMath.normalizeAmount(amountToken, decimals);
        requestId = _createWithdrawalRequest(msg.sender, receiver, token, amountToken, amountNormalized);
    }

    /// @notice Completes a pending withdrawal request and pays token to receiver.
    /// @param requestId Withdrawal request id.
    function completeWithdrawal(uint256 requestId) external onlyRole(WITHDRAW_FINALIZER_ROLE) nonReentrant {
        HakoStableGatewayStorage.Layout storage layout_ = HakoStableGatewayStorage.layout();
        GatewayWithdrawalRequest storage req = layout_.withdrawalRequests[requestId];
        if (req.status != GatewayWithdrawalStatus.Pending) revert WithdrawalNotPending(requestId);

        req.status = GatewayWithdrawalStatus.Completed;

        IERC20(req.token).safeTransfer(req.receiver, req.amountToken);
        emit GatewayWithdrawalCompleted(requestId, req.receiver, req.token, req.amountToken);
    }

    /// @notice Cancels a pending withdrawal request.
    /// @param requestId Withdrawal request id.
    function cancelWithdrawal(uint256 requestId) external onlyRole(WITHDRAW_FINALIZER_ROLE) nonReentrant {
        HakoStableGatewayStorage.Layout storage layout_ = HakoStableGatewayStorage.layout();
        GatewayWithdrawalRequest storage req = layout_.withdrawalRequests[requestId];
        if (req.status != GatewayWithdrawalStatus.Pending) revert WithdrawalNotPending(requestId);

        req.status = GatewayWithdrawalStatus.Canceled;

        emit GatewayWithdrawalCanceled(requestId, req.token, req.amountToken);
    }

    // ---------------------------------------------------------------------
    // Asset Management
    // ---------------------------------------------------------------------

    /// @notice Transfers assets out for bridge/swap/operational workflows.
    /// @dev This is role-only by design and intentionally does not enforce destination allowlists.
    /// @param operationId Unique operation id for replay protection.
    /// @param token Token address.
    /// @param to Destination address.
    /// @param amountToken Token amount in raw token decimals.
    /// @param reasonCode Optional operation reason code.
    function transferOut(bytes32 operationId, address token, address to, uint256 amountToken, bytes32 reasonCode)
        external
        onlyRole(ASSET_MANAGER_ROLE)
        nonReentrant
        whenNotPaused
    {
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        if (amountToken == 0) revert AmountZero();

        HakoStableGatewayStorage.Layout storage layout_ = HakoStableGatewayStorage.layout();
        if (layout_.processedTransferOut[operationId]) revert OperationAlreadyProcessed(operationId);

        layout_.processedTransferOut[operationId] = true;

        IERC20(token).safeTransfer(to, amountToken);
        emit GatewayTransferOut(operationId, token, to, amountToken, reasonCode);
    }

    /// @notice Deposits underlying tokens into an allowlisted external ERC-4626 vault.
    /// @param vault External vault address.
    /// @param assets Underlying asset amount.
    /// @return sharesMinted External vault shares received.
    function depositIntoExternalVault(address vault, uint256 assets)
        external
        onlyRole(ASSET_MANAGER_ROLE)
        nonReentrant
        whenNotPaused
        returns (uint256 sharesMinted)
    {
        if (assets == 0) revert AmountZero();

        address asset = _cacheExternalVault(vault);

        IERC20 underlying = IERC20(asset);
        uint256 allowance = underlying.allowance(address(this), vault);
        if (allowance < assets) {
            underlying.forceApprove(vault, type(uint256).max);
        }

        sharesMinted = IERC4626(vault).deposit(assets, address(this));
        emit ExternalVaultDeposit(vault, asset, assets, sharesMinted);
    }

    /// @notice Withdraws underlying assets from an external vault.
    /// @param vault External vault address.
    /// @param assets Underlying asset amount.
    /// @param receiver Receiver address (`0` means this contract).
    /// @return sharesBurned External vault shares burned.
    function withdrawFromExternalVault(address vault, uint256 assets, address receiver)
        external
        onlyRole(ASSET_MANAGER_ROLE)
        nonReentrant
        whenNotPaused
        returns (uint256 sharesBurned)
    {
        if (assets == 0) revert AmountZero();
        if (receiver != address(0) && receiver != address(this)) revert ExternalReceiverNotAllowed();

        address asset = _getExternalVaultInfo(vault);
        address to = receiver == address(0) ? address(this) : receiver;

        sharesBurned = IERC4626(vault).withdraw(assets, to, address(this));
        emit ExternalVaultWithdraw(vault, asset, assets, sharesBurned, to);
    }

    /// @notice Redeems external vault shares for underlying assets.
    /// @param vault External vault address.
    /// @param shares External vault shares to redeem.
    /// @param receiver Receiver address (`0` means this contract).
    /// @return assetsReceived Underlying assets received.
    function redeemFromExternalVault(address vault, uint256 shares, address receiver)
        external
        onlyRole(ASSET_MANAGER_ROLE)
        nonReentrant
        whenNotPaused
        returns (uint256 assetsReceived)
    {
        if (shares == 0) revert AmountZero();
        if (receiver != address(0) && receiver != address(this)) revert ExternalReceiverNotAllowed();

        address asset = _getExternalVaultInfo(vault);
        address to = receiver == address(0) ? address(this) : receiver;

        assetsReceived = IERC4626(vault).redeem(shares, to, address(this));
        emit ExternalVaultRedeem(vault, asset, shares, assetsReceived, to);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Returns current minimum normalized deposit amount.
    function minDepositNormalized() external view returns (uint256) {
        return HakoStableGatewayStorage.layout().minDepositNormalized;
    }

    /// @notice Returns stored withdrawal request fields.
    /// @param requestId Request id.
    function getWithdrawalRequest(uint256 requestId)
        external
        view
        returns (
            address owner,
            address receiver,
            address token,
            uint256 amountToken,
            uint256 amountNormalized,
            GatewayWithdrawalStatus status
        )
    {
        GatewayWithdrawalRequest storage req = HakoStableGatewayStorage.layout().withdrawalRequests[requestId];

        return (req.owner, req.receiver, req.token, req.amountToken, req.amountNormalized, req.status);
    }

    /// @notice Returns encoded receiver payload for a withdrawal request.
    /// @param requestId Request id.
    function getWithdrawalReceiver(uint256 requestId) external view returns (bytes memory) {
        return HakoStableGatewayStorage.layout().withdrawalReceiverData[requestId];
    }

    /// @notice Returns current non-zero external vault positions with normalized valuation.
    function getExternalVaultPositions() external view returns (ExternalVaultPositionView[] memory positions) {
        HakoStableGatewayStorage.Layout storage layout_ = HakoStableGatewayStorage.layout();

        uint256 len = layout_.externalVaultsList.length;
        uint256 count;

        for (uint256 i = 0; i < len; i++) {
            address vault = layout_.externalVaultsList[i];
            address asset = layout_.externalVaultAsset[vault];
            if (asset == address(0)) continue;

            uint256 shareBalance = IERC20(vault).balanceOf(address(this));
            if (shareBalance == 0) continue;
            count++;
        }

        positions = new ExternalVaultPositionView[](count);

        uint256 posIndex;
        for (uint256 i = 0; i < len; i++) {
            address vault = layout_.externalVaultsList[i];
            address asset = layout_.externalVaultAsset[vault];
            if (asset == address(0)) continue;

            uint256 shareBalance = IERC20(vault).balanceOf(address(this));
            if (shareBalance == 0) continue;

            uint256 assetsValue = IERC4626(vault).convertToAssets(shareBalance);
            positions[posIndex] = ExternalVaultPositionView({
                vault: vault,
                asset: asset,
                shareBalance: shareBalance,
                assets: assetsValue,
                assetsNormalized: VaultMath.normalizeAmount(assetsValue, layout_.depositTokenDecimals[asset])
            });
            posIndex++;
        }
    }

    // ---------------------------------------------------------------------
    // Internal Helpers
    // ---------------------------------------------------------------------

    /// @dev Records deposit accounting and emits canonical gateway deposit event.
    function _recordDeposit(address token, uint256 amount, address receiver) internal {
        if (token == address(0)) revert ZeroAddress();
        if (receiver == address(0)) revert ZeroAddress();
        if (amount == 0) revert AmountZero();

        HakoStableGatewayStorage.Layout storage layout_ = HakoStableGatewayStorage.layout();
        uint8 decimals = _requireAllowedToken(token);

        uint256 amountNormalized = VaultMath.normalizeAmount(amount, decimals);
        if (amountNormalized < layout_.minDepositNormalized) revert BelowMinDeposit();

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        bytes32 depositId = keccak256(abi.encodePacked(block.chainid, address(this), ++layout_.nextDepositId));
        emit GatewayDepositRecorded(depositId, msg.sender, token, amount, amountNormalized, receiver);
    }

    /// @dev Creates and stores a withdrawal request.
    function _createWithdrawalRequest(
        address owner,
        address receiver,
        address token,
        uint256 amountToken,
        uint256 amountNormalized
    ) internal returns (uint256 requestId) {
        if (owner == address(0) || receiver == address(0) || token == address(0)) revert ZeroAddress();
        if (amountToken == 0 || amountNormalized == 0) revert AmountZero();

        HakoStableGatewayStorage.Layout storage layout_ = HakoStableGatewayStorage.layout();

        requestId = ++layout_.nextWithdrawalId;
        layout_.withdrawalRequests[requestId] = GatewayWithdrawalRequest({
            owner: owner,
            receiver: receiver,
            token: token,
            amountToken: amountToken,
            amountNormalized: amountNormalized,
            status: GatewayWithdrawalStatus.Pending
        });

        layout_.withdrawalReceiverData[requestId] = abi.encodePacked(receiver);

        emit GatewayWithdrawalRequested(requestId, owner, receiver, token, amountToken, amountNormalized);
    }

    /// @dev Adds a token to allowlist after decimals validation.
    function _addAllowedDepositToken(address token) internal {
        if (token == address(0)) revert ZeroAddress();

        HakoStableGatewayStorage.Layout storage layout_ = HakoStableGatewayStorage.layout();
        if (layout_.allowedDepositToken[token]) return;

        uint8 decimals = ERC20(token).decimals();
        if (decimals > 18) revert DecimalsTooHigh();

        layout_.allowedDepositToken[token] = true;
        layout_.depositTokenDecimals[token] = decimals;

        emit GatewayAllowedDepositTokenUpdated(token, decimals, true);
    }

    /// @dev Caches external vault asset metadata on first use.
    function _cacheExternalVault(address vault) internal returns (address asset) {
        HakoStableGatewayStorage.Layout storage layout_ = HakoStableGatewayStorage.layout();
        if (!layout_.allowedExternalVault[vault]) revert ExternalVaultNotAllowed(vault);

        address liveAsset = IERC4626(vault).asset();
        if (liveAsset == address(0)) revert ZeroAddress();

        asset = layout_.externalVaultAsset[vault];
        if (asset == address(0)) {
            if (!layout_.allowedDepositToken[liveAsset]) revert TokenNotAllowed(liveAsset);

            asset = liveAsset;
            layout_.externalVaultAsset[vault] = asset;
            layout_.externalVaultsList.push(vault);

            emit ExternalVaultCached(vault, asset, layout_.depositTokenDecimals[asset]);
            return asset;
        }

        if (asset != liveAsset) revert ExternalVaultAssetMismatch(vault, asset, liveAsset);
    }

    /// @dev UUPS authorization hook.
    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}

    /// @dev Returns cached external vault metadata or reverts if vault is unknown.
    function _getExternalVaultInfo(address vault) internal view returns (address asset) {
        HakoStableGatewayStorage.Layout storage layout_ = HakoStableGatewayStorage.layout();

        asset = layout_.externalVaultAsset[vault];
        if (asset == address(0)) revert ExternalVaultUnknown(vault);

        address liveAsset = IERC4626(vault).asset();
        if (liveAsset == address(0)) revert ZeroAddress();
        if (asset != liveAsset) revert ExternalVaultAssetMismatch(vault, asset, liveAsset);
    }

    /// @dev Ensures token is currently allowlisted and returns configured decimals.
    function _requireAllowedToken(address token) internal view returns (uint8 decimals) {
        HakoStableGatewayStorage.Layout storage layout_ = HakoStableGatewayStorage.layout();
        if (!layout_.allowedDepositToken[token]) revert TokenNotAllowed(token);
        return layout_.depositTokenDecimals[token];
    }
}
