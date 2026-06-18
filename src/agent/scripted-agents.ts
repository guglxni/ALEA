/**
 * Scripted agents for M3 loop validation (no blueprint required).
 * Call-station: always calls, never folds.
 * Tight-aggressive: raises premium hands, folds marginal ones.
 */
import { HandContext } from "../types/game-state";
import { Action, Card } from "../types/cards";
import { preflopHandBucket } from "../blueprint/bucketing";

export interface ScriptedAgent {
  decide(ctx: HandContext): Action;
}

export class CallStationAgent implements ScriptedAgent {
  decide(_ctx: HandContext): Action {
    return { type: "call" };
  }
}

export class TightAggressiveAgent implements ScriptedAgent {
  decide(ctx: HandContext): Action {
    if (ctx.street !== "preflop") {
      // Postflop: call if strong (equity > 0.5 rough proxy: facing < half pot), else fold
      const potOdds = ctx.potOdds;
      return potOdds < 0.35 ? { type: "call" } : { type: "fold" };
    }

    const bucket = preflopHandBucket(ctx.holeCards);
    if (bucket <= 1) {
      // Premium / strong — raise
      return { type: "raise", sizeFraction: 0.5 };
    }
    if (bucket <= 3) {
      // Good / playable — call
      return { type: "call" };
    }
    // Marginal / weak / trash — fold
    return { type: "fold" };
  }
}
