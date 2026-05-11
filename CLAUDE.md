# AI Assistant Notes

This public repository contains the Aomori Snow Tracker static app and data
pipeline scripts.

## Repository Layout

- `docs/` - Firebase Hosting static site and public data files
- `scripts/` - Python data collection and transformation scripts
- `data/` - source and intermediate data used by the pipeline
- `.github/workflows/` - scheduled data update and deployment workflows

## Public Repository Rules

- Do not commit API keys, tokens, service account JSON, cookies, or credentials.
- Do not commit private spreadsheet URLs, internal repository names, or local
  operational playbooks.
- Use GitHub Actions secrets or variables for environment-specific values.
- Keep generated cache files, virtual environments, and temporary logs out of git.
- Review workflow changes carefully before enabling broad write operations.

## Development Notes

- The frontend is served from `docs/index.html`.
- Public runtime data used by the frontend lives under `docs/data/`.
- Scripts should prefer repository-relative paths over local absolute paths.
- Before committing generated data, check that the files are intended to be
  public and needed by the deployed app.

## Collaboration

AI-generated code and documentation should be reviewed before merging. Keep
changes small, explain what commands were run, and avoid unrelated cleanup in
security or data-pipeline PRs.
