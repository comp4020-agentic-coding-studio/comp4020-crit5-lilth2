# Crit 5 reflection

The breakthrough was refusing to trust my own read of the code as evidence
that the opening screen worked. I'd written `game.ts` so every gameplay number
was resolution-independent — fractions of canvas width and height, screen
widths of travel — specifically so the level would look and feel the same on
a phone and a desktop. That gave me false confidence: the numbers were
internally consistent, so I assumed the *result* was too. It wasn't. The first
spike sat at 1.35 screens out, which is arithmetically fine but happens to be
outside the roughly 0.84 screens actually visible from the ball's fixed
position while the world is frozen at rest. Nothing in the code was wrong;
the game was simply invisible at the one moment — the very first frame a
stranger sees — where the whole "no tutorial" premise depends on it not
being. I only found this by driving a real browser at the real marking
viewports and looking at the screenshot, not by re-reading the file I'd
already convinced myself was correct.

That changes what I trust as "done." Passing tests and a clean typecheck told
me the rules were correct; they told me nothing about whether a stranger
would understand the first move in ten seconds, because that's a claim about
a rendered screen, not about logic. Going forward I want to treat "look at
the actual output, at the actual sizes it'll be judged at" as a required step
before any claim of correctness for user-facing behaviour, the same way I'd
treat a failing test — not an optional polish pass at the end, but part of
verifying the thing I said I built. The code being right and the experience
being right turned out to be two separate claims, and only one of them shows
up in a diff.
