# Platform adapter spike checklist

The checked-in real adapters intentionally fail closed. Do not turn one on until these steps are recorded for the owner's current account and a deliberately selected test relationship.

For each platform:

1. Run `npm run login -- <platform>` on the computer and complete login/MFA in the dedicated browser profile.
2. In browser developer tools, identify the acting account's stable ID and a paginated, read-only relationship-list request. Record request URL, method, minimum headers/tokens, response identity fields, cursor format, and checkpoint behavior. Redact all values.
3. Reproduce only the read request inside the persistent browser context. Validate profile URLs against the platform allowlist and upsert stable target IDs—not names.
4. Choose one exact, disposable test relationship. Show its stable ID and canonical URL before enabling mutation.
5. Capture or source-inspect the current removal request. Disable automatic retries. Issue it once, then use an independent read to verify the postcondition.
6. Restart the app and prove the persisted session can perform the read-only check again.
7. Implement that narrow request behind `PlatformAdapter`; set `verified = true` only for the verified path. Record whether it uses direct HTTP, browser-context requests, or a selector fallback.

Never log cookies, CSRF values, authorization headers, profile contents, or response bodies containing personal data. Challenges and CAPTCHA pause the adapter for manual recovery.
