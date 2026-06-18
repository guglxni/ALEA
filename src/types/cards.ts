export type Rank = "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "T" | "J" | "Q" | "K" | "A";
export type Suit = "s" | "h" | "d" | "c";
export type Card = `${Rank}${Suit}`;

export type Street = "preflop" | "flop" | "turn" | "river" | "showdown";

export type ActionType = "fold" | "call" | "raise" | "all-in" | "check";

export interface RaiseAction {
  type: "raise";
  sizeFraction: 0.5;
  amount?: number;
}

export interface SimpleAction {
  type: "fold" | "call" | "all-in" | "check";
}

export type Action = SimpleAction | RaiseAction;

// Short-deck removes 2s, 3s, 4s, 5s
export const SHORT_DECK_REMOVED_RANKS: Rank[] = ["2", "3", "4", "5"];

export function isShortDeckCard(card: Card): boolean {
  const rank = card[0] as Rank;
  return !SHORT_DECK_REMOVED_RANKS.includes(rank);
}

export function buildDeck(shortDeck: boolean): Card[] {
  const ranks: Rank[] = shortDeck
    ? ["6", "7", "8", "9", "T", "J", "Q", "K", "A"]
    : ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
  const suits: Suit[] = ["s", "h", "d", "c"];
  const deck: Card[] = [];
  for (const rank of ranks) {
    for (const suit of suits) {
      deck.push(`${rank}${suit}` as Card);
    }
  }
  return deck;
}
