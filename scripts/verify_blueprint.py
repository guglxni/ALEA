"""
Verify a blueprint binary: check shape, normalization, and report per-bucket stats.

Usage:
    python scripts/verify_blueprint.py data/blueprint_v1.bin
"""

import sys
import struct
import numpy as np

TOTAL_BUCKETS = 7680
NUM_ACTIONS   = 4
EXPECTED_FLOATS = TOTAL_BUCKETS * NUM_ACTIONS


def load(path: str) -> np.ndarray:
    raw = open(path, "rb").read()
    floats = struct.unpack(f"{len(raw)//4}f", raw)
    arr = np.array(floats, dtype=np.float32).reshape(-1, NUM_ACTIONS)
    return arr


def verify(strategy: np.ndarray) -> None:
    print(f"Shape        : {strategy.shape}")
    print(f"Expected     : ({TOTAL_BUCKETS}, {NUM_ACTIONS})")
    assert strategy.shape == (TOTAL_BUCKETS, NUM_ACTIONS), "Shape mismatch!"

    sums = strategy.sum(axis=1)
    bad  = np.where(np.abs(sums - 1.0) > 1e-3)[0]
    print(f"Row sums ok  : {len(bad) == 0}  (bad={len(bad)})")

    print(f"Mean fold    : {strategy[:, 0].mean():.4f}")
    print(f"Mean call    : {strategy[:, 1].mean():.4f}")
    print(f"Mean raise   : {strategy[:, 2].mean():.4f}")
    print(f"Mean all-in  : {strategy[:, 3].mean():.4f}")

    dominant = strategy.argmax(axis=1)
    labels = ["fold", "call", "raise", "all-in"]
    for i, label in enumerate(labels):
        count = (dominant == i).sum()
        print(f"  Dominant action={label}: {count} buckets ({100*count/TOTAL_BUCKETS:.1f}%)")

    print("PASS" if len(bad) == 0 else "FAIL")


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else "data/blueprint_v1.bin"
    strategy = load(path)
    verify(strategy)
