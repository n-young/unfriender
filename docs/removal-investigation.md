# Removal integration status

Checked October 6, 2026. These are implementation leads, not enabled mutations. The production adapters continue to throw before sending any removal request.

## Shared safety contract

- Bind every action to the observed acting-account ID, session generation, stable target ID/key, and canonical profile URL.
- Perform a fresh exact-target relationship read immediately before dispatch.
- Serialize mutations with a minimum 15-second interval. A read-only 429/5xx may be retried with bounded exponential backoff; a mutation is issued once.
- Treat any error after mutation dispatch as `unknown`. Reconcile via an independent read and never retry automatically.
- Enable a platform only after one user-selected test relationship is removed once and verified absent.

## LinkedIn

Source inspected: `mguttmann/linkedin-internal-api` at `4110552e08c310188a628b427733d9ff3a7e813c`.

- Candidate request: `POST /flagship-web/rsc-action/actions/server-request?sduiid=com.linkedin.sdui.mynetwork.RemoveConnectionVanityName`.
- Candidate payload binds `disconnectVanityName`, first name, last name, and `closeCurrentMenuOnCompletion` under the SDUI `serverRequest` envelope.
- Required next step: capture the owner's current request/token headers for one exact vanity target, then verify absence from an independent connection-state read.

## Facebook

Source inspected: `nhatvu2003/unofficial-fb-api` at `a2cf5838c2b59996c5bab0ca5391ee89b91fbce9`.

- Candidate request: `POST https://www.facebook.com/ajax/profile/removefriendconfirm.php`.
- Candidate form binds the numeric `uid` plus the acting account's current `fb_dtsg`, `jazoest`, `lsd`, and request metadata.
- Required next step: ensure discovery stores numeric IDs for the selected target, capture the owner's current web request, and verify the friend state independently. Vanity-only targets are not eligible for mutation.

## Instagram

Source inspected: `dilame/instagram-private-api` friendship repository, plus the owner's current read-only web session.

- Candidate request: `POST /api/v1/friendships/destroy/<numeric-user-id>/`.
- Current discovery already uses numeric IDs and the observed web following cursor endpoint.
- Live canary: one explicitly authorized staged target was unfollowed once through the current web UI and independently verified with `GET /api/v1/friendships/show/<numeric-user-id>/` returning `following: false`.
- Proven fallback selectors: exact `Following` text inside its nearest native button, followed by exact `Unfollow` text inside the single dialog's nearest `role=button` element.
- The mutation response did not match the expected REST paths and was not captured. The browser fallback is verified; a direct HTTP adapter is not. Do not assume the older mobile client's signed form is accepted by the current web session.
- `scripts/live-test-instagram-removal.ts` is a guarded one-target diagnostic. It requires an exact handle, a matching draft or one-member paused batch, a 10-second grace window, one dispatch, and independent reconciliation.
