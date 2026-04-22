import json
import os
from io import BytesIO

from PIL import Image

from ddddocr_server import detect_characters


IMAGE_PATH = r"C:\Users\huangkaichong\Desktop\glm-ocr\5.png"
OUTPUT_DIR = r"C:\Users\huangkaichong\Desktop\glm-ocr\local_debug"
TARGETS = ["抱", "空", "部"]


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    for name in os.listdir(OUTPUT_DIR):
        if name.lower().endswith(".png"):
            os.remove(os.path.join(OUTPUT_DIR, name))

    with open(IMAGE_PATH, "rb") as f:
        image_bytes = f.read()

    image = Image.open(BytesIO(image_bytes)).convert("RGB")

    words, debug = detect_characters(image_bytes, TARGETS)
    print(f"原始检测框: {debug['raw_box_count']}")
    print(f"合并后框数: {debug['merged_box_count']}")
    print(f"最终识别数: {len(words)}")
    for item in words:
        print(f'  {item["text"]}: box={item["box"]}')

    for item in debug["items"]:
        final_crop = image.crop(tuple(item["box"]))
        final_name = f'{item["index"]:02d}_p{item.get("padding")}_{item["picked"]}.png'
        final_path = os.path.join(OUTPUT_DIR, final_name)
        final_crop.save(final_path)
        print(
            f'\n[index={item["index"]}] picked={item["picked"]} padding={item.get("padding")} box={item["box"]}'
        )
        print(f"  final_crop -> {final_path}")
        for attempt in item.get("attempts", []):
            print(
                f'  padding={attempt["padding"]} score={attempt["score"]} picked={attempt["picked"]}'
            )
            for pred in attempt.get("predictions", []):
                print(f'    {pred["variant"]:18s}: {pred["result"]}')

    result_path = os.path.join(OUTPUT_DIR, "local_result.json")
    with open(result_path, "w", encoding="utf-8") as file:
        json.dump(
            {
                "target": TARGETS,
                "raw_box_count": debug["raw_box_count"],
                "merged_box_count": debug["merged_box_count"],
                "recognized_count": debug["recognized_count"],
                "filtered_count": debug["filtered_count"],
                "data": words,
                "items": debug["items"],
            },
            file,
            ensure_ascii=False,
            indent=2,
        )
    print(f"\n结果 JSON 已保存到: {result_path}")

    print(f"\n调试图已保存到: {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
