import base64
import io
import json
import os
import time
from collections import Counter

from flask import Flask, jsonify, request
from PIL import Image, ImageFilter, ImageOps
import ddddocr


HOST = os.environ.get("OCR_HOST", "127.0.0.1")
PORT = int(os.environ.get("OCR_PORT", "5000"))
SAVE_DEBUG = os.environ.get("OCR_SAVE_DEBUG", "0") == "1"
DEBUG_DIR = os.environ.get("OCR_DEBUG_DIR", os.path.join(os.getcwd(), "ocr_debug"))
BOX_PADDING = int(os.environ.get("OCR_BOX_PADDING", "8"))
UPSCALE = float(os.environ.get("OCR_UPSCALE", "2.5"))
ROW_MERGE_THRESHOLD = int(os.environ.get("OCR_ROW_MERGE_THRESHOLD", "18"))
PADDING_CANDIDATES = [
    int(item.strip())
    for item in os.environ.get("OCR_PADDING_CANDIDATES", "6,8,10,12").split(",")
    if item.strip()
]
UPSCALE_CANDIDATES = [
    float(item.strip())
    for item in os.environ.get("OCR_UPSCALE_CANDIDATES", "2.0,2.5,3.0").split(",")
    if item.strip()
]

app = Flask(__name__)

# 整图检测
detector = ddddocr.DdddOcr(det=True, ocr=False, show_ad=False)
# 单字识别：不能把 ocr 关掉，否则 classification() 会直接报“OCR功能未初始化”
classifier = ddddocr.DdddOcr(beta=True, show_ad=False)


def decode_base64_image(image_b64: str) -> bytes:
    if not image_b64:
        raise ValueError("缺少 image")
    if "," in image_b64:
        image_b64 = image_b64.split(",", 1)[1]
    return base64.b64decode(image_b64)


def clamp(value: int, low: int, high: int) -> int:
    return max(low, min(value, high))


def normalize_targets(targets) -> list[str]:
    result = []
    if not isinstance(targets, list):
        return result
    for item in targets:
        text = str(item or "").strip()
        if text:
            result.append(text[0])
    return result


def expand_box(box, width: int, height: int, padding: int = BOX_PADDING):
    x1, y1, x2, y2 = [int(v) for v in box[:4]]
    x1 = clamp(x1 - padding, 0, width)
    y1 = clamp(y1 - padding, 0, height)
    x2 = clamp(x2 + padding, 0, width)
    y2 = clamp(y2 + padding, 0, height)
    return [x1, y1, x2, y2]


def iter_expanded_boxes(box, width: int, height: int):
    seen = set()
    for padding in PADDING_CANDIDATES or [BOX_PADDING]:
        expanded = tuple(expand_box(box, width, height, padding=padding))
        if expanded in seen:
            continue
        seen.add(expanded)
        yield list(expanded), padding


def normalize_box(box):
    if not isinstance(box, (list, tuple)) or len(box) < 4:
        return None
    x1, y1, x2, y2 = [int(v) for v in box[:4]]
    if x2 < x1:
        x1, x2 = x2, x1
    if y2 < y1:
        y1, y2 = y2, y1
    return [x1, y1, x2, y2]


def box_width(box):
    return max(0, box[2] - box[0])


def box_height(box):
    return max(0, box[3] - box[1])


def box_area(box):
    return box_width(box) * box_height(box)


def box_center(box):
    return ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)


def merge_two_boxes(a, b):
    return [
        min(a[0], b[0]),
        min(a[1], b[1]),
        max(a[2], b[2]),
        max(a[3], b[3]),
    ]


def horizontal_gap(a, b):
    return max(0, max(a[0], b[0]) - min(a[2], b[2]))


def vertical_gap(a, b):
    return max(0, max(a[1], b[1]) - min(a[3], b[3]))


def overlap_ratio_1d(a1, a2, b1, b2):
    overlap = max(0, min(a2, b2) - max(a1, b1))
    base = max(1, min(a2 - a1, b2 - b1))
    return overlap / base


def pair_merge_score(a, b):
    ax, ay = box_center(a)
    bx, by = box_center(b)
    h_gap = horizontal_gap(a, b)
    v_gap = vertical_gap(a, b)
    y_overlap = overlap_ratio_1d(a[1], a[3], b[1], b[3])
    x_overlap = overlap_ratio_1d(a[0], a[2], b[0], b[2])
    area_penalty = abs(box_area(a) - box_area(b)) / max(1, max(box_area(a), box_area(b)))
    return (
        h_gap * 3
        + v_gap * 2
        + abs(ay - by) * (0.5 if y_overlap > 0.2 else 2.5)
        + abs(ax - bx) * (0.15 if x_overlap > 0.2 else 0.35)
        + area_penalty * 8
        - y_overlap * 10
        - x_overlap * 4
    )


def should_force_merge(a, b, median_width, median_height, median_area):
    aw, ah, aa = box_width(a), box_height(a), box_area(a)
    bw, bh, ba = box_width(b), box_height(b), box_area(b)
    merged = merge_two_boxes(a, b)
    mw, mh, ma = box_width(merged), box_height(merged), box_area(merged)

    h_gap = horizontal_gap(a, b)
    v_gap = vertical_gap(a, b)
    y_overlap = overlap_ratio_1d(a[1], a[3], b[1], b[3])
    x_overlap = overlap_ratio_1d(a[0], a[2], b[0], b[2])

    a_small = aa < median_area * 0.75 or aw < median_width * 0.75 or ah < median_height * 0.75
    b_small = ba < median_area * 0.75 or bw < median_width * 0.75 or bh < median_height * 0.75
    merged_reasonable = (
        mw < median_width * 1.8
        and mh < median_height * 1.8
        and ma < median_area * 2.2
    )

    horizontal_join = (
        y_overlap > 0.45
        and h_gap <= max(10, median_width * 0.18)
        and abs(box_center(a)[1] - box_center(b)[1]) <= max(10, median_height * 0.18)
    )
    vertical_join = (
        x_overlap > 0.35
        and v_gap <= max(10, median_height * 0.18)
        and abs(box_center(a)[0] - box_center(b)[0]) <= max(12, median_width * 0.22)
    )

    tiny_fragment_join = (
        (a_small or b_small)
        and (
            h_gap <= max(14, median_width * 0.25)
            or v_gap <= max(14, median_height * 0.25)
        )
        and merged_reasonable
    )

    return merged_reasonable and (horizontal_join or vertical_join or tiny_fragment_join)


def merge_fragmented_boxes(raw_boxes, target_count: int):
    boxes = [normalize_box(box) for box in raw_boxes]
    boxes = [box for box in boxes if box and box_area(box) > 0]
    if target_count <= 0 or len(boxes) <= target_count:
        return boxes

    widths = sorted(box_width(box) for box in boxes)
    heights = sorted(box_height(box) for box in boxes)
    areas = sorted(box_area(box) for box in boxes)
    median_width = widths[len(widths) // 2]
    median_height = heights[len(heights) // 2]
    median_area = areas[len(areas) // 2]

    changed = True
    while changed and len(boxes) > target_count:
        changed = False
        best_pair = None
        best_score = float("inf")

        for i in range(len(boxes)):
            for j in range(i + 1, len(boxes)):
                if not should_force_merge(
                    boxes[i],
                    boxes[j],
                    median_width,
                    median_height,
                    median_area,
                ):
                    continue
                score = pair_merge_score(boxes[i], boxes[j])
                if score < best_score:
                    best_score = score
                    best_pair = (i, j)

        if best_pair is not None:
            i, j = best_pair
            merged = merge_two_boxes(boxes[i], boxes[j])
            boxes = [box for idx, box in enumerate(boxes) if idx not in {i, j}] + [merged]
            changed = True

    while changed and len(boxes) > target_count:
        changed = False
        for index, box in list(enumerate(boxes)):
            is_small = (
                box_area(box) < median_area * 0.45
                or box_width(box) < median_width * 0.6
                or box_height(box) < median_height * 0.6
            )
            if not is_small:
                continue

            best_index = -1
            best_score = float("inf")
            for other_index, other in enumerate(boxes):
                if other_index == index:
                    continue
                score = pair_merge_score(box, other)
                if score < best_score:
                    best_score = score
                    best_index = other_index

            if best_index >= 0:
                merged = merge_two_boxes(boxes[index], boxes[best_index])
                keep = [item for i, item in enumerate(boxes) if i not in {index, best_index}]
                keep.append(merged)
                boxes = keep
                changed = True
                break

    while len(boxes) > target_count:
        best_pair = None
        best_score = float("inf")
        for i in range(len(boxes)):
            for j in range(i + 1, len(boxes)):
                score = pair_merge_score(boxes[i], boxes[j])
                if score < best_score:
                    best_score = score
                    best_pair = (i, j)

        if best_pair is None:
            break

        i, j = best_pair
        merged = merge_two_boxes(boxes[i], boxes[j])
        boxes = [box for idx, box in enumerate(boxes) if idx not in {i, j}] + [merged]

    return sorted(boxes, key=lambda box: (box[1], box[0]))


def save_debug_image(name: str, image: Image.Image):
    if not SAVE_DEBUG:
        return
    os.makedirs(DEBUG_DIR, exist_ok=True)
    image.save(os.path.join(DEBUG_DIR, name))


def save_debug_bytes(name: str, content: bytes):
    if not SAVE_DEBUG:
        return
    os.makedirs(DEBUG_DIR, exist_ok=True)
    with open(os.path.join(DEBUG_DIR, name), "wb") as file:
        file.write(content)


def save_debug_json(name: str, payload):
    if not SAVE_DEBUG:
        return
    os.makedirs(DEBUG_DIR, exist_ok=True)
    with open(os.path.join(DEBUG_DIR, name), "w", encoding="utf-8") as file:
        json.dump(payload, file, ensure_ascii=False, indent=2)


def image_to_png_bytes(image: Image.Image) -> bytes:
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def calc_dynamic_threshold(image: Image.Image) -> int:
    histogram = image.histogram()
    total = sum(histogram) or 1
    weighted = sum(index * count for index, count in enumerate(histogram))
    mean = weighted / total
    return int(max(110, min(190, mean)))


def extract_yellow_mask(image: Image.Image) -> Image.Image:
    rgb = image.convert("RGB")
    result = Image.new("L", rgb.size, 0)
    src = rgb.load()
    dst = result.load()
    width, height = rgb.size

    for y in range(height):
        for x in range(width):
            r, g, b = src[x, y]
            is_yellow = (
                r >= 150
                and g >= 110
                and b <= 170
                and r >= g
                and (r - b) >= 35
                and (g - b) >= 10
            )
            dst[x, y] = 255 if is_yellow else 0

    return result


def make_variants(image: Image.Image) -> list[tuple[str, Image.Image]]:
    w, h = image.size
    variants = [("orig", image)]
    seen_names = set(["orig"])

    for scale in UPSCALE_CANDIDATES or [UPSCALE]:
        scaled_size = (
            max(24, int(w * scale)),
            max(24, int(h * scale)),
        )
        enlarged = image.resize(scaled_size, Image.Resampling.LANCZOS)
        gray = ImageOps.grayscale(enlarged)
        auto = ImageOps.autocontrast(gray)
        sharp = auto.filter(ImageFilter.SHARPEN)
        median = sharp.filter(ImageFilter.MedianFilter(size=3))
        smooth = median.filter(ImageFilter.SMOOTH_MORE)
        invert_gray = ImageOps.invert(auto)
        dynamic_threshold = calc_dynamic_threshold(median)
        yellow_mask = extract_yellow_mask(enlarged)
        yellow_smooth = yellow_mask.filter(ImageFilter.MedianFilter(size=3))
        yellow_invert = ImageOps.invert(yellow_smooth)

        generated = [
            (f"enlarged_{scale}", enlarged),
            (f"gray_auto_{scale}", auto),
            (f"median_{scale}", median),
            (f"smooth_{scale}", smooth),
            (f"yellow_mask_{scale}", yellow_mask),
            (f"yellow_smooth_{scale}", yellow_smooth),
            (f"yellow_invert_{scale}", yellow_invert),
            (
                f"th_dynamic_{scale}",
                median.point(
                    lambda p, t=dynamic_threshold: 255 if p > t else 0,
                    mode="1",
                ).convert("L"),
            ),
            (
                f"th_low_{scale}",
                median.point(
                    lambda p, t=max(90, dynamic_threshold - 18): 255 if p > t else 0,
                    mode="1",
                ).convert("L"),
            ),
            (
                f"th_high_{scale}",
                median.point(
                    lambda p, t=min(210, dynamic_threshold + 18): 255 if p > t else 0,
                    mode="1",
                ).convert("L"),
            ),
            (f"invert_gray_{scale}", invert_gray),
            (
                f"invert_bin_{scale}",
                ImageOps.invert(
                    median.point(
                        lambda p, t=dynamic_threshold: 255 if p > t else 0,
                        mode="1",
                    ).convert("L"),
                ),
            ),
        ]

        for name, variant in generated:
            if name in seen_names:
                continue
            seen_names.add(name)
            variants.append((name, variant))

    return variants


def classify_crop(crop: Image.Image, target_set: set[str]):
    variants = make_variants(crop)
    score_map = Counter()
    debug_predictions = []

    for index, (name, variant) in enumerate(variants):
        result = (classifier.classification(image_to_png_bytes(variant)) or "").strip()
        char = result[:1] if result else ""
        debug_predictions.append({"variant": name, "result": result})
        if not char:
            continue

        weight = max(1, len(variants) - index)
        score_map[char] += weight
        if char in target_set:
            score_map[char] += 6

    if not score_map:
        return "", debug_predictions

    if target_set:
        target_scores = {char: score for char, score in score_map.items() if char in target_set}
        if target_scores:
            char = max(target_scores.items(), key=lambda item: (item[1], item[0]))[0]
            return char, debug_predictions

    char = max(score_map.items(), key=lambda item: (item[1], item[0]))[0]
    return char, debug_predictions


def normalize_y_rows(items: list[dict]) -> list[dict]:
    if not items:
        return items

    sorted_items = sorted(items, key=lambda item: item["y"])
    rows = []

    for item in sorted_items:
        if not rows or abs(item["y"] - rows[-1]["anchor_y"]) > ROW_MERGE_THRESHOLD:
            rows.append({"anchor_y": item["y"], "items": [item]})
        else:
            rows[-1]["items"].append(item)
            ys = [entry["y"] for entry in rows[-1]["items"]]
            rows[-1]["anchor_y"] = sum(ys) / len(ys)

    merged = []
    for row in rows:
        row_y = row["anchor_y"]
        for item in sorted(row["items"], key=lambda entry: entry["x"]):
            item["row_y"] = row_y
            merged.append(item)

    merged.sort(key=lambda item: (item["row_y"], item["x"]))
    return merged


def filter_by_targets(items: list[dict], targets: list[str]) -> list[dict]:
    if not targets:
        return items

    need = Counter(targets)
    grouped = {}
    for item in items:
        grouped.setdefault(item["text"], []).append(item)

    selected = []
    for char, count in need.items():
        candidates = grouped.get(char, [])
        if not candidates:
            continue
        candidates.sort(key=lambda item: (item["row_y"], item["x"]))
        selected.extend(candidates[:count])

    selected.sort(key=lambda item: (item["row_y"], item["x"]))
    return selected


def build_click_points(items: list[dict], targets: list[str]) -> list[dict]:
    if not targets:
        return []

    used_indexes = set()
    click_points = []

    for char in targets:
        match_index = -1
        for index, item in enumerate(items):
            if index in used_indexes:
                continue
            if item["text"] == char:
                match_index = index
                break

        if match_index >= 0:
            used_indexes.add(match_index)
            item = items[match_index]
            click_points.append(
                {
                    "text": item["text"],
                    "x": item["x"],
                    "y": item["y"],
                    "box": item["box"],
                }
            )

    return click_points


def detect_characters(image_bytes: bytes, targets: list[str]):
    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    width, height = image.size
    raw_boxes = detector.detection(image_bytes) or []
    merged_boxes = merge_fragmented_boxes(raw_boxes, len(targets)) if targets else [
        normalize_box(box) for box in raw_boxes
    ]
    merged_boxes = [box for box in merged_boxes if box]
    target_set = set(targets)
    results = []
    debug_items = []

    for index, box in enumerate(merged_boxes):
        box_best = None
        box_debug_predictions = []

        for norm_box, padding in iter_expanded_boxes(box, width, height):
            crop = image.crop(tuple(norm_box))
            text, debug_predictions = classify_crop(crop, target_set)
            target_hits = sum(
                1
                for item in debug_predictions
                if (item.get("result") or "")[:1] in target_set
            )
            non_empty_hits = sum(1 for item in debug_predictions if item.get("result"))
            score = target_hits * 100 + non_empty_hits
            candidate = {
                "text": text,
                "box": norm_box,
                "padding": padding,
                "score": score,
                "debug_predictions": debug_predictions,
                "crop": crop,
            }
            box_debug_predictions.append(
                {
                    "padding": padding,
                    "picked": text,
                    "score": score,
                    "predictions": debug_predictions,
                }
            )
            if not text:
                continue
            if box_best is None or candidate["score"] > box_best["score"]:
                box_best = candidate

        if not box_best:
            continue

        text = box_best["text"]
        if not text:
            continue

        item = {
            "text": text,
            "box": box_best["box"],
            "x": (box_best["box"][0] + box_best["box"][2]) / 2,
            "y": (box_best["box"][1] + box_best["box"][3]) / 2,
        }
        results.append(item)
        debug_items.append(
            {
                "index": index,
                "box": box_best["box"],
                "padding": box_best["padding"],
                "picked": text,
                "predictions": box_best["debug_predictions"],
                "attempts": box_debug_predictions,
            }
        )

        if SAVE_DEBUG:
            save_debug_image(f"{index:02d}_p{box_best['padding']}_{text}.png", box_best["crop"])

    normalized = normalize_y_rows(results)
    filtered = filter_by_targets(normalized, targets)
    return filtered, {
        "raw_box_count": len(raw_boxes),
        "merged_box_count": len(merged_boxes),
        "recognized_count": len(results),
        "filtered_count": len(filtered),
        "items": debug_items,
    }


@app.post("/ocr/click")
def ocr_click():
    started_at = time.time()
    try:
        payload = request.get_json(force=True, silent=False) or {}
        image_b64 = payload.get("image")
        targets = normalize_targets(payload.get("target") or [])

        image_bytes = decode_base64_image(image_b64)
        words, debug = detect_characters(image_bytes, targets)
        click_points = build_click_points(words, targets)
        request_id = time.strftime("%Y%m%d-%H%M%S") + f"-{int((time.time() % 1) * 1000):03d}"

        response = {
            "success": True,
            "data": words,
            "click_points": click_points,
            "target": targets,
            "count": len(words),
            "click_count": len(click_points),
            "elapsed_ms": int((time.time() - started_at) * 1000),
            "debug": {
                "request_id": request_id,
                "raw_box_count": debug["raw_box_count"],
                "merged_box_count": debug["merged_box_count"],
                "recognized_count": debug["recognized_count"],
                "filtered_count": debug["filtered_count"],
            },
        }

        if SAVE_DEBUG:
            save_debug_bytes(f"{request_id}_source.png", image_bytes)
            save_debug_json(
                f"{request_id}_result.json",
                {
                    "request_id": request_id,
                    "target": targets,
                    "raw_box_count": debug["raw_box_count"],
                    "merged_box_count": debug["merged_box_count"],
                    "recognized_count": debug["recognized_count"],
                    "filtered_count": debug["filtered_count"],
                    "data": words,
                    "click_points": click_points,
                    "items": debug["items"],
                },
            )
            response["debug"]["items"] = debug["items"]

        return jsonify(response)
    except Exception as exc:
        return jsonify({"success": False, "code": -1, "message": str(exc)}), 500


@app.get("/health")
def health():
    return jsonify({"success": True, "message": "ok"})


if __name__ == "__main__":
    if SAVE_DEBUG:
        os.makedirs(DEBUG_DIR, exist_ok=True)
    app.run(host=HOST, port=PORT)
