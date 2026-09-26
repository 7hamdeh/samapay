# pay.mntad.com — API v1

USDT payments on **TRC20** (Tron) and **BEP20** (BNB Smart Chain) for merchants. You get crypto
addresses, SamaPay watches the chains, and you get a signed webhook for every confirmed deposit.
Money you receive becomes your **gateway balance** at SamaPay.

- Base URL: `https://pay.mntad.com/v1`
- JSON in and out (`Content-Type: application/json`), UTF-8.
- Timestamps are ISO-8601 UTC strings, e.g. `2026-09-25T12:00:00.000Z`.
- **Money is always a decimal string**, never a number: `"12.5"`, `"0.000001"`. Currency is always
  `USDT`, with at most 6 decimals.
- Every response carries an `X-Request-Id` header. Every error body repeats it as `request_id`.
  Quote it when you contact support: [noreply@mntad.com](mailto:noreply@mntad.com).

This file is checked against the code by `scripts/verify-api-docs.ts`. Every route, status, error
code, event type, header and constant below is compared with `src/`, so the two cannot drift.

---

## 1. Authentication

```
Authorization: Bearer sk_live_<40 characters>
```

- One key belongs to exactly one account (your *client*). The account is **always** taken from the
  key, never from a request field.
- Everything you create (addresses, payment intents, deposits, events) belongs to your account, not to
  the key. After a key rotation, the new key sees all of it.
- `sk_test_…` keys work only on non-production deployments. In production they are refused with
  `401 invalid_key`.
- Keep the key on your server. Never ship it to a browser or an app.

### Scopes

A key carries a set of scopes, and each route needs one of them:

| Scope | Allows |
|---|---|
| `payment_intents.write` | `POST /v1/payment-intents` |
| `payment_intents.read` | `GET /v1/payment-intents`, `GET /v1/payment-intents/:id` |
| `addresses.write` | `POST /v1/addresses` |
| `deposits.read` | `GET /v1/deposits`, `GET /v1/deposits/:id` |
| `events.read` | `GET /v1/events/:id` |
| `balance.read` | `GET /v1/balance` |

A missing scope gets `403 insufficient_scope`, and `error.details.required` names the scope.

---

## 2. Errors

```json
{ "error": { "code": "amount_out_of_range", "message": "…", "request_id": "req_…", "details": { } } }
```

Branch on `code`. `message` is English text for humans, and it may change.

| HTTP | code | When |
|---|---|---|
| 400 | `invalid_json` | The body is not JSON. |
| 400 | `idempotency_key_required` | A POST without a valid `Idempotency-Key` (1–255 printable ASCII characters). |
| 400 | `validation_failed` | Wrong shape. `details.fields` lists the fields. |
| 401 | `unauthenticated` | `Authorization` is missing or malformed. |
| 401 | `invalid_key` | Unknown key, wrong secret, or a test key in production. |
| 401 | `key_revoked` | The key was revoked. `details.successor` is the last 4 characters of its successor, if one exists. |
| 403 | `insufficient_scope` | `details.required` names the missing scope. |
| 404 | `not_found` | Unknown id **or an object of another account**. The two cases get the same answer. |
| 409 | `idempotency_payload_mismatch` | The same `Idempotency-Key` was used with a different body. |
| 409 | `idempotency_in_progress` | The first request with this key is still running. Retry after about 1 s. |
| 409 | `reference_conflict` | A payment intent with this `reference` already exists with a different amount or chain. |
| 422 | `amount_out_of_range` | Amount ≤ 0, more than 6 decimals, or outside your account's min/max. |
| 422 | `unsupported_chain` | The chain is not `TRC20`/`BEP20`, or it is not enabled for your account. |
| 422 | `reference_invalid` | The reference's length or characters are not allowed (see each flow). |
| 429 | `rate_limited` | Too many requests. Wait for the number of seconds in the `Retry-After` header. |
| 503 | `derivation_unavailable` | No address can be derived right now. **Nothing was created**, so retry later. |
| 503 | `chain_unavailable` | The chain layer is unavailable. Nothing was created. |
| 500 | `internal` | Our fault. It is logged under `request_id`. |

---

## 3. Idempotency (every POST)

Send `Idempotency-Key: <1–255 printable ASCII characters>` on **every** POST. Keys are scoped to (your
key, Idempotency-Key) and kept for **24 hours**.

- **Same key, same body:** you get the **original** status and body, byte for byte, plus the header
  `Idempotent-Replayed: true`. The comparison uses the JSON content, so key order and whitespace do not
  matter.
- **Same key, different body:** `409 idempotency_payload_mismatch`.
- **Same key while the first request is still running:** `409 idempotency_in_progress`. Retry shortly.
- **The first attempt got a 5xx:** nothing was stored against the key, so retry **with the same key**.

A replay returns the answer as it was *then*. Read the current state with a GET.

---

## 4. Rate limits

- Each key has a per-second limit (default **10 requests/s**). Above it you get `429 rate_limited` with
  `Retry-After`.
- Repeated **failed** authentications for one key are braked: after 10 failures that key answers `429`
  until the brake recovers (1 per second). This applies even to correct requests while it lasts. Do
  not retry with a wrong key.

---

## 5. Objects

### PaymentIntent

```json
{
  "id": "pi_3f9c…",
  "object": "payment_intent",
  "status": "requires_payment",
  "amount": "12.5",
  "amount_received": "0",
  "fee_amount": "0",
  "currency": "USDT",
  "chain": "TRC20",
  "address": "T…",
  "reference": "order-1042",
  "tx_hashes": [],
  "confirmations_required": 19,
  "expires_at": "2026-09-25T13:00:00.000Z",
  "created_at": "2026-09-25T12:00:00.000Z",
  "succeeded_at": null,
  "expired_at": null
}
```

- `amount_received` is the sum of the **confirmed** deposits to the intent's address, and it can
  exceed `amount`. `tx_hashes` lists those deposits.
- `fee_amount` is the sum of the fees charged on those deposits. It comes out of **your gateway
  balance**, never out of the amount the payer sent.

Statuses:

| status | Meaning |
|---|---|
| `requires_payment` | Waiting for a transfer. |
| `processing` | A transfer was seen but has not reached the confirmation depth yet. |
| `succeeded` | Confirmed deposits reached `amount` in time. Overpayment is allowed (`amount_received` > `amount`). |
| `succeeded_late` | The amount was completed **after** `expires_at`. |
| `expired` | Expired with nothing received. |
| `expired_partial` | Expired with less than `amount` received. |

- **On time or late** is decided by when the completing transfer was **detected**, not by when it
  confirmed. A payment sent in time that is still confirming keeps the intent `processing` past
  `expires_at`.
- `succeeded` and `succeeded_late` are final. An `expired` or `expired_partial` intent can still become
  `succeeded_late` if a late payment completes the amount.
- **No money is lost.** Every confirmed deposit, early, late, partial or extra, produces its own
  `deposit.confirmed` event.

### Deposit

```json
{
  "id": "dep_cm8x…",
  "object": "deposit",
  "status": "confirmed",
  "chain": "TRC20",
  "tx_hash": "a1b2…",
  "amount": "12.5",
  "confirmations": 20,
  "address": "T…",
  "reference": "order-1042",
  "payment_intent_id": "pi_3f9c…",
  "detected_at": "2026-09-25T12:03:10.000Z",
  "confirmed_at": "2026-09-25T12:04:05.000Z"
}
```

- Statuses: `detected`, then `confirmed`. A detected transfer that a chain reorganisation removed
  becomes `orphaned`. It never confirms and never counts.
- One deposit exists per on-chain transfer. `(chain, tx_hash)` is unique.
- `reference` depends on where the money went:
  - intent deposit: the **intent's** `reference`;
  - top-up address: the **address's** `reference`.
- `payment_intent_id` is `null` for a top-up address.
- Only the `dep_…` form of `id` is accepted anywhere.

### Amounts, dust, confirmations

- On-chain amounts are **truncated (rounded down) to 6 decimals** when they are recorded.
- A transfer that truncates to `0` (dust) is not a payment. It never moves an intent to
  `processing`.
- A deposit is `confirmed` at this depth:

| Chain | Confirmations |
|---|---|
| TRC20 | 19 |
| BEP20 | 15 |

The intent's `confirmations_required` field reports the same number.

---

## 6. Flow 1: one payment, one address (payment intents)

Use this for checkout: a fixed amount with an expiry, on a fresh address that is never reused.

`POST /v1/payment-intents`, scope `payment_intents.write`.

| Field | Rule |
|---|---|
| `amount` | Decimal string, > 0, ≤ 6 decimals, within your account's min/max (default 1 … 10000). |
| `chain` | `TRC20` or `BEP20`. |
| `reference` | **Your** id for this payment: 1–200 characters of `[A-Za-z0-9:_-]`. |
| `expires_in_sec` | Optional, 300 … 604800. Default 3600. |

```bash
curl -s https://pay.mntad.com/v1/payment-intents \
  -H "Authorization: Bearer $SAMAPAY_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-1042" \
  -d '{"amount":"12.5","chain":"TRC20","reference":"order-1042"}'
```

- `201`: a new intent. Show the payer `address`, the **exact** `amount` and `expires_at`.
- **One intent per `reference`:** posting the same reference again (even with a new Idempotency-Key)
  gives the existing intent:
  - same `amount` and `chain`: `200` with the existing intent;
  - different `amount` or `chain`: `409 reference_conflict`.

Reading intents:

- `GET /v1/payment-intents/:id` (scope `payment_intents.read`) returns one intent.
- `GET /v1/payment-intents` lists intents, newest first, as `{ "object": "list", "data": [...], "has_more": bool }`.
  Query parameters: `reference`, `status`, `limit` (1–100, default 10) and `starting_after` (an intent id).

What arrives by webhook:

- one `deposit.confirmed` per confirmed transfer to the intent's address;
- `payment_intent.succeeded` once, when the intent becomes `succeeded` or `succeeded_late`;
- `payment_intent.expired` once, when it becomes `expired` or `expired_partial`.

Read `data.object.status` to tell the variants apart. **Credit on `deposit.confirmed`**, and use the
intent events only for status and UX.

---

## 7. Flow 2: a permanent address per customer (top-up)

Use this for wallets and balances: each customer gets one address for life and can send any amount at
any time.

`POST /v1/addresses`, scope `addresses.write`.

| Field | Rule |
|---|---|
| `chain` | `TRC20` or `BEP20` (enabled for your account). |
| `reference` | `client:tenant:kind:id`: four non-empty segments of at most 64 characters, with no `:`, whitespace or control characters inside a segment. Example: `acme:shop1:user:42`. |

```bash
curl -s https://pay.mntad.com/v1/addresses \
  -H "Authorization: Bearer $SAMAPAY_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: addr-acme-shop1-user-42-trc20" \
  -d '{"chain":"TRC20","reference":"acme:shop1:user:42"}'
```

```json
{ "object": "address", "chain": "TRC20", "address": "T…", "reference": "acme:shop1:user:42" }
```

- `201`: the address was just issued.
- `200`: this `(chain, reference)` already had one, and you get **the same address**, every time, from
  any of your keys.
- Every confirmed transfer to it produces one `deposit.confirmed`, with
  `data.object.reference` = your reference and `payment_intent_id: null`.

---

## 8. Reading

| Route | Scope | Returns |
|---|---|---|
| `GET /v1/deposits` | `deposits.read` | `{ "object": "list", "data": [Deposit], "has_more": bool }`, oldest first. Query: `reference`, `payment_intent_id`, `since` (ISO-8601), `limit` (1–100, default 100). |
| `GET /v1/deposits/:id` | `deposits.read` | One Deposit (`dep_…`). |
| `GET /v1/events/:id` | `events.read` | One Event, exactly as it was delivered. |
| `GET /v1/balance` | `balance.read` | Your gateway balance (below). |
| `GET /v1/health` | none | Service status. |

`GET /v1/balance`:

```json
{
  "object": "balance",
  "currency": "USDT",
  "chains": { "TRC20": { "available": "15.75", "pending": "0" }, "BEP20": { "available": "0", "pending": "0" } },
  "fee_bps": 0
}
```

- `available` = confirmed deposits − fees − withdrawals.
- `pending` = detected deposits that are not confirmed yet.
- `fee_bps` is your current fee rate, in basis points.

---

## 9. Webhooks

SamaPay POSTs each event to your webhook URL (https, set when your key is issued).

### Event

```json
{
  "id": "evt_…",
  "object": "event",
  "api_version": "2026-09-24",
  "type": "deposit.confirmed",
  "created_at": "2026-09-25T12:04:05.000Z",
  "data": { "object": { "id": "dep_…", "object": "deposit" } }
}
```

- Types: `deposit.confirmed`, `payment_intent.succeeded`, `payment_intent.expired`.
- `data.object` is the Deposit or PaymentIntent **as it was when the event happened**.

### Headers

- `X-SamaPay-Event`: the event type.
- `X-SamaPay-Delivery`: the delivery id.
- `X-SamaPay-Signature`: `t=<unix seconds>,v1=<hex>[,v1=<hex>…]`.

The signature is `v1 = HMAC-SHA256(secret, "<t>.<raw body>")`, in hex. `secret` is your whole
`whsec_…` string. During a secret rotation there can be several `v1` values; accept the request if
**any** of them matches.

### Verify (Node)

```js
import { createHmac, timingSafeEqual } from "node:crypto";

// rawBody: the EXACT bytes you received (not re-serialised JSON). secrets: your current whsec_… (and the previous one during a rotation).
export function verifySamaPay(rawBody, header, secrets, now = Math.floor(Date.now() / 1000)) {
  const parts = String(header ?? "").split(",").map((p) => p.trim());
  const ts = parts.filter((p) => p.startsWith("t="));
  if (ts.length !== 1 || !/^t=\d{1,12}$/.test(ts[0])) return false;
  const t = Number(ts[0].slice(2));
  if (Math.abs(now - t) > 300) return false;                       // replay window: 300 s
  const given = parts.filter((p) => /^v1=[0-9a-f]{64}$/.test(p)).map((p) => Buffer.from(p.slice(3), "hex"));
  let ok = false;
  for (const s of secrets) {
    const expected = createHmac("sha256", s).update(`${t}.${rawBody}`).digest();
    for (const g of given) if (g.length === expected.length && timingSafeEqual(g, expected)) ok = true;
  }
  return ok;
}
```

### What your receiver must do

1. **Verify** against the **raw** body. Reject if `|now − t|` > 300 s. Compare in constant time.
2. **Do not trust the body.** Re-fetch the object with **your own key** and act only on what you
   fetched:
   - `deposit.confirmed`: `GET /v1/deposits/:id`, where `:id` is `data.object.id`. Credit only if the
     fetched `status` is `confirmed`.
   - `payment_intent.*`: `GET /v1/payment-intents/:id`.
   - Or re-fetch the whole event with `GET /v1/events/:id`.
3. **Credit each deposit exactly once.** Key the credit on the deposit, `<CHAIN>:<tx_hash>`, with
   the hash normalised: BEP20 as `0x` + 64 lowercase hex, TRC20 as 64 lowercase hex without `0x`.
   The `dep_…` id is equally unique. Put a **unique constraint** on that key in your own database.
   Deliveries are **at-least-once**, so the same event can arrive more than once.
4. Credit the fetched `amount`. If your ledger has fewer decimals, round **down**.
5. Answer **2xx only after your write is durable**.

### Delivery and retries

- A delivery succeeds on any `2xx` within **10 seconds**.
- Otherwise it is retried after **1 m, 5 m, 30 m, 2 h, 6 h, 12 h and 24 h**: 8 attempts in total. After
  that it is marked `exhausted`.
- Exhausted deliveries can be **re-driven** by SamaPay operations. Contact support with the time range,
  and they are sent again as normal deliveries.
- If you missed events, reconcile with `GET /v1/deposits?since=…` and credit anything you do not have
  yet, once per deposit, as above.
