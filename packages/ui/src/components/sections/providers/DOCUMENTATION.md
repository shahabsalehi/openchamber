# Provider Settings

`WebV2CredentialSettings` owns the optional managed-credential UI on the Providers Settings page.

- It renders only when `RuntimeAPIs.webV2` is available and calls only the typed `WebV2API` methods.
- Credential values are write-only, component-local password state. Do not add them to stores, persistence, URLs, toasts, logs, errors, or metadata rendering.
- Metadata refreshes are demand-driven while the section is visible. Failed refreshes retain the most recent successful metadata; an initial failure remains an error, not an empty list.
- Rotate, revoke, and delete use the metadata generation as optimistic-concurrency input. Revoke and delete require explicit dialog confirmation.
