# Issue tracker: Linear

Issues and specifications for this repository live in the `DONGWOO` team in the Development Linear workspace:

- Workspace: `https://linear.app/dongwoojeong`
- Team key: `DONGWOO`
- Issue identifiers: `DONGWOO-<number>`

Use the connected Linear app for all issue operations. The source host is not this repository's engineering request surface.

## Conventions

- Create issues in team `DONGWOO` with a Markdown description.
- Fetch issues by identifier, including comments and relations when relevant.
- Preserve unrelated labels when updating an issue.
- Apply `ready-for-agent` to fully specified implementation tickets.
- Use Linear's native `blockedBy` relation for dependencies.
- Add completion evidence before moving an issue to the team's completed state.

## Skill operations

When a skill says to publish to the issue tracker, create a Linear issue in team `DONGWOO`. When it says to fetch a ticket, retrieve the `DONGWOO-<number>` issue with its comments and relevant relations.

For wayfinding, use one `wayfinder:map` issue with child issues labelled by type. A frontier ticket is open, unassigned, and has no incomplete native blocker. Claim it by assigning it to the current user before doing implementation work.
