# Paracord Design Language — superseded

**The visual contract is [`docs/lantern-stage-spec.md`](lantern-stage-spec.md)
("Lantern Stage").** This file used to hold "Emerald Commons", the v1 system:
a warm-neutral green-black ramp, a single emerald spent on meaning, Fraunces
headings, glass rails, and status-colored presence dots. Every one of those
decisions was replaced by the v2 overhaul (WP0–WP8 on `design/lantern-stage`),
so its recipes would now mislead anyone who followed them. It is kept as this
pointer rather than deleted because other documents, checkpoints and commit
messages link to it by name.

What carried over is stated in the new contract rather than here: §6.10 keeps
the parts of the old kill-list that v2 does not supersede — buttons solid and
tactile, empty states left-aligned with an action, density matched to the
surface, intentional rhythm — and "consume tokens, never hard-code hex" is now
enforced by `client/scripts/literal-colour-audit.mjs` across the whole client.
The IA contract is still [`docs/layout-spec.md`](layout-spec.md), amended by the
new spec wherever the two disagree; its §7 names the v2 components. Token
definitions live in `client/src/styles/tokens.css` and the primitive recipes in
`client/src/styles/primitives.css`; `/design-tokens` renders every one of them
in every theme.
