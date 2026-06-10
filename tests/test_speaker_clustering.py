"""Тесты constrained-кластеризации спикеров long-пайплайна (ISS-8 / MYK-12).

Запуск:  python tests/test_speaker_clustering.py   (или pytest tests/)
Требует numpy (есть в проектном venv).
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modal_app import _cluster_speaker_embeddings, GLOBAL_SPK_THRESHOLD  # noqa: E402

DIM = 8


def _unit(angle_deg: float, wobble_deg: float = 0.0) -> list[float]:
    """Единичный вектор в плоскости (e1, e2) под углом angle к e1,
    с небольшим наклоном wobble в третью ось (шум 'того же голоса')."""
    a = math.radians(angle_deg)
    w = math.radians(wobble_deg)
    v = [math.cos(a) * math.cos(w), math.sin(a) * math.cos(w), math.sin(w)] + [0.0] * (DIM - 3)
    return v


def _groups_equal(labels: list[int], idx_a: list[int], idx_b: list[int]) -> bool:
    """Все элементы idx_a в одном кластере, все idx_b — в другом."""
    la = {labels[i] for i in idx_a}
    lb = {labels[i] for i in idx_b}
    return len(la) == 1 and len(lb) == 1 and la != lb


def test_cannot_link_blocks_similar_voices():
    """Звонок 1-на-1, голоса похожи: cosine dist между спикерами ~0.37 — ниже
    порога 0.68, БЕЗ cannot-link их бы склеило в одного (старый фейл).
    Оба спикера есть в каждом чанке → cannot-link держит их раздельно."""
    # A под углом 0°, B под углом ~52° → cos 52° ≈ 0.62 → dist ≈ 0.38
    chunk_ids, groups = [], []
    for chunk in range(3):
        chunk_ids.append(chunk)
        groups.append([_unit(0, wobble_deg=2 * chunk)])      # A_chunk
        chunk_ids.append(chunk)
        groups.append([_unit(52, wobble_deg=-2 * chunk)])    # B_chunk
    labels = _cluster_speaker_embeddings(chunk_ids, groups, None, GLOBAL_SPK_THRESHOLD)
    a_idx = [0, 2, 4]
    b_idx = [1, 3, 5]
    assert _groups_equal(labels, a_idx, b_idx), f"labels={labels}"


def test_seam_duplicate_merged():
    """Один человек, голос 'плывёт' на шве (dist ~0.6 между чанками из-за
    канала/шума). Со старым порогом 0.55 получался дубль SPEAKER_00 +
    SPEAKER_01; с 0.68 и cannot-link (нет общих чанков) — сливается."""
    # C в чанке 0 (0°), тот же голос в чанке 1 под углом 53° (dist ≈ 0.4)...
    # возьмём 60° → cos 60 = 0.5 → dist 0.5 < 0.68 → merge
    chunk_ids = [0, 1]
    groups = [[_unit(0)], [_unit(60)]]
    labels = _cluster_speaker_embeddings(chunk_ids, groups, None, GLOBAL_SPK_THRESHOLD)
    assert labels[0] == labels[1], f"seam duplicate not merged: {labels}"


def test_distinct_voices_across_chunks_stay_split():
    """Два по-настоящему разных голоса в РАЗНЫХ чанках (dist > порога) —
    не сливаются даже без cannot-link защиты."""
    chunk_ids = [0, 1]
    groups = [[_unit(0)], [_unit(90)]]  # ортогональны → dist 1.0
    labels = _cluster_speaker_embeddings(chunk_ids, groups, None, GLOBAL_SPK_THRESHOLD)
    assert labels[0] != labels[1]


def test_num_speakers_force_merges_phantom():
    """num_speakers=2, но pyannote нашёл фантомного 3-го в чанке 0 (близок к
    A). Cannot-link не даёт дослить до 2 → форс-фаза вливает фантом в
    ближайший кластер (A)."""
    chunk_ids = [0, 0, 0, 1, 1]
    groups = [
        [_unit(0)],    # A0
        [_unit(80)],   # B0
        [_unit(12)],   # P0 — фантом, близок к A
        [_unit(2)],    # A1
        [_unit(78)],   # B1
    ]
    labels = _cluster_speaker_embeddings(chunk_ids, groups, 2, GLOBAL_SPK_THRESHOLD)
    assert len(set(labels)) == 2, f"expected exactly 2 clusters: {labels}"
    assert labels[2] == labels[0] == labels[3], f"phantom not absorbed into A: {labels}"
    assert labels[1] == labels[4]


def test_multi_embeddings_robust_to_outlier():
    """Один шумный вектор (overlap-сегмент) не должен утаскивать сравнение:
    average-linkage по нескольким векторам остаётся ниже порога."""
    chunk_ids = [0, 1]
    groups = [
        [_unit(0), _unit(3), _unit(-3)],
        # тот же голос + один outlier-вектор (90°)
        [_unit(2), _unit(-2), _unit(90)],
    ]
    labels = _cluster_speaker_embeddings(chunk_ids, groups, None, GLOBAL_SPK_THRESHOLD)
    # mean dist ≈ (4 близких пары ~0 + 2 пары с outlier ~1.0)/9... считаем:
    # пар всего 3×3=9, из них 3 пары с outlier (dist~1), 6 пар ~0 → mean ~0.33 < 0.68
    assert labels[0] == labels[1], f"outlier vector broke the match: {labels}"


def test_single_and_empty():
    assert _cluster_speaker_embeddings([], [], None, 0.68) == []
    assert _cluster_speaker_embeddings([0], [[_unit(0)]], None, 0.68) == [0]


def test_three_speakers_three_chunks():
    """3 спикера, каждый в каждом из 3 чанков — классическая длинная запись."""
    angles = {0: 0, 1: 60, 2: 120}
    chunk_ids, groups, expected = [], [], []
    for chunk in range(3):
        for spk, ang in angles.items():
            chunk_ids.append(chunk)
            groups.append([_unit(ang, wobble_deg=3 * chunk), _unit(ang, wobble_deg=-2)])
            expected.append(spk)
    labels = _cluster_speaker_embeddings(chunk_ids, groups, None, GLOBAL_SPK_THRESHOLD)
    assert len(set(labels)) == 3, f"expected 3 clusters: {labels}"
    # проверяем согласованность разметки с ожидаемой группировкой
    mapping = {}
    for lab, exp in zip(labels, expected):
        mapping.setdefault(exp, lab)
        assert mapping[exp] == lab, f"speaker {exp} split across clusters: {labels}"


if __name__ == "__main__":
    failed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"  PASS {name}")
            except AssertionError as e:
                failed += 1
                print(f"  FAIL {name}: {e}")
    print("ALL OK" if not failed else f"{failed} FAILED")
    sys.exit(1 if failed else 0)
