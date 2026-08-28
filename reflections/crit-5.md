# Crit 5 reflection

The recurring lesson this week was the same one from last week, but it showed
up in a different place: I keep mistaking "the logic is correct" for "the
experience is correct," and they keep turning out to be separate claims. Last
week it was an off-screen spike; this week it was a player that vanished at
the exact moment the round ended. `game.ts`'s win/loss state was right the
whole time — the tests proved it, and a standalone script driving the real
level confirmed the win path's final value only barely clears the finish wall
because of bullet pre-damage, exactly as designed. None of that told me
anything about what a marker would actually see. Only a real screenshot,
polled from the game's own live state at the instant a round resolved, showed
that the player's digit had already returned early and left nothing on
screen but a flash tint and the finish walls — no smash, no crash, no payoff.

What's different this time is that I'd already internalized "look at the
actual rendered output before calling it done" as a required step, not an
afterthought — I did the Playwright pass specifically because last week
taught me passing tests don't cover it. But internalizing the *rule* wasn't
enough on its own; the bug still slipped through the first rendering pass,
because the rule only catches what you think to check, and "does the game
still show a player at the one moment that matters most" wasn't on my list
until the screenshot forced it onto it. The actual discipline I want to keep
building isn't "screenshot the opening frame" as a fixed checklist item — it's
asking, for every state the game can be in, whether I've actually looked at
that state rendered, not just proven it's reachable. Win and loss are as core
to this game as the opening frame was to last week's, and I nearly shipped
without ever looking at either.

The other habit that paid off, and that I want to keep: driving the game's
own real logic (`step()`, the real `OBSTACLES` table) from a plain script
before opening a browser at all, rather than eyeballing numbers or trusting a
mental model of the level. That's what let me tell, with a printed number
instead of a guess, that a level change was fair before ever spending time on
a screenshot to confirm it — the browser pass is for catching what logic
alone can't show you, not for finding out whether the numbers add up in the
first place.
