# Domain Model Files

Formats for the inline side effects of `/improve-codebase-architecture`: keeping `CONTEXT.md` current and recording ADRs. Create files lazily — only when there is something to write.

## Layout

Most repos have a single context: `CONTEXT.md` at the root, ADRs in `docs/adr/0001-slug.md`. If a `CONTEXT-MAP.md` exists at the root, the repo has multiple contexts and the map points to where each lives (e.g. `src/ordering/CONTEXT.md` with its own `src/ordering/docs/adr/`, plus root `docs/adr/` for system-wide decisions). Infer which context the current topic belongs to; if unclear, ask.

## CONTEXT.md format

```md
# {Context Name}

{One or two sentences on what this context is and why it exists.}

## Language

**Order**:
{One or two sentence description of the term}
_Avoid_: Purchase, transaction

**Customer**:
A person or organization that places orders.
_Avoid_: Client, buyer, account
```

Rules:

- **Be opinionated.** When several words exist for one concept, pick the best and list the rest under `_Avoid_`.
- **Keep definitions tight.** One or two sentences. Define what it IS, not what it does.
- **Only project-specific terms.** General programming concepts (timeouts, error types, utility patterns) don't belong, however heavily used.
- **Group under subheadings** when natural clusters emerge; a flat list is fine otherwise.
- `CONTEXT.md` is a glossary and nothing else — no implementation details, no spec, no scratch pad.

## CONTEXT-MAP.md format

```md
# Context Map

## Contexts

- [Ordering](./src/ordering/CONTEXT.md) — receives and tracks customer orders
- [Billing](./src/billing/CONTEXT.md) — generates invoices and processes payments

## Relationships

- **Ordering → Fulfillment**: Ordering emits `OrderPlaced`; Fulfillment consumes them to start picking
- **Ordering ↔ Billing**: Shared types for `CustomerId` and `Money`
```

## ADR format

Sequential numbering in `docs/adr/`: scan for the highest existing number and increment.

```md
# {Short title of the decision}

{1-3 sentences: what's the context, what did we decide, and why.}
```

That's it — an ADR can be one paragraph. The value is recording *that* a decision was made and *why*. Optional sections only when they earn their place: `Status` frontmatter (`proposed | accepted | deprecated | superseded by ADR-NNNN`), **Considered Options** when rejected alternatives are worth remembering, **Consequences** when downstream effects are non-obvious.

## When to write an ADR

All three must hold:

1. **Hard to reverse** — changing your mind later costs something meaningful.
2. **Surprising without context** — a future reader will wonder "why on earth did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons.

Qualifies: architectural shape · integration patterns between contexts · technology choices carrying lock-in · ownership and scope decisions (the explicit no-s as much as the yes-s) · deliberate deviations from the obvious path · constraints invisible in the code · non-obvious rejected alternatives.

In this command the common case is the third bullet of the grilling loop: the user rejects a candidate for a load-bearing reason, and the ADR exists to stop a future architecture review re-suggesting it.
