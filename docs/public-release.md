# Public repository release checklist

Use this only after the working tree changes have been reviewed and committed.
History rewriting changes every affected commit ID and requires a force push.
Make a separate backup clone before starting and coordinate with any
collaborators, who must re-clone afterward.

## Sanitize in a fresh mirror clone

Install `git-filter-repo` from its official distribution, then clone the private
repository into a temporary directory. Do not operate on the only local copy.

1. Remove every historical `Test_Files` object except the new synthetic fixture.
   The safest rule is to remove the old directory from all history, then add the
   synthetic fixture in the final sanitized commit.
2. Use a mailmap callback to replace the historical personal author and committer
   address with the repository owner's GitHub noreply address.
3. Replace any historical occurrences of the private administrator address in
   blobs with a non-routable example address, or drop obsolete blobs when they
   are not needed.
4. Delete rewrite backup refs and expire unreachable objects in the temporary
   clone.
5. Search all reachable history for the removed filenames and private address.
6. Run Gitleaks over all commits.

Exact commands depend on the installed `git-filter-repo` version. Review its
generated report and path analysis rather than copying an unverified force-push
command. Keep the allowlist narrow: example-domain test addresses are expected,
real credentials and personal addresses are not.

## Publish only the intended branch

Confirm `main` contains the license, policies, synthetic fixture, and security
changes. Push only sanitized `main` with `--force-with-lease`; do not use
`--mirror` or `--all`, because local topic and tool-created refs may still point
to unsanitized objects. Delete any old remote branches or tags separately after
reviewing them.

Set the repository-local commit email to the GitHub noreply address before the
next commit and verify both author and committer metadata. After the force push,
clone the remote into another clean directory, rerun the history searches and
Gitleaks there, and only then change repository visibility.
