"""
CFR+ solver for short-deck poker using OpenSpiel.

Produces blueprint_v1.bin: 7,680 buckets × 4 float32 action probabilities.
Layout: [p_fold, p_call, p_half_pot, p_all_in] per bucket, row-major.

Usage:
    python scripts/solve_blueprint.py --iterations 1000000 --output data/blueprint_v1.bin

Requires:
    pip install open_spiel numpy
"""

import argparse
import struct
import os
import sys
import numpy as np

try:
    import pyspiel
    from open_spiel.python.algorithms import cfr
    SPIEL_AVAILABLE = True
except ImportError:
    SPIEL_AVAILABLE = False
    print("[warn] open_spiel not installed — running in stub mode (uniform strategy)")

# Bucket dimensions (must match src/blueprint/bucketing.ts)
HAND_BUCKETS     = 8
EQUITY_BUCKETS   = 5
BET_BUCKETS      = 4
POSITION_BUCKETS = 4
STACK_BUCKETS    = 3
STREET_COUNT     = 4

TOTAL_BUCKETS = HAND_BUCKETS * EQUITY_BUCKETS * BET_BUCKETS * POSITION_BUCKETS * STACK_BUCKETS * STREET_COUNT
# = 7,680

NUM_ACTIONS = 4  # fold, call, half-pot raise, all-in


def compute_key(hand, equity, bet, position, stack, street):
    return (
        hand     * (EQUITY_BUCKETS * BET_BUCKETS * POSITION_BUCKETS * STACK_BUCKETS * STREET_COUNT)
        + equity * (BET_BUCKETS * POSITION_BUCKETS * STACK_BUCKETS * STREET_COUNT)
        + bet    * (POSITION_BUCKETS * STACK_BUCKETS * STREET_COUNT)
        + position * (STACK_BUCKETS * STREET_COUNT)
        + stack  * STREET_COUNT
        + street
    )


def build_stub_strategy() -> np.ndarray:
    """
    Stub strategy: heuristic approximation used when OpenSpiel is unavailable.
    Strong hands (low bucket) prefer raising; weak hands prefer folding.
    This is NOT a Nash equilibrium — use only for development bootstrapping.
    """
    strategy = np.zeros((TOTAL_BUCKETS, NUM_ACTIONS), dtype=np.float32)

    for hand in range(HAND_BUCKETS):
        for equity in range(EQUITY_BUCKETS):
            for bet in range(BET_BUCKETS):
                for pos in range(POSITION_BUCKETS):
                    for stack in range(STACK_BUCKETS):
                        for street in range(STREET_COUNT):
                            key = compute_key(hand, equity, bet, pos, stack, street)

                            strength = (HAND_BUCKETS - 1 - hand) / (HAND_BUCKETS - 1)
                            eq_norm  = equity / (EQUITY_BUCKETS - 1)
                            combined = (strength + eq_norm) / 2.0  # 0=weak, 1=strong

                            # [fold, call, half-pot, all-in]
                            if combined > 0.75:
                                dist = [0.05, 0.15, 0.50, 0.30]
                            elif combined >= 0.50:
                                dist = [0.10, 0.45, 0.35, 0.10]
                            elif combined >= 0.25:
                                dist = [0.30, 0.50, 0.15, 0.05]
                            else:
                                dist = [0.70, 0.25, 0.04, 0.01]

                            strategy[key] = dist

    return strategy


def solve_with_openspiel(iterations: int) -> np.ndarray:
    """
    Run CFR+ on a simplified short-deck game tree.
    Maps converged strategy to bucket representation.
    """
    # Short-deck leduc poker as a proxy game (OpenSpiel built-in)
    # For production: implement full short-deck game as custom OpenSpiel environment
    game = pyspiel.load_game("leduc_poker")
    cfr_solver = cfr.CFRPlusSolver(game)

    print(f"[solve] Running CFR+ for {iterations} iterations...")
    for i in range(iterations):
        cfr_solver.evaluate_and_update_policy()
        if (i + 1) % 100_000 == 0:
            policy = cfr_solver.average_policy()
            expl = pyspiel.exploitability.exploitability(game, policy)
            print(f"  iter={i+1:,}  exploitability={expl:.6f}")
            if expl < 0.05:
                print(f"[solve] Converged at iteration {i+1}")
                break

    # Map OpenSpiel policy to bucket strategy
    # Full implementation: enumerate all information sets, bucket each, populate strategy table
    # Placeholder: return stub strategy with convergence log
    print("[solve] Mapping to bucket strategy (stub mapping — implement full IS enumeration)")
    return build_stub_strategy()


def verify_strategy(strategy: np.ndarray) -> None:
    """Check that all distributions sum to ~1.0."""
    sums = strategy.sum(axis=1)
    bad = np.where(np.abs(sums - 1.0) > 1e-4)[0]
    if len(bad) > 0:
        raise ValueError(f"Strategy rows not normalized at buckets: {bad[:5]}")
    print(f"[verify] All {len(strategy)} rows sum to 1.0 OK")


def write_binary(strategy: np.ndarray, output_path: str) -> None:
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    strategy.astype(np.float32).tofile(output_path)
    size_kb = os.path.getsize(output_path) / 1024
    print(f"[write] Blueprint written: {output_path} ({size_kb:.1f} KB, {len(strategy)} buckets)")


def main():
    parser = argparse.ArgumentParser(description="Solve CFR+ blueprint for short-deck poker")
    parser.add_argument("--iterations", type=int, default=1_000_000)
    parser.add_argument("--output",     type=str, default="data/blueprint_v1.bin")
    parser.add_argument("--stub",       action="store_true", help="Force stub mode (skip CFR solve)")
    args = parser.parse_args()

    if args.stub or not SPIEL_AVAILABLE:
        print("[solve] Using stub strategy (heuristic approximation)")
        strategy = build_stub_strategy()
    else:
        strategy = solve_with_openspiel(args.iterations)

    verify_strategy(strategy)
    write_binary(strategy, args.output)


if __name__ == "__main__":
    main()
