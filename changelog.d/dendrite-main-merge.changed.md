- Merged `main` at 0.22.1. The turn-routing rework (#314) is kept whole, and
  `speech.locus` decides what its addressed re-pin does: under
  `'latest-inbound'` a mid-turn addressed message or an *arrival* (one that
  landed between the turn's streams) moves the locus as 0.22.1 does; under
  `'delivery'` (the default) neither moves it, and an arrival that addressed
  the agent from another channel is announced at the turn's next start with
  the same `[routing] … addressed you from …` notice a tool boundary gives.
  The per-agent routing maps the Dendrite seam read (`turnLocusPins`,
  `turnEngagedChannels`) are gone with the rework; the seam reads the turn's
  `TurnRouting`. `conversationAgentHomes` and `sharedSlotAgents` are answered
  by the agent registry (`homeChannel`, `readsSharedSlot`).
