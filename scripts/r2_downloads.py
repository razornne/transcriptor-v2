"""Установщики приложения в R2 (префикс downloads/) — то, что отдаёт skriptly.io/api/download/windows.

Ключи берутся из Modal-секрета r2-secrets (локально ключей R2 нет):
  modal run scripts/r2_downloads.py::check
      — показывает правила жизненного цикла бакета. ВАЖНО: правило «удалять через 90 дней»
        должно быть ограничено префиксом recordings/, иначе оно удалит и установщик.
  modal run scripts/r2_downloads.py::upload --path desktop/src-tauri/target/release/bundle/nsis/Skriptly_0.6.0_x64-setup.exe --version 0.6.0
      — кладёт файл как downloads/windows/Skriptly-setup.exe («последний», его отдаёт сайт)
        и как downloads/windows/Skriptly_<версия>_x64-setup.exe (архив версий).
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
def put_installer(data: bytes, version: str) -> dict:
    bucket = os.environ["R2_BUCKET"]
    c = _client()
    meta = {"version": version, "sha256": hashlib.sha256(data).hexdigest()}
    keys = ["downloads/windows/Skriptly-setup.exe", f"downloads/windows/Skriptly_{version}_x64-setup.exe"]
    for k in keys:
        c.put_object(Bucket=bucket, Key=k, Body=data, ContentType="application/vnd.microsoft.portable-executable", Metadata=meta)
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
def upload(path: str, version: str):
    with open(path, "rb") as f:
        data = f.read()
    print(f"uploading {path} ({len(data) / 1048576:.1f} MB) as v{version} …")
    print(put_installer.remote(data, version))
