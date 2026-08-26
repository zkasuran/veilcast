//! Constant-product AMM (FPMM) over a binary YES/NO share pair, the pricing engine the
//! leveraged market marks and settles against.
//!
//! Everything here is exact integer arithmetic: `u256` intermediates for the products and
//! Cairo's built-in `u256` square root for the one quadratic (a constant-product sell). No
//! fixed-point `exp`/`ln`, so the math is auditable and cannot silently lose precision. Every
//! rounding step favors the pool (shares out and collateral out round down, the reserve the
//! pool keeps rounds up), so rounding can only leave the AMM over-collateralized, never short.
//!
//! Collateral and shares share one unit (the STRK smallest unit): one unit of collateral mints
//! one YES plus one NO share, and a complete YES+NO set redeems for one unit at settlement.
//! Reserves are `u128`; a price is basis points of 1 in `[0, 10000]`.

use core::num::traits::Sqrt;

/// Basis-point scale: 10000 bps == probability 1.
pub const BPS: u128 = 10000;

/// Marginal price of the `bought` outcome in basis points: `r_other / (r_bought + r_other)`,
/// rounded down. An empty book (no reserves) reads as an even 5000. The two sides always sum
/// to 10000 by construction, so `no_price = 10000 - yes_price`.
pub fn price_bps(r_bought: u128, r_other: u128) -> u16 {
    let total = r_bought + r_other;
    if total == 0 {
        return 5000;
    }
    let num: u256 = r_other.into() * BPS.into();
    let price: u256 = num / total.into();
    // price <= BPS, fits u16.
    price.try_into().unwrap()
}

/// Buy `amount` collateral worth of the `bought` outcome from reserves `(r_bought, r_other)`.
/// Returns `(shares_out, new_r_bought, new_r_other)`.
///
/// Mints `amount` of each share into the pool, then withdraws `bought` shares to hold the
/// product constant: `ending_bought = r_bought * r_other / (r_other + amount)`, rounded UP so
/// the shares handed out round DOWN. The invariant `new_r_bought * new_r_other >= r_bought *
/// r_other` therefore holds, which is what keeps the AMM solvent.
pub fn buy(r_bought: u128, r_other: u128, amount: u128) -> (u128, u128, u128) {
    assert(amount != 0, 'ZERO_AMOUNT');
    let rb: u256 = r_bought.into();
    let ro: u256 = r_other.into();
    let a: u256 = amount.into();
    let denom: u256 = ro + a;
    let numer: u256 = rb * ro;
    // Ceiling division: (numer + denom - 1) / denom.
    let ending: u256 = (numer + denom - 1) / denom;
    let ending_bought: u128 = ending.try_into().unwrap();
    // ending_bought <= r_bought, so this never underflows.
    let shares_out: u128 = (r_bought + amount) - ending_bought;
    (shares_out, ending_bought, r_other + amount)
}

/// Sell `shares` of the `sold` outcome back into reserves `(r_sold, r_other)`.
/// Returns `(amount_out, new_r_sold, new_r_other)` where `amount_out` is the collateral the
/// seller receives, rounded DOWN and never above the exact constant-product value.
///
/// Adds `shares` to the sold reserve, then withdraws `x` of each share (redeeming `x`
/// collateral) holding the product constant: `(r_sold + shares - x)(r_other - x) = k`, whose
/// smaller root is `x = ((A+B) - sqrt((A+B)^2 - 4*shares*r_other)) / 2` with `A = r_sold +
/// shares`, `B = r_other`. The discriminant is always non-negative (AM-GM), and `x <=
/// r_other`, so no underflow. We use `ceil(sqrt)` so `x` rounds strictly down: the pool never
/// pays more than the invariant allows, and `new_r_sold * new_r_other >= k`.
pub fn sell(r_sold: u128, r_other: u128, shares: u128) -> (u128, u128, u128) {
    assert(shares != 0, 'ZERO_AMOUNT');
    let s: u256 = (r_sold + shares).into() + r_other.into();
    let four_prod: u256 = 4_u256 * shares.into() * r_other.into();
    let disc: u256 = s * s - four_prod;
    let root_ceil: u256 = disc.sqrt().into() + 1; // ceil-ish: >= exact sqrt, keeps x conservative
    let numer: u256 = if s > root_ceil {
        s - root_ceil
    } else {
        0
    };
    let x: u128 = (numer / 2).try_into().unwrap();
    (x, r_sold + shares - x, r_other - x)
}

#[cfg(test)]
mod tests {
    use super::{buy, price_bps, sell};

    #[test]
    fn even_book_prices_at_half() {
        assert(price_bps(1000, 1000) == 5000, 'even = 5000');
        assert(price_bps(1000, 3000) == 7500, 'skewed up');
        assert(price_bps(0, 0) == 5000, 'empty = 5000');
    }

    #[test]
    fn buy_then_sell_never_profits_the_trader() {
        // Round-trip on a constant-product pool must return no more collateral than went in.
        let (shares, r_b, r_o) = buy(10000, 10000, 1000);
        assert(shares > 1000, 'leverage on price'); // more shares than collateral (price < 1)
        let (back, _, _) = sell(r_b, r_o, shares);
        assert(back <= 1000, 'no free money');
    }

    #[test]
    fn buying_raises_the_price() {
        let (_, r_b, r_o) = buy(10000, 10000, 5000);
        assert(price_bps(r_b, r_o) > 5000, 'price moved up');
    }
}
