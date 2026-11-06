/**
 * Generates the N2 AC4 suite `evals/find-the-code`: six bug fixes in the
 * multi-language fixture shop (evals/localisation/fixture) where the prompt
 * describes the symptom in user terms, never the file or function, so the
 * agent must first find the code. Arms: with / without `code_search`.
 *
 *   npx tsx evals/find-the-code/generate.mts
 *   tug eval evals/find-the-code --arms with_search,without_search --base-url … --model … -y
 *
 * The with_search arm expects a profile named `embed` (an /embeddings endpoint,
 * e.g. Ollama: {"baseUrl":"http://localhost:11434/v1","model":"nomic-embed-text"}).
 */
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const fixture = path.join(here, '..', 'localisation', 'fixture');

interface Spec {
  id: string;
  file: string;
  from: string;
  to: string;
  prompt: string;
  behaviour: string;
  test: string;
}

const T = (s: string) => s.replace(/^\n/, '');

const specs: Spec[] = [
  {
    id: 'f01-refund-overpay',
    file: 'billing/refunds.py',
    from: 'already + amount > paid',
    to: 'amount > paid',
    behaviour: 'several partial refunds can never add up to more than the captured payment',
    prompt: 'Customers report that by asking for money back in several steps they can receive more than they originally paid. Find the cause and fix it. `python3 -m pytest -q` must pass; do not modify the tests.',
    test: T(`
import pytest
from decimal import Decimal
from billing.refunds import refund, RefundError


def test_partial_refunds_cannot_exceed_payment():
    order = {"paid": Decimal("10")}
    refund(order, Decimal("6"))
    with pytest.raises(RefundError):
        refund(order, Decimal("6"))


def test_full_refund_takes_the_rest():
    order = {"paid": Decimal("10")}
    refund(order, Decimal("4"))
    assert refund(order)["amount"] == Decimal("6")
`),
  },
  {
    id: 'f02-tax-after-coupon',
    file: 'billing/invoice.py',
    from: 'return ((self.subtotal() - self.discount()) * rate)',
    to: 'return (self.subtotal() * rate)',
    behaviour: 'VAT is computed on the discounted amount',
    prompt: 'Shoppers who use a coupon are charged VAT on the full price instead of the reduced price. Fix it. `python3 -m pytest -q` must pass; do not modify the tests.',
    test: T(`
from decimal import Decimal
from billing.invoice import Invoice, LineItem


def test_vat_on_discounted_amount():
    inv = Invoice("DE", [LineItem("a", 1, Decimal("100"))], coupon_percent=Decimal("10"))
    assert inv.tax() == Decimal("17.10")
    assert inv.total() == Decimal("107.10")
`),
  },
  {
    id: 'f03-sliding-session',
    file: 'auth/session.py',
    from: '    s["expires"] = time.time() + SESSION_TTL  # sliding expiry\n',
    to: '',
    behaviour: 'an active session is extended on every request',
    prompt: 'People get logged out 30 minutes after signing in even while they are actively using the site; they should only be logged out after 30 minutes without activity. Fix it. `python3 -m pytest -q` must pass; do not modify the tests.',
    test: T(`
import auth.session as s


def test_activity_extends_the_session(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(s.time, "time", lambda: now[0])
    tok = s.start_session("u1")
    now[0] += 20 * 60
    assert s.current_user(tok) == "u1"
    now[0] += 20 * 60
    assert s.current_user(tok) == "u1", "still active: 20 minutes since the last request"
    now[0] += 31 * 60
    assert s.current_user(tok) is None
`),
  },
  {
    id: 'f04-currency-direction',
    file: 'billing/currency.py',
    from: 'return (eur / _RATES_TO_EUR[dst]).quantize(Decimal("0.01"))',
    to: 'return (eur * _RATES_TO_EUR[dst]).quantize(Decimal("0.01"))',
    behaviour: 'converting between currencies goes through EUR correctly',
    prompt: 'Prices shown in dirhams and rupees are wildly wrong (far too small), while euro prices are fine. Fix it. `python3 -m pytest -q` must pass; do not modify the tests.',
    test: T(`
from decimal import Decimal
from billing.currency import convert


def test_usd_to_aed():
    assert convert(Decimal("100"), "USD", "AED") == Decimal("368.00")


def test_roundtrip_eur():
    assert convert(Decimal("50"), "EUR", "EUR") == Decimal("50.00")
`),
  },
  {
    id: 'f05-cleanup-keeps-orders',
    file: 'jobs/cleanup.py',
    from: '"DELETE FROM carts WHERE updated_at < ? AND order_id IS NULL"',
    to: '"DELETE FROM carts WHERE updated_at < ?"',
    behaviour: 'the nightly job never deletes carts that became orders',
    prompt: 'After the nightly maintenance runs, some old orders lose their basket contents. Only baskets that were never ordered should be removed. Fix it. `python3 -m pytest -q` must pass; do not modify the tests.',
    test: T(`
import datetime as dt
import sqlite3
from jobs.cleanup import purge_abandoned_carts


def test_only_abandoned_carts_are_removed():
    db = sqlite3.connect(":memory:", detect_types=sqlite3.PARSE_DECLTYPES)
    db.execute("CREATE TABLE carts (id TEXT, updated_at TIMESTAMP, order_id TEXT)")
    old = dt.datetime.utcnow() - dt.timedelta(days=30)
    db.execute("INSERT INTO carts VALUES ('a', ?, NULL)", (old,))
    db.execute("INSERT INTO carts VALUES ('b', ?, 'o1')", (old,))
    assert purge_abandoned_carts(db) == 1
    assert [r[0] for r in db.execute("SELECT id FROM carts")] == ["b"]
`),
  },
  {
    id: 'f06-password-work-factor',
    file: 'auth/passwords.py',
    from: 'bytes.fromhex(salt), int(iters))',
    to: 'bytes.fromhex(salt), ITERATIONS)',
    behaviour: 'stored hashes are verified with their own iteration count',
    prompt: 'Since we raised the password hashing cost, users whose passwords were saved before the change can no longer log in. Fix it without forcing password resets. `python3 -m pytest -q` must pass; do not modify the tests.',
    test: T(`
import hashlib
from auth.passwords import hash_password, verify_password


def test_new_hash_verifies():
    assert verify_password("pw", hash_password("pw"))


def test_old_work_factor_still_verifies():
    salt = bytes(16)
    old = "pbkdf2$1000$" + salt.hex() + "$" + hashlib.pbkdf2_hmac("sha256", b"pw", salt, 1000).hex()
    assert verify_password("pw", old)
    assert not verify_password("nope", old)
`),
  },
];

const tasksDir = path.join(here, 'tasks');
fs.rmSync(tasksDir, { recursive: true, force: true });
for (const s of specs) {
  const dir = path.join(tasksDir, s.id);
  const repo = path.join(dir, 'repo');
  fs.cpSync(fixture, repo, { recursive: true });
  const f = path.join(repo, s.file);
  const src = fs.readFileSync(f, 'utf8');
  if (!src.includes(s.from)) throw new Error(`${s.id}: anchor not found in ${s.file}`);
  fs.writeFileSync(f, src.replace(s.from, s.to));
  for (const pkg of ['billing', 'auth', 'jobs']) fs.writeFileSync(path.join(repo, pkg, '__init__.py'), '');
  fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'tests', `test_${s.id.split('-').slice(1).join('_')}.py`), s.test);
  fs.writeFileSync(path.join(repo, 'conftest.py'), 'import sys, os\nsys.path.insert(0, os.path.dirname(__file__))\n');
  const task = {
    id: s.id,
    version: 1,
    type: 'localise_and_repair',
    behaviour: s.behaviour,
    prompt: s.prompt,
    acceptance: ['python3 -m pytest -q'],
    verification: ['pytest'],
    protected: ['tests/**', 'conftest.py'],
    timeout_s: 900,
    reachability: { network: false, editable: [s.file], protected: ['tests/**'] },
  };
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify(task, null, 2) + '\n');
}
fs.writeFileSync(
  path.join(here, 'suite.json'),
  JSON.stringify(
    {
      description: 'N2 AC4: find the code from a user-level symptom, then fix it. with_search exposes code_search (hybrid BM25 + embeddings from profile "embed"); without_search hides it. Compare turns and pass rate.',
      repeats: 1,
      arms: {
        with_search: { search: { mode: 'auto', embeddings: { profile: 'embed' } }, agent: { repoMapTokens: 0 } },
        without_search: { search: { mode: 'off' }, agent: { repoMapTokens: 0 } },
      },
    },
    null,
    2,
  ) + '\n',
);
console.log(`wrote ${specs.length} tasks to ${tasksDir}`);
