export interface TendencyProfile {
  opponentId: string;
  handsObserved: number;
  foldToThreeBetDeviation: number;
  continuationBetCallDeviation: number;
  bluffFrequencyDeviation: number;
  allInCallDeviation: number;
  confidenceScore: number;
  lastUpdatedHand: number;
}

export function emptyProfile(opponentId: string): TendencyProfile {
  return {
    opponentId,
    handsObserved: 0,
    foldToThreeBetDeviation: 0,
    continuationBetCallDeviation: 0,
    bluffFrequencyDeviation: 0,
    allInCallDeviation: 0,
    confidenceScore: 0.1,
    lastUpdatedHand: 0,
  };
}

// Decay confidence when opponent hasn't been seen in recent hands
export function applyConfidenceDecay(
  profile: TendencyProfile,
  currentHand: number,
  decayRate: number
): TendencyProfile {
  const handsSince = currentHand - profile.lastUpdatedHand;
  if (handsSince <= 10) return profile;
  const decayed = profile.confidenceScore * Math.pow(decayRate, handsSince - 10);
  return { ...profile, confidenceScore: Math.max(0, decayed) };
}

// Convert a tendency profile to exploit weight adjustments [fold, call, raise, allin]
export function profileToWeights(profile: TendencyProfile): [number, number, number, number] {
  const c = profile.confidenceScore;
  // If opponent over-folds to 3bets → we bluff more (reduce our fold weight, increase raise)
  // If opponent under-calls c-bets → increase our bet frequency
  const fold = clamp(-profile.foldToThreeBetDeviation * c * 0.5, -0.5, 0.5);
  const call = clamp(profile.continuationBetCallDeviation * c * 0.3, -0.5, 0.5);
  const raise = clamp(profile.bluffFrequencyDeviation * c * 0.4, -0.5, 0.5);
  const allIn = clamp(-profile.allInCallDeviation * c * 0.5, -0.5, 0.5);
  return [fold, call, raise, allIn];
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export class TendencyStore {
  private profiles = new Map<string, TendencyProfile>();

  get(opponentId: string): TendencyProfile {
    return this.profiles.get(opponentId) ?? emptyProfile(opponentId);
  }

  set(profile: TendencyProfile): void {
    this.profiles.set(profile.opponentId, profile);
  }

  applyDecay(currentHand: number, decayRate: number): void {
    for (const [id, profile] of this.profiles) {
      this.profiles.set(id, applyConfidenceDecay(profile, currentHand, decayRate));
    }
  }

  allProfiles(): TendencyProfile[] {
    return Array.from(this.profiles.values());
  }
}
