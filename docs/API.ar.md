# pay.mntad.com — واجهة API الإصدار 1

مدفوعات USDT على شبكتي **TRC20** (ترون) و**BEP20** (BNB Smart Chain) للتجّار. تحصل على عناوين
عملات رقمية، وتراقب SamaPay الشبكات، وتصلك رسالة webhook موقّعة عن كل إيداع مؤكَّد.
الأموال التي تستلمها تصبح **رصيدك في البوابة** لدى SamaPay.

- العنوان الأساسي: `https://pay.mntad.com/v1`
- JSON في الطلب والرد (`Content-Type: application/json`)، بترميز UTF-8.
- التواريخ نصوص ISO-8601 بتوقيت UTC، مثل `2026-09-25T12:00:00.000Z`.
- **المبالغ دائمًا نص عشري** وليست رقمًا: `"12.5"` و`"0.000001"`. العملة دائمًا
  `USDT`، وبحدّ أقصى 6 منازل عشرية.
- كل ردّ يحمل الترويسة `X-Request-Id`، وكل خطأ يكرّرها في الحقل `request_id`.
  اذكرها عند التواصل مع الدعم: [noreply@mntad.com](mailto:noreply@mntad.com).

هذا الملف يُطابَق مع الشيفرة عبر `scripts/verify-api-docs.ts`: كل مسار وحالة ورمز خطأ ونوع حدث
وترويسة وثابت هنا يُقارَن مع `src/`، فلا يمكن أن يختلفا.

---

## 1. المصادقة

```
Authorization: Bearer sk_live_<40 characters>
```

- كل مفتاح يتبع حسابًا واحدًا فقط (*العميل*). الحساب يؤخذ **دائمًا** من المفتاح، ولا يؤخذ أبدًا
  من حقل في الطلب.
- كل ما تنشئه (العناوين، طلبات الدفع، الإيداعات، الأحداث) ملك لحسابك وليس للمفتاح. بعد تدوير
  المفتاح يرى المفتاح الجديد كل ذلك.
- مفاتيح `sk_test_…` تعمل فقط خارج بيئة الإنتاج. في الإنتاج تُرفض بالرمز `401 invalid_key`.
- احفظ المفتاح على خادمك. لا تضعه أبدًا في متصفح أو تطبيق.

### الصلاحيات (scopes)

كل مفتاح يحمل مجموعة صلاحيات، وكل مسار يحتاج واحدة منها:

| الصلاحية | تسمح بـ |
|---|---|
| `payment_intents.write` | `POST /v1/payment-intents` |
| `payment_intents.read` | `GET /v1/payment-intents` و`GET /v1/payment-intents/:id` |
| `addresses.write` | `POST /v1/addresses` |
| `deposits.read` | `GET /v1/deposits` و`GET /v1/deposits/:id` |
| `events.read` | `GET /v1/events/:id` |
| `balance.read` | `GET /v1/balance` |

الصلاحية الناقصة تعطي `403 insufficient_scope`، ويذكر الحقل `error.details.required` اسمها.

---

## 2. الأخطاء

```json
{ "error": { "code": "amount_out_of_range", "message": "…", "request_id": "req_…", "details": { } } }
```

اعتمد على `code`. أمّا `message` فنص إنكليزي للبشر وقد يتغيّر.

| HTTP | الرمز | متى |
|---|---|---|
| 400 | `invalid_json` | جسم الطلب ليس JSON. |
| 400 | `idempotency_key_required` | طلب POST بلا `Idempotency-Key` صالح (من 1 إلى 255 حرف ASCII قابل للطباعة). |
| 400 | `validation_failed` | الشكل خاطئ. الحقل `details.fields` يذكر الحقول. |
| 401 | `unauthenticated` | الترويسة `Authorization` غائبة أو مشوّهة. |
| 401 | `invalid_key` | مفتاح غير معروف، أو سرّ خاطئ، أو مفتاح اختبار في الإنتاج. |
| 401 | `key_revoked` | المفتاح أُلغي. `details.successor` آخر 4 أحرف من المفتاح البديل إن وُجد. |
| 403 | `insufficient_scope` | `details.required` يذكر الصلاحية الناقصة. |
| 404 | `not_found` | معرّف غير معروف **أو كائن يخصّ حسابًا آخر**. الحالتان لهما الجواب نفسه. |
| 409 | `idempotency_payload_mismatch` | استُعمل `Idempotency-Key` نفسه مع جسم مختلف. |
| 409 | `idempotency_in_progress` | الطلب الأول بهذا المفتاح ما زال يعمل. أعد المحاولة بعد ثانية تقريبًا. |
| 409 | `reference_conflict` | يوجد طلب دفع بهذا `reference` بمبلغ أو شبكة مختلفة. |
| 422 | `amount_out_of_range` | المبلغ ≤ 0، أو أكثر من 6 منازل عشرية، أو خارج الحدّ الأدنى/الأعلى لحسابك. |
| 422 | `unsupported_chain` | الشبكة ليست `TRC20`/`BEP20`، أو غير مفعّلة لحسابك. |
| 422 | `reference_invalid` | طول المرجع أو أحرفه غير مقبولة (انظر كل مسار). |
| 429 | `rate_limited` | طلبات كثيرة. انتظر عدد الثواني المذكور في الترويسة `Retry-After`. |
| 503 | `derivation_unavailable` | لا يمكن توليد عنوان الآن. **لم يُنشأ شيء**، فأعد المحاولة لاحقًا. |
| 503 | `chain_unavailable` | طبقة الشبكة غير متاحة. لم يُنشأ شيء. |
| 500 | `internal` | خطأ من طرفنا، مسجَّل تحت `request_id`. |

---

## 3. منع التكرار (idempotency) — في كل POST

أرسل `Idempotency-Key: <1–255 printable ASCII characters>` مع **كل** طلب POST. المفتاح خاصّ بـ
(مفتاحك، Idempotency-Key) ويُحفظ لمدة **24 ساعة**.

- **المفتاح نفسه والجسم نفسه:** تحصل على الحالة والجسم **الأصليين** بايتًا ببايت، مع الترويسة
  `Idempotent-Replayed: true`. المقارنة على محتوى JSON، فلا يهمّ ترتيب الحقول أو المسافات.
- **المفتاح نفسه وجسم مختلف:** `409 idempotency_payload_mismatch`.
- **المفتاح نفسه والطلب الأول ما زال يعمل:** `409 idempotency_in_progress`. أعد المحاولة بعد قليل.
- **المحاولة الأولى أعطت 5xx:** لم يُحفظ شيء على المفتاح، فأعد المحاولة **بالمفتاح نفسه**.

الإعادة ترجع الجواب كما كان *حينها*. للحالة الحالية استعمل GET.

---

## 4. حدود المعدّل

- لكل مفتاح حدّ في الثانية (الافتراضي **10 طلبات في الثانية**). إذا تجاوزته تحصل على
  `429 rate_limited` مع `Retry-After`.
- محاولات المصادقة **الفاشلة** المتكرّرة لمفتاح واحد تُكبَح: بعد 10 إخفاقات يجيب ذلك المفتاح
  بالرمز `429` حتى يتعافى الكابح (واحد كل ثانية). هذا يشمل الطلبات الصحيحة أثناء ذلك، فلا تكرّر
  المحاولة بمفتاح خاطئ.

---

## 5. الكائنات

### PaymentIntent (طلب دفع)

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

- `amount_received` مجموع الإيداعات **المؤكَّدة** إلى عنوان الطلب، وقد يتجاوز `amount`.
  و`tx_hashes` يذكر تلك الإيداعات.
- `fee_amount` مجموع الرسوم على تلك الإيداعات. تُخصم من **رصيدك في البوابة**، ولا تُخصم أبدًا
  من المبلغ الذي أرسله الدافع.

الحالات:

| status | المعنى |
|---|---|
| `requires_payment` | بانتظار تحويل. |
| `processing` | شوهد تحويل لكنه لم يصل إلى عمق التأكيد بعد. |
| `succeeded` | الإيداعات المؤكَّدة بلغت `amount` في الوقت. الدفع الزائد مسموح (`amount_received` > `amount`). |
| `succeeded_late` | اكتمل المبلغ **بعد** `expires_at`. |
| `expired` | انتهت المهلة ولم يصل شيء. |
| `expired_partial` | انتهت المهلة وقد وصل أقل من `amount`. |

- **في الوقت أم متأخّر** يحدّده وقت **اكتشاف** التحويل الذي أكمل المبلغ، لا وقت تأكيده.
  الدفعة المرسلة في الوقت والتي ما زالت قيد التأكيد تُبقي الطلب `processing` بعد `expires_at`.
- `succeeded` و`succeeded_late` نهائيتان. الطلب `expired` أو `expired_partial` قد يصبح
  `succeeded_late` إذا أكملت دفعةٌ متأخرة المبلغ.
- **لا يضيع أي مال.** كل إيداع مؤكَّد، مبكّرًا أو متأخّرًا أو جزئيًا أو زائدًا، يولّد حدث
  `deposit.confirmed` خاصًا به.

### Deposit (إيداع)

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

- الحالات: `detected` ثم `confirmed`. التحويل المكتشَف الذي أزالته إعادة تنظيم للشبكة يصبح
  `orphaned`، ولا يتأكّد أبدًا ولا يُحتسب.
- إيداع واحد لكل تحويل على الشبكة، و`(chain, tx_hash)` فريد.
- قيمة `reference` حسب وجهة المال:
  - إيداع طلب دفع: `reference` **الخاص بطلب الدفع**؛
  - عنوان شحن: `reference` **الخاص بالعنوان**.
- `payment_intent_id` قيمته `null` لعنوان الشحن.
- الصيغة `dep_…` لـ `id` هي الوحيدة المقبولة في كل مكان.

### المبالغ والغبار والتأكيدات

- مبالغ الشبكة **تُقتطع (تُقرَّب إلى الأسفل) إلى 6 منازل عشرية** عند تسجيلها.
- التحويل الذي يصبح `0` بعد الاقتطاع (غبار) ليس دفعة، ولا ينقل طلب الدفع أبدًا إلى
  `processing`.
- يصبح الإيداع `confirmed` عند هذا العمق:

| الشبكة | التأكيدات |
|---|---|
| TRC20 | 19 |
| BEP20 | 15 |

الحقل `confirmations_required` في طلب الدفع يذكر الرقم نفسه.

---

## 6. المسار 1: دفعة واحدة وعنوان واحد (طلبات الدفع)

للدفع عند الشراء: مبلغ ثابت ومهلة، على عنوان جديد لا يُعاد استعماله أبدًا.

`POST /v1/payment-intents`، الصلاحية `payment_intents.write`.

| الحقل | القاعدة |
|---|---|
| `amount` | نص عشري، > 0، ≤ 6 منازل عشرية، ضمن الحد الأدنى/الأعلى لحسابك (الافتراضي 1 … 10000). |
| `chain` | `TRC20` أو `BEP20`. |
| `reference` | معرّفك **أنت** لهذه الدفعة: من 1 إلى 200 حرف من `[A-Za-z0-9:_-]`. |
| `expires_in_sec` | اختياري، 300 … 604800. الافتراضي 3600. |

```bash
curl -s https://pay.mntad.com/v1/payment-intents \
  -H "Authorization: Bearer $SAMAPAY_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-1042" \
  -d '{"amount":"12.5","chain":"TRC20","reference":"order-1042"}'
```

- `201`: طلب دفع جديد. اعرض على الدافع `address` والمبلغ **بالضبط** `amount` و`expires_at`.
- **طلب دفع واحد لكل `reference`:** إرسال المرجع نفسه مرة أخرى (ولو بـ Idempotency-Key جديد)
  يعيد الطلب الموجود:
  - `amount` و`chain` نفسهما: `200` مع الطلب الموجود؛
  - `amount` أو `chain` مختلف: `409 reference_conflict`.

قراءة طلبات الدفع:

- `GET /v1/payment-intents/:id` (الصلاحية `payment_intents.read`) يعيد طلبًا واحدًا.
- `GET /v1/payment-intents` يعرض الطلبات، الأحدث أولًا، بالشكل `{ "object": "list", "data": [...], "has_more": bool }`.
  معاملات الاستعلام: `reference` و`status` و`limit` (1–100، الافتراضي 10) و`starting_after` (معرّف طلب).

ما يصل عبر webhook:

- حدث `deposit.confirmed` لكل تحويل مؤكَّد إلى عنوان الطلب؛
- حدث `payment_intent.succeeded` مرة واحدة، حين يصبح الطلب `succeeded` أو `succeeded_late`؛
- حدث `payment_intent.expired` مرة واحدة، حين يصبح `expired` أو `expired_partial`.

اقرأ `data.object.status` لتمييز الحالتين. **أضف الرصيد عند `deposit.confirmed`**، واستعمل
أحداث طلب الدفع للحالة وواجهة المستخدم فقط.

---

## 7. المسار 2: عنوان دائم لكل عميل (الشحن)

للمحافظ والأرصدة: كل عميل يحصل على عنوان واحد مدى الحياة، ويرسل إليه أي مبلغ في أي وقت.

`POST /v1/addresses`، الصلاحية `addresses.write`.

| الحقل | القاعدة |
|---|---|
| `chain` | `TRC20` أو `BEP20` (مفعّلة لحسابك). |
| `reference` | `client:tenant:kind:id`: أربعة مقاطع غير فارغة، كلٌّ منها 64 حرفًا على الأكثر، بلا `:` أو مسافات أو أحرف تحكّم داخل المقطع. مثال: `acme:shop1:user:42`. |

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

- `201`: صدر العنوان الآن.
- `200`: كان لهذا الزوج `(chain, reference)` عنوان من قبل، فتحصل على **العنوان نفسه** في كل
  مرة، من أي مفتاح من مفاتيحك.
- كل تحويل مؤكَّد إليه يولّد حدث `deposit.confirmed` واحدًا، فيه
  `data.object.reference` = مرجعك و`payment_intent_id: null`.

---

## 8. القراءة

| المسار | الصلاحية | يعيد |
|---|---|---|
| `GET /v1/deposits` | `deposits.read` | `{ "object": "list", "data": [Deposit], "has_more": bool }`، الأقدم أولًا. الاستعلام: `reference` و`payment_intent_id` و`since` (ISO-8601) و`limit` (1–100، الافتراضي 100). |
| `GET /v1/deposits/:id` | `deposits.read` | إيداع واحد (`dep_…`). |
| `GET /v1/events/:id` | `events.read` | حدث واحد، كما أُرسل بالضبط. |
| `GET /v1/balance` | `balance.read` | رصيدك في البوابة (أدناه). |
| `GET /v1/health` | none | حالة الخدمة. |

`GET /v1/balance`:

```json
{
  "object": "balance",
  "currency": "USDT",
  "chains": { "TRC20": { "available": "15.75", "pending": "0" }, "BEP20": { "available": "0", "pending": "0" } },
  "fee_bps": 0
}
```

- `available` = الإيداعات المؤكَّدة − الرسوم − السحوبات.
- `pending` = الإيداعات المكتشَفة التي لم تتأكّد بعد.
- `fee_bps` نسبة رسومك الحالية بنقاط الأساس.

---

## 9. Webhooks

ترسل SamaPay كل حدث بطلب POST إلى رابط الـ webhook الخاص بك (https، يُحدَّد عند إصدار مفتاحك).

### الحدث

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

- الأنواع: `deposit.confirmed` و`payment_intent.succeeded` و`payment_intent.expired`.
- `data.object` هو الإيداع أو طلب الدفع **كما كان لحظة وقوع الحدث**.

### الترويسات

- `X-SamaPay-Event`: نوع الحدث.
- `X-SamaPay-Delivery`: معرّف الإرسال.
- `X-SamaPay-Signature`: `t=<unix seconds>,v1=<hex>[,v1=<hex>…]`.

التوقيع هو `v1 = HMAC-SHA256(secret, "<t>.<raw body>")` بصيغة hex. `secret` هو نصّ
`whsec_…` كاملًا. أثناء تدوير السرّ قد تظهر عدة قيم `v1`، فاقبل الطلب إذا طابقت **أيٌّ** منها.

### التحقّق (Node)

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

### ما يجب أن يفعله مستقبِلك

1. **تحقّق** من التوقيع على الجسم **الخام**. ارفض إذا كان `|now − t|` > 300 ثانية. قارن بزمن ثابت.
2. **لا تثق بالجسم.** أعد جلب الكائن **بمفتاحك أنت** واعمل فقط بما جلبته:
   - `deposit.confirmed`: `GET /v1/deposits/:id`، حيث `:id` هو `data.object.id`. أضف الرصيد فقط
     إذا كانت `status` المجلوبة `confirmed`.
   - `payment_intent.*`: `GET /v1/payment-intents/:id`.
   - أو أعد جلب الحدث كاملًا عبر `GET /v1/events/:id`.
3. **أضف رصيد كل إيداع مرة واحدة فقط.** اجعل مفتاح الإضافة هو الإيداع، `<CHAIN>:<tx_hash>`، مع
   توحيد صيغة الهاش: BEP20 بالشكل `0x` + 64 حرف hex صغير، وTRC20 بـ 64 حرف hex صغير بلا `0x`.
   المعرّف `dep_…` فريد بالقدر نفسه. ضع **قيد تفرّد** على ذلك المفتاح في قاعدة بياناتك. الإرسال
   **مرة واحدة على الأقل**، فقد يصل الحدث نفسه أكثر من مرة.
4. أضف المبلغ `amount` المجلوب. إذا كان في دفترك منازل عشرية أقل، قرّب **إلى الأسفل**.
5. أجب بـ **2xx فقط بعد أن يُحفظ ما كتبته نهائيًا**.

### الإرسال وإعادة المحاولة

- ينجح الإرسال بأي ردّ `2xx` خلال **10 ثوانٍ**.
- وإلا يُعاد بعد **1 د، 5 د، 30 د، 2 س، 6 س، 12 س، 24 س**: 8 محاولات إجمالًا. بعدها يُعلَّم
  `exhausted`.
- الإرسالات المستنفدة يمكن أن **تعيد إرسالها** عمليات SamaPay. تواصل مع الدعم مع الفترة الزمنية،
  فتُرسَل من جديد كإرسال عادي.
- إذا فاتتك أحداث، طابِق عبر `GET /v1/deposits?since=…` وأضف رصيد كل ما لم تسجّله بعد، مرة واحدة
  لكل إيداع كما سبق.
