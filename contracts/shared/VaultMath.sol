// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

library VaultMath {
    uint256 internal constant PRECISION = 1e18;

    function normalizeAmount(uint256 amount, uint8 decimals_) internal pure returns (uint256) {
        if (amount == 0) return 0;
        if (decimals_ > 18) revert("DECIMALS_GT_18");
        if (decimals_ == 18) return amount;
        return amount * 10 ** (18 - decimals_);
    }

    function convertToSharesCeil(uint256 assetsNormalized, uint256 supply, uint256 managed) internal pure returns (uint256) {
        if (assetsNormalized == 0) return 0;
        if (supply == 0 || managed == 0) return assetsNormalized;
        return (assetsNormalized * supply + managed - 1) / managed;
    }

    function convertToAssetsFloor(uint256 shares, uint256 supply, uint256 managed) internal pure returns (uint256) {
        if (shares == 0) return 0;
        if (supply == 0 || managed == 0) return shares;
        return (shares * managed) / supply;
    }

    function previewMintShares(uint256 amountNormalized, uint256 supply, uint256 managed) internal pure returns (uint256) {
        if (supply == 0 || managed == 0) return amountNormalized;
        return (amountNormalized * supply) / managed;
    }

    function previewLockShares(uint256 amountNormalized, uint256 supply, uint256 managed) internal pure returns (uint256) {
        if (managed == 0) return 0;
        if (supply == 0) return amountNormalized;
        return (amountNormalized * supply + managed - 1) / managed;
    }

    function calculatePerformanceFeeShares(
        uint256 profit,
        uint256 performanceFeeBps,
        uint256 managed,
        uint256 supply,
        uint256 highWaterMark
    )
        internal
        pure
        returns (uint256 feeShares, uint256 newHighWaterMark, uint256 taxableProfit)
    {
        if (performanceFeeBps == 0 || profit == 0 || managed == 0 || supply == 0) {
            return (0, highWaterMark, 0);
        }

        uint256 currentPrice = (managed * PRECISION) / supply;
        uint256 priceBeforeProfit = ((managed - profit) * PRECISION) / supply;

        uint256 hwm = highWaterMark;
        if (hwm == 0) {
            hwm = priceBeforeProfit;
        }

        if (currentPrice <= hwm) {
            return (0, hwm, 0);
        }

        uint256 taxableBase = priceBeforeProfit > hwm ? priceBeforeProfit : hwm;
        uint256 taxableGainPerShare = currentPrice - taxableBase;
        taxableProfit = (taxableGainPerShare * supply) / PRECISION;

        if (taxableProfit == 0) {
            return (0, currentPrice, 0);
        }

        uint256 feeAmount = (taxableProfit * performanceFeeBps) / 10_000;
        if (feeAmount == 0) {
            return (0, currentPrice, taxableProfit);
        }

        feeShares = (feeAmount * supply) / managed;
        return (feeShares, currentPrice, taxableProfit);
    }
}
