---
description: Scan the codebase for deepening opportunities, present them as a visual HTML report, then grill through the one you pick
argument-hint: "[module, subsystem or pain point]"
---

# Improve Codebase Architecture

Surface architectural friction and propose **deepening opportunities** — refactors that turn shallow modules into deep ones. The aim is testability and AI-navigability.

Direction from the user: $ARGUMENTS

If that line is empty, no direction was given — infer the scope from git history in step 1.

## Vocabulary (use these terms exactly)

**Module** — anything with an interface and an implementation: function, class, package, tier-spanning slice. _Never_: component, service, unit.
**Interface** — everything a caller must know to use it correctly: signature, invariants, ordering, error modes, config, performance. _Never_: API, signature (too narrow).
**Implementation** — what is inside the module.
**Depth** — behaviour a caller or test can exercise per unit of interface learned. **Deep** = lots of behaviour, small interface. **Shallow** = interface nearly as complex as the implementation.
**Seam** — a place where behaviour can be altered without editing in that place; where a module's interface lives. _Never_: boundary.
**Adapter** — a concrete thing satisfying an interface at a seam.
**Leverage** — what callers get from depth: capability per unit of interface.
**Locality** — what maintainers get from depth: change, bugs and verification concentrate in one place.

Principles: depth is a property of the interface, not the implementation · **the deletion test** — if deleting the module makes complexity vanish it was a pass-through; if complexity reappears across N callers it earned its keep · **the interface is the test surface** · **one adapter = hypothetical seam, two = real one**.

Full reference: `~/.pi/agent/prompts/improve-codebase-architecture/CODEBASE-DESIGN.md` (dependency categories, seam discipline, design-it-twice).

## Process

### 1. Explore

**Scope before you scan — YAGNI.** Deepening pays off on code that keeps changing, so weight recently-touched areas.

- If the user named a direction above, take it and skip the inference.
- Otherwise walk back a good stretch of `git log --oneline` to find hot spots — files and areas that keep coming up — and let those paths pull your attention first. If changes are scattered with no clear hot spot, widen the net.

Read the domain glossary (`CONTEXT.md`, or `CONTEXT-MAP.md` for multi-context repos) and any ADRs in `docs/adr/` covering the area you are touching before you form opinions.

Then use the `subagent` tool (the `research` agent is a good fit) to walk the codebase — one subagent per area you scoped, in parallel. Don't follow rigid heuristics; explore organically and note where you feel friction:

- Where does understanding one concept require bouncing between many small modules?
- Where are modules **shallow** — interface nearly as complex as the implementation?
- Where were pure functions extracted just for testability, while the real bugs hide in how they're called (no **locality**)?
- Where do tightly-coupled modules leak across their seams?
- Which parts are untested, or hard to test through their current interface?

Apply the **deletion test** to anything you suspect is shallow. "Concentrates complexity" is the signal you want.

### 2. Present candidates as an HTML report

Write a self-contained HTML file to the OS temp dir so nothing lands in the repo: `${TMPDIR:-/tmp}/architecture-review-<timestamp>.html`. Open it with `xdg-open` and tell the user the absolute path.

Tailwind + Mermaid via CDN. Each candidate gets a **before/after visualisation** — Mermaid where relationships are graph-shaped, hand-built divs/SVG for the editorial visuals. Be visual.

Each candidate card: **Files** · **Problem** (one sentence) · **Solution** (one sentence) · **Wins** (bullets in glossary terms) · **Before/After diagram** (the centrepiece) · **Recommendation strength** badge (`Strong`, `Worth exploring`, `Speculative`) · dependency-category tag. End the report with a **Top recommendation** section.

Use `CONTEXT.md` vocabulary for the domain and the glossary above for the architecture. If `CONTEXT.md` defines "Order", say "the Order intake module" — not "the FooBarHandler", not "the Order service".

**ADR conflicts**: only surface a candidate that contradicts an ADR when the friction is real enough to warrant reopening it, and mark it in an amber callout (_"contradicts ADR-0007 — but worth reopening because…"_). Don't list every refactor an ADR forbids.

Read `~/.pi/agent/prompts/improve-codebase-architecture/HTML-REPORT.md` before writing the file — it has the scaffold, diagram patterns, and tone rules.

Do NOT propose interfaces yet. After the file is written, ask: "Which of these would you like to explore?"

### 3. Grilling loop

Once the user picks a candidate, interview them relentlessly until you reach shared understanding. Map it as a **design tree**: every decision branches into the decisions hanging off it — constraints, dependency category, the shape of the deepened module, what sits behind the seam, which tests survive.

Work in **rounds**. The **frontier** is every decision whose prerequisites are settled. Ask the whole frontier in one round, numbered, each with your recommended answer, then wait:

```
❓ **Q1** - **<question title>**: <question body, may include options>

➡️ <your recommended answer>
```

Answers reshape the tree — recompute the frontier and ask the next round. A question that depends on another still-open question belongs to a later round. Finding *facts* is your job: dispatch a `subagent` rather than asking the user anything you could look up, and don't block the rest of the frontier on it. The *decisions* are the user's. Done when the frontier is empty. Do not start implementing until the user confirms shared understanding.

Side effects happen inline as decisions crystallize (formats: `~/.pi/agent/prompts/improve-codebase-architecture/DOMAIN-MODEL.md`):

- **Naming a deepened module after a concept not in `CONTEXT.md`?** Add the term, creating the file lazily.
- **Sharpening a fuzzy term mid-conversation?** Update `CONTEXT.md` right there.
- **User rejects the candidate with a load-bearing reason?** Offer an ADR: _"Want me to record this as an ADR so future architecture reviews don't re-suggest it?"_ Only when a future explorer would need that reason — skip ephemeral ("not worth it now") and self-evident ones.
- **Want alternative interfaces for the deepened module?** Use the design-it-twice parallel-subagent pattern in `CODEBASE-DESIGN.md`.
