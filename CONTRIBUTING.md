# Contributing to SoloSheet

Thank you for considering a contribution.

## Development workflow

1. Fork the repository and create a focused branch.
2. Follow the setup instructions in `README.md` using placeholder or local-only
   credentials.
3. Keep provider calls and secrets on the server, validate external input at
   runtime, and preserve user ownership checks.
4. Add or update focused tests and documentation for non-obvious behavior.
5. Run `npm run check`, `npm run build`, and `git diff --check` before opening a
   pull request.

Database changes require a forward migration, a documented execution order, and
authorization/grant review for every security-definer function. Do not include
real user data, lecture materials, credentials, signed URLs, generated browser
state, or screenshots containing private data.

By contributing, you agree that your contribution is licensed under the MIT
License in this repository.
