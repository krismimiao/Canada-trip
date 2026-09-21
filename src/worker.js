// 旅行账本后台：一个 Durable Object（SQLite）存全部账目，所有 /api/* 请求都交给它。
import { DurableObject } from "cloudflare:workers";

const NAMES = ["菲菲", "苗", "艺馨"];
const CURS = ["CAD", "USD"];
const CATS = ["餐饮", "交通", "门票", "住宿", "购物", "其他"];
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CENTS = 100000000; // 1,000,000.00
const MAX_BODY = 4096;
const FAIL_LIMIT = 10; // 10 分钟内密码错 10 次 → 锁 10 分钟
const FAIL_WINDOW = 10 * 60 * 1000;

const BASE_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const json = (obj, status = 200, extra) =>
  new Response(JSON.stringify(obj), { status, headers: { ...BASE_HEADERS, ...(extra || {}) } });

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

function clean(b) {
  if (!b || typeof b !== "object") return { error: "bad_body" };
  const title = String(b.title ?? "").trim();
  if (title.length < 1 || title.length > 60) return { error: "bad_title" };
  if (!CATS.includes(b.cat)) return { error: "bad_cat" };
  const cents = b.cents;
  if (!Number.isInteger(cents) || cents < 1 || cents > MAX_CENTS) return { error: "bad_amount" };
  if (!CURS.includes(b.cur)) return { error: "bad_currency" };
  if (!NAMES.includes(b.payer)) return { error: "bad_payer" };
  if (!Array.isArray(b.split) || b.split.length < 1 || !b.split.every((n) => NAMES.includes(n))) return { error: "bad_split" };
  const set = new Set(b.split);
  const split = NAMES.filter((n) => set.has(n));
  if (typeof b.date !== "string" || !DATE_RE.test(b.date) || Number.isNaN(Date.parse(b.date))) return { error: "bad_date" };
  const note = String(b.note ?? "").trim();
  if (note.length > 200) return { error: "bad_note" };
  return { value: { title, cat: b.cat, cents, cur: b.cur, payer: b.payer, split, date: b.date, note } };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const stub = env.LEDGER.get(env.LEDGER.idFromName("main"));
      return stub.fetch(request);
    }
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
  },
};

export class Ledger extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS expenses (
        id TEXT PRIMARY KEY, date TEXT NOT NULL, title TEXT NOT NULL, cat TEXT NOT NULL,
        cents INTEGER NOT NULL, cur TEXT NOT NULL, payer TEXT NOT NULL, split TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '', deleted INTEGER NOT NULL DEFAULT 0,
        created INTEGER NOT NULL, updated INTEGER NOT NULL, rev INTEGER NOT NULL)`);
      this.sql.exec("CREATE INDEX IF NOT EXISTS expenses_rev ON expenses (rev)");
      this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)");
      this.sql.exec("INSERT OR IGNORE INTO meta (k, v) VALUES ('rev', 0)");
      this.sql.exec("CREATE TABLE IF NOT EXISTS fails (ts INTEGER NOT NULL)");
    });
  }

  rev() {
    return this.sql.exec("SELECT v FROM meta WHERE k = 'rev'").one().v;
  }
  bump() {
    this.sql.exec("UPDATE meta SET v = v + 1 WHERE k = 'rev'");
    return this.rev();
  }
  row(r) {
    return {
      id: r.id, date: r.date, title: r.title, cat: r.cat, cents: r.cents, cur: r.cur, payer: r.payer,
      split: JSON.parse(r.split), note: r.note, deleted: !!r.deleted, created: r.created, updated: r.updated, rev: r.rev,
    };
  }
  async body(request) {
    const t = await request.text();
    if (t.length > MAX_BODY) return null;
    try { return JSON.parse(t); } catch { return null; }
  }

  async check(request) {
    const pw = this.env.LEDGER_PASSWORD;
    if (!pw) return { status: 503, error: "not_configured" };
    const now = Date.now();
    this.sql.exec("DELETE FROM fails WHERE ts < ?", now - FAIL_WINDOW);
    const n = this.sql.exec("SELECT COUNT(*) AS c FROM fails").one().c;
    if (n >= FAIL_LIMIT) return { status: 429, error: "too_many_attempts", retry: 600 };
    const given = request.headers.get("x-ledger-key") || "";
    if (!(await safeEqual(given, String(pw)))) {
      this.sql.exec("INSERT INTO fails (ts) VALUES (?)", now);
      return { status: 401, error: "bad_password" };
    }
    return null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const method = request.method;
    const deny = await this.check(request);
    if (deny) return json({ error: deny.error }, deny.status, deny.retry ? { "retry-after": String(deny.retry) } : undefined);

    if (url.pathname === "/api/ping" && method === "GET") return json({ ok: true, rev: this.rev(), names: NAMES });

    if (url.pathname === "/api/state" && method === "GET") {
      const since = parseInt(url.searchParams.get("since") || "0", 10) || 0;
      const items = this.sql.exec("SELECT * FROM expenses WHERE rev > ? ORDER BY rev", since).toArray().map((r) => this.row(r));
      return json({ rev: this.rev(), items });
    }

    if (url.pathname === "/api/expenses" && method === "POST") {
      const b = await this.body(request);
      const id = b && typeof b.id === "string" ? b.id : "";
      if (!ID_RE.test(id)) return json({ error: "bad_id" }, 400);
      const v = clean(b);
      if (v.error) return json({ error: v.error }, 400);
      const ex = this.sql.exec("SELECT * FROM expenses WHERE id = ?", id).toArray();
      if (ex.length) return json({ ok: true, item: this.row(ex[0]), rev: this.rev() });
      let rev;
      this.ctx.storage.transactionSync(() => {
        rev = this.bump();
        const now = Date.now();
        this.sql.exec(
          "INSERT INTO expenses (id,date,title,cat,cents,cur,payer,split,note,deleted,created,updated,rev) VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?)",
          id, v.value.date, v.value.title, v.value.cat, v.value.cents, v.value.cur, v.value.payer, JSON.stringify(v.value.split), v.value.note, now, now, rev
        );
      });
      const item = this.row(this.sql.exec("SELECT * FROM expenses WHERE id = ?", id).one());
      return json({ ok: true, item, rev });
    }

    const m = url.pathname.match(/^\/api\/expenses\/([A-Za-z0-9_-]{8,64})$/);
    if (m && method === "PUT") {
      const id = m[1];
      const b = await this.body(request);
      const v = clean(b);
      if (v.error) return json({ error: v.error }, 400);
      const ex = this.sql.exec("SELECT deleted FROM expenses WHERE id = ?", id).toArray();
      if (!ex.length || ex[0].deleted) return json({ error: "not_found" }, 404);
      let rev;
      this.ctx.storage.transactionSync(() => {
        rev = this.bump();
        this.sql.exec(
          "UPDATE expenses SET date=?,title=?,cat=?,cents=?,cur=?,payer=?,split=?,note=?,updated=?,rev=? WHERE id=?",
          v.value.date, v.value.title, v.value.cat, v.value.cents, v.value.cur, v.value.payer, JSON.stringify(v.value.split), v.value.note, Date.now(), rev, id
        );
      });
      const item = this.row(this.sql.exec("SELECT * FROM expenses WHERE id = ?", id).one());
      return json({ ok: true, item, rev });
    }

    if (m && method === "DELETE") {
      const id = m[1];
      const ex = this.sql.exec("SELECT deleted FROM expenses WHERE id = ?", id).toArray();
      if (ex.length && !ex[0].deleted) {
        this.ctx.storage.transactionSync(() => {
          const rev = this.bump();
          this.sql.exec("UPDATE expenses SET deleted=1, updated=?, rev=? WHERE id=?", Date.now(), rev, id);
        });
      }
      return json({ ok: true, rev: this.rev() });
    }

    return json({ error: "not_found" }, 404);
  }
}
