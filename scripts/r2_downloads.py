"""Установщики приложения в R2 (префикс downloads/) — то, что отдаёт skriptly.io/api/download/windows.

Ключи берутся из Modal-секрета r2-secrets (локально ключей R2 нет):
  modal run scripts/r2_downloads.py::check
      — показывает правила жизненного цикла бакета. ВАЖНО: правило «удалять через 90 дней»
        должно быть ограничено префиксом recordings/, иначе оно удалит и установщик.
  modal run scripts/r2_downloads.py::upload --path desktop/src-tauri/target/release/bundle/nsis/Skriptly_0.7.0_x64-setup.exe --version 0.7.0 [--notes "что нового"]
      — кладёт файл как downloads/windows/Skriptly-setup.exe («последний», его отдаёт сайт)
        и как downloads/windows/Skriptly_<версия>_x64-setup.exe (архив версий), а рядом
        downloads/windows/latest.json — манифест автообновления (версия + подпись из <exe>.sig).
        Подпись появляется при сборке с TAURI_SIGNING_PRIVATE_KEY_PATH=C:Users<you>.tauriskriptly-updater.key
        (без неё установленные приложения обновить не получится — файл .sig не создаётся).
Повторный запуск безопасен: объекты перезаписываются.
"""
import hashlib
import os

import modal

app = modal.App("skriptly-r2-downloads")
image = modal.Image.debian_slim(python_version="3.12").pip_install("boto3")
secret = modal.Secret.from_name("r2-secrets")


def _client():
    import boto3
    from botocore.config import Config
    return boto3.client(
        "s3",
        endpoint_url=os.environ.get("R2_ENDPOINT")
        or f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
        config=Config(signature_version="s3v4"),
    )


@app.function(image=image, secrets=[secret])
def lifecycle() -> dict:
    bucket = os.environ["R2_BUCKET"]
    out = {"bucket": bucket, "rules": None, "error": None}
    try:
        cfg = _client().get_bucket_lifecycle_configuration(Bucket=bucket)
        out["rules"] = cfg.get("Rules", [])
    except Exception as e:  # у бакета без правил R2 отвечает NoSuchLifecycleConfiguration
        out["error"] = f"{type(e).__name__}: {e}"
    return out


@app.function(image=image, secrets=[secret], timeout=300)
def put_installer(data: bytes, version: str, signature: str = "", notes: str = "") -> dict:
    bucket = os.environ["R2_BUCKET"]
    c = _client()
    meta = {"version": version, "sha256": hashlib.sha256(data).hexdigest()}
    keys = ["downloads/windows/Skriptly-setup.exe", f"downloads/windows/Skriptly_{version}_x64-setup.exe"]
    for k in keys:
        c.put_object(Bucket=bucket, Key=k, Body=data, ContentType="application/vnd.microsoft.portable-executable", Metadata=meta)
    if signature:
        import json
        from datetime import datetime, timezone
        manifest = {"version": version, "notes": notes, "signature": signature,
                    "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
        c.put_object(Bucket=bucket, Key="downloads/windows/latest.json", Body=json.dumps(manifest).encode(),
                     ContentType="application/json")
        keys.append("downloads/windows/latest.json")
    return {"keys": keys, "size": len(data), **meta}


@app.local_entrypoint()
def check():
    r = lifecycle.remote()
    print(f"bucket: {r['bucket']}")
    if r["rules"] is None:
        print("lifecycle:", r["error"])
        return
    for rule in r["rules"]:
        flt = rule.get("Filter") or rule.get("Prefix") or "(no filter: applies to the WHOLE bucket)"
        exp = rule.get("Expiration")
        print(f"- {rule.get('ID')}: status={rule.get('Status')} filter={flt} expiration={exp}")


@app.local_entrypoint()
def upload(path: str, version: str, notes: str = ""):
    with open(path, "rb") as f:
        data = f.read()
    signature = ""
    try:
        with open(path + ".sig", "r", encoding="utf-8") as f:
            signature = f.read().strip()
    except FileNotFoundError:
        print("WARNING: нет файла .sig — манифест автообновления не обновлён (собирали без TAURI_SIGNING_PRIVATE_KEY_PATH?)")
    print(f"uploading {path} ({len(data) / 1048576:.1f} MB) as v{version} …")
    print(put_installer.remote(data, version, signature, notes))


@app.function(image=image, secrets=[secret])
def put_manifest(version: str, signature: str, notes: str = "") -> dict:
    import json
    from datetime import datetime, timezone
    manifest = {"version": version, "notes": notes, "signature": signature,
                "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    _client().put_object(Bucket=os.environ["R2_BUCKET"], Key="downloads/windows/latest.json",
                         Body=json.dumps(manifest).encode(), ContentType="application/json")
    return manifest


@app.local_entrypoint()
def manifest(sig_path: str, version: str, notes: str = ""):
    """Переписать только манифест автообновления (откат или проверка): подпись берётся из <installer>.sig."""
    with open(sig_path, "r", encoding="utf-8") as f:
        signature = f.read().strip()
    print(put_manifest.remote(version, signature, notes))
