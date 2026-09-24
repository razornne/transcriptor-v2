"""Переразметка спикеров по голосу, когда число участников известно.

Soniox (и pyannote) на созвонах путают похожие голоса: на реальном звонке 24.09
(68 мин, 3 собеседника в канале звонка) Soniox отдал одну метку двум людям,
а третьего расщепил — хотя голосовые эмбеддинги (wespeaker) разделяют всех троих
уверенно (расстояние между центрами ≥0.53). Здесь реплики кластеризуются
по эмбеддингам голоса k-means'ом (косинус, k-means++, много рестартов) ровно
на k спикеров — k юзер указывает в поле Speakers.

Чистый numpy: эмбеддинги считает вызывающий код (modal_app.SpeakerEmbedder).
Агломеративка average-linkage (как в transcribe_long) на этом звонке сваливала
всё в один кластер — поэтому k-means.
"""
import numpy as np

MIN_EMBED_S = 1.0     # реплики короче — без эмбеддинга, метку берут у соседей
MAX_EMBED_S = 10.0    # длиннее — эмбеддинг по первым 10 с (голос один на реплику)
MIN_SEPARATION = 0.3  # центры ближе этого — голоса не различимы, оставляем как было
MIN_EMBEDDED_S = 30.0


def _norm(v: np.ndarray) -> np.ndarray:
    return v / (np.linalg.norm(v, axis=-1, keepdims=True) + 1e-9)


def kmeans_cosine(X: np.ndarray, k: int, w: np.ndarray, restarts: int = 48, seed: int = 0):
    """Сферический k-means с весами (длительность реплики) и k-means++ инициализацией.
    Возвращает (метки, центры) лучшего из рестартов по сумме косинусов."""
    rng = np.random.default_rng(seed)
    best = None
    for _ in range(restarts):
        C = [X[rng.integers(len(X))]]
        for _ in range(k - 1):
            d = np.clip(1 - np.max(X @ np.stack(C).T, axis=1), 0, None) ** 2
            C.append(X[rng.choice(len(X), p=d / d.sum())] if d.sum() > 0 else X[rng.integers(len(X))])
        C = np.stack(C)
        for _ in range(100):
            a = np.argmax(X @ C.T, axis=1)
            C2 = np.stack([_norm((X[a == j] * w[a == j, None]).sum(0)) if (a == j).any() else C[j] for j in range(k)])
            if np.allclose(C2, C):
                break
            C = C2
        a = np.argmax(X @ C.T, axis=1)
        score = float(((X * C[a]).sum(1) * w).sum())
        if best is None or score > best[0]:
            best = (score, a, C)
    return best[1], best[2]


def relabel(segments: list[dict], embeddings: list, k: int, first_index: int = 0) -> tuple[list[str], dict]:
    """Новые метки спикеров для `segments` (в том же порядке).

    embeddings[i] — вектор голоса реплики i или None (короткая/без звука).
    Реплики без эмбеддинга берут метку ближайшей по времени реплики с тем же
    исходным спикером (Soniox обычно прав внутри одного хода разговора).
    Спикеры нумеруются по первому появлению: SPEAKER_{first_index}, …
    Если голоса не разделяются уверенно — возвращает исходные метки (info["applied"]=False).
    """
    orig = [str(s["speaker"]) for s in segments]
    idx = [i for i, e in enumerate(embeddings) if e is not None]
    info = {"applied": False, "k": k}
    if k < 2 or len(idx) < 2 * k:
        info["reason"] = "too few voiced segments"
        return orig, info
    X = _norm(np.stack([np.asarray(embeddings[i], dtype=np.float64).reshape(-1) for i in idx]))
    w = np.array([min(MAX_EMBED_S, float(segments[i]["end"]) - float(segments[i]["start"])) for i in idx])
    if w.sum() < MIN_EMBEDDED_S:
        info["reason"] = "too little speech"
        return orig, info
    a, C = kmeans_cosine(X, k, w)
    dist = 1 - C @ C.T
    min_sep = float(dist[~np.eye(k, dtype=bool)].min())
    info["min_separation"] = round(min_sep, 3)
    if min_sep < MIN_SEPARATION or len(set(a.tolist())) < k:
        info["reason"] = "voices not separable"
        return orig, info

    cluster = {i: int(c) for i, c in zip(idx, a)}
    starts = [float(s["start"]) for s in segments]
    for i in range(len(segments)):
        if i in cluster:
            continue
        same = [j for j in idx if orig[j] == orig[i]] or idx
        j = min(same, key=lambda j: abs(starts[j] - starts[i]))
        cluster[i] = cluster[j]

    order: list[int] = []
    for i in sorted(range(len(segments)), key=lambda i: starts[i]):
        if cluster[i] not in order:
            order.append(cluster[i])
    name = {c: f"SPEAKER_{first_index + n:02d}" for n, c in enumerate(order)}
    new = [name[cluster[i]] for i in range(len(segments))]
    info.update(applied=True, changed=sum(1 for o, n in zip(orig, new) if o != n))
    return new, info
