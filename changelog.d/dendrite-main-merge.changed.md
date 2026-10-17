- Merged `main` at 0.22.1. The turn-routing rework (#314) is kept whole, and
  `speech.locus` decides what its addressed re-pin does: under
  `'latest-inbound'` a mid-turn addressed message or an *arrival* (one that
  landed between the turn's streams) moves the locus as 0.22.1 does; under
  `'delivery'` (the default) neither moves it, and an arrival that addressed
  the agent from another channel is announced at the turn's next start with
  the same `[routing] … addressed you from …` notice a tool boundary gives,
  naming which start it is: a provider hold, a re-inference on tool
  results, a budget restart or a retry.
  The per-agent routing maps the Dendrite seam read (`turnLocusPins`,
  `turnEngagedChannels`) are gone with the rework; the seam reads the turn's
  `TurnRouting`. `conversationAgentHomes` and `sharedSlotAgents` are answered
  by the agent registry (`homeChannel`, `readsSharedSlot`).
- Merged `main` at 0.22.2. Where main's deferred-write rework (#286) meets
  the Dendrite seam: at a tool boundary, a message held from the residents
  (`tuneOut.heldFromResidents`) is stored with the boundary's other drained
  writes, as before, and left out of the injection, since the next compile
  hides it; a message that can't join the stream waits for the turn's end,
  as main has it, and "the agent's own voice" there is every participant
  the agent presents as, a derived agent's inherited voice included, not
  its name alone. Held agent mail (`sendAgentMessage`, `deliverAgentResult`)
  is released at each of the three sites that now store a deferred write:
  the tool boundary, the turn-start flush and `addMessage`. An arrival's
  record carries `addressed`, so main's new arrival tests read it. The
  all-except hold's timers and option reading follow #444 (see the
  all-except entry). `ProviderWaitNotSleptError` (main) is exported beside
  `AgentStoppedError` and `DeriveAgentOptions` (the branch).
