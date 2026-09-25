"""Тесты тарифов v2 (app.py): план, лимиты, пул Team, квота диктовки, Checkout.

Запуск:  python tests/test_plans.py
Чистый stdlib: нужные куски вытаскиваются из app.py через ast (без Flask/jwt),
Supabase подменяется фейковым _sb_admin.
"""
import ast
import os
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

NAMES = {"PLAN_LIMITS", "DICTATION_UNLIMITED_PLANS", "_TEAM_WS_SELECT",
         "_get_team_workspace", "_normalize_plan", "_get_effective_plan", "_this_month",
         "_usage", "_charge_minutes", "_checkout_mode_params"}


def _load(db: "FakeDB", managed: bool = False) -> dict:
    with open(os.path.join(ROOT, "app.py"), encoding="utf-8") as f:
        tree = ast.parse(f.read())
    body = []
    for n in tree.body:
        if isinstance(n, ast.FunctionDef) and n.name in NAMES:
            body.append(n)
        elif isinstance(n, (ast.Assign, ast.AnnAssign)):
            t = n.targets[0] if isinstance(n, ast.Assign) else n.target
            if isinstance(t, ast.Name) and t.id in NAMES:
                body.append(n)
    ns: dict = {"datetime": datetime, "_sb_admin": db, "STRIPE_MANAGED_PAYMENTS": managed,
                "_add_minutes": lambda uid, m: db.calls.append(("add_minutes", uid, m))}
    exec(compile(ast.Module(body=body, type_ignores=[]), "app.py", "exec"), ns)
    return ns


class FakeDB:
    """workspaces / workspace_members + запись RPC-вызовов."""

    def __init__(self, workspaces=(), members=()):
        self.workspaces = list(workspaces)
        self.members = list(members)
        self.calls = []

    def __call__(self, path, method="GET", data=None, params=None):
        params = params or {}
        if path.startswith("rpc/"):
            self.calls.append((path, data))
            return []

        def ok(row, key, cond):
            return str(row.get(key)) == cond.split(".", 1)[1]

        if path == "workspaces":
            rows = [w for w in self.workspaces
                    if all(ok(w, k, v) for k, v in params.items() if k not in ("select", "limit"))]
            return rows[:1]
        if path == "workspace_members":
            return [m for m in self.members
                    if all(ok(m, k, v) for k, v in params.items() if k not in ("select", "limit"))][:1]
        raise AssertionError(path)


THIS_MONTH = datetime.utcnow().strftime("%Y-%m-01")
LAST_MONTH = (datetime.utcnow().replace(day=1) - timedelta(days=1)).strftime("%Y-%m-01")


def test_max_becomes_pro():
    ns = _load(FakeDB())
    assert ns["_normalize_plan"]("max") == "pro"
    assert ns["_normalize_plan"](None) == "free"
    assert ns["_normalize_plan"]("enterprise") == "free"
    assert "max" not in ns["PLAN_LIMITS"]


def test_free_has_speakers_no_ai():
    lim = _load(FakeDB())["PLAN_LIMITS"]["free"]
    assert lim["diarization"] is True and lim["ai"] is False and lim["minutes"] == 60
    assert lim["dictation_s"] == 3600


def test_personal_pro_usage_with_bonus():
    ns = _load(FakeDB())
    u = ns["_usage"]("u1", {"plan": "pro", "minutes_used": 120, "bonus_minutes": 60,
                            "dictation_seconds_month": 500, "dictation_month": THIS_MONTH})
    assert u["plan"] == "pro" and u["team_workspace_id"] is None
    assert u["minutes_used"] == 120 and u["minutes_limit"] == 660
    assert u["dictation_used_s"] == 500 and u["dictation_limit_s"] == 36000
    assert u["dictation_unlimited"] is True


def test_dictation_counter_from_last_month_is_zero():
    ns = _load(FakeDB())
    u = ns["_usage"]("u1", {"plan": "free", "dictation_seconds_month": 3000, "dictation_month": LAST_MONTH})
    assert u["dictation_used_s"] == 0 and u["dictation_unlimited"] is False


def test_team_owner_gets_pool():
    db = FakeDB(workspaces=[{"id": "w1", "owner_id": "u1", "plan": "team", "seats": 3,
                             "minutes_used": 700, "minutes_month": THIS_MONTH}])
    ns = _load(db)
    u = ns["_usage"]("u1", {"plan": "free", "minutes_used": 10, "bonus_minutes": 60})
    assert u["plan"] == "team" and u["team_workspace_id"] == "w1"
    assert u["minutes_limit"] == 1800 and u["minutes_used"] == 700  # бонус в пул не идёт


def test_team_member_pool_resets_on_new_month():
    db = FakeDB(workspaces=[{"id": "w1", "owner_id": "u0", "plan": "team", "seats": 2,
                             "minutes_used": 900, "minutes_month": LAST_MONTH}],
                members=[{"user_id": "u2", "status": "active", "workspace_id": "w1"}])
    ns = _load(db)
    u = ns["_usage"]("u2", {"plan": "free"})
    assert u["plan"] == "team" and u["minutes_used"] == 0 and u["minutes_limit"] == 1200


def test_invited_member_is_not_team():
    db = FakeDB(workspaces=[{"id": "w1", "owner_id": "u0", "plan": "team", "seats": 2}],
                members=[{"user_id": "u2", "status": "invited", "workspace_id": "w1"}])
    assert _load(db)["_get_effective_plan"]("u2", None, {"plan": "free"}) == "free"


def test_free_workspace_is_not_team():
    db = FakeDB(workspaces=[{"id": "w1", "owner_id": "u1", "plan": "free", "seats": 1}])
    assert _load(db)["_get_effective_plan"]("u1", None, {"plan": "pro"}) == "pro"


def test_charge_minutes_goes_to_pool_for_team():
    db = FakeDB(workspaces=[{"id": "w1", "owner_id": "u1", "plan": "team", "seats": 2}])
    _load(db)["_charge_minutes"]("u1", 12.4)
    assert db.calls == [("rpc/add_workspace_minutes", {"p_workspace_id": "w1", "p_mins": 12})]


def test_charge_minutes_personal():
    db = FakeDB()
    _load(db)["_charge_minutes"]("u1", 3.0)
    assert db.calls == [("add_minutes", "u1", 3.0)]


def test_checkout_params():
    assert _load(FakeDB(), managed=False)["_checkout_mode_params"]() == {"payment_method_types": ["card"]}
    # С Managed Payments payment_method_types запрещён — Stripe выбирает сам
    assert _load(FakeDB(), managed=True)["_checkout_mode_params"]() == {"managed_payments": {"enabled": True}}


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"ok  {fn.__name__}")
    print(f"\n{len(fns)} passed")
