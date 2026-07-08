# Project Rules

Operating guidelines for this repository. Follow them in every change.

## Writing and Output

- Use real icons where icons belong. Never substitute emojis for icons in UI, docs, or code.
- Do not use emdashes. Do not use double hyphens as a substitute.
- Avoid formulaic AI phrasing. Write plainly and directly, the way a human engineer would.
  - No "it's worth noting", "in today's fast-paced world", "delve", "leverage" as filler, "seamless", "robust" as reflexive adjectives.
  - No unprompted summaries, no restating the question back, no hedging boilerplate.

## Code Structure

- No monolithic files. Split large files into focused units.
- Separate concerns deliberately. Keep data, logic, and presentation in distinct layers.
- Favor small, composable modules over sprawling catch-all files.
- Each module has one clear responsibility and a narrow public surface.

## Quality

- Write well-tested code. Cover the meaningful paths, edge cases, and failure modes.
- Keep tests close to the behavior they verify and runnable in isolation.

## Documentation

- Maintain a proper README with setup, usage, and architecture overview.
- Document public interfaces and non-obvious decisions where they live.
- Keep docs current with the code they describe.

## Git

- Never add AI attribution to commits.
- Never credit Claude, or any AI tool, as an author or co-author.
- Write commit messages as the human author, describing the change and its intent.
