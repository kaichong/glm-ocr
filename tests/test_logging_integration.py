import base64
import json
import os
import unittest
from pathlib import Path
import shutil
import tempfile
from unittest.mock import patch

import ddddocr_server as server


def any_base64() -> str:
    return base64.b64encode(b"not-a-real-image").decode("ascii")


class LoggingIntegrationTests(unittest.TestCase):
    def setUp(self):
        root = Path(".test-artifacts").resolve()
        os.makedirs(root, exist_ok=True)
        workspace_temp = (root / next(tempfile._get_candidate_names())).resolve()
        os.makedirs(workspace_temp, exist_ok=True)
        self.addCleanup(lambda: shutil.rmtree(workspace_temp, ignore_errors=True))
        self.log_dir = workspace_temp / "logs"
        server.app.config["TESTING"] = True
        self.client = server.app.test_client()

    def read_events(self):
        files = sorted(self.log_dir.glob("*.jsonl"))
        self.assertEqual(len(files), 1, f"expected one log file, got {files}")
        with files[0].open("r", encoding="utf-8") as handle:
            return [json.loads(line) for line in handle if line.strip()]

    def test_log_event_endpoint_writes_jsonl_record(self):
        with patch.object(server, "LOG_DIR", str(self.log_dir)):
            response = self.client.post(
                "/log/event",
                json={
                    "account": "foo@example.com",
                    "session_id": "session-1",
                    "event_type": "watch_start",
                    "page_url": "https://www.bigmodel.cn/glm-coding",
                    "detail": {"plan": "Pro", "cycle": "quarter"},
                },
            )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload["success"])

        events = self.read_events()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["source"], "userscript")
        self.assertEqual(events[0]["event_type"], "watch_start")
        self.assertEqual(events[0]["account"], "foo@example.com")
        self.assertEqual(events[0]["session_id"], "session-1")
        self.assertEqual(events[0]["page_url"], "https://www.bigmodel.cn/glm-coding")
        self.assertEqual(events[0]["detail"]["plan"], "Pro")

    def test_ocr_click_writes_structured_success_log(self):
        fake_result = [
            {"text": "抱", "x": 10, "y": 20, "box": [0, 0, 20, 20]},
            {"text": "空", "x": 30, "y": 20, "box": [20, 0, 40, 20]},
            {"text": "部", "x": 50, "y": 20, "box": [40, 0, 60, 20]},
        ]
        fake_debug = {
            "raw_box_count": 4,
            "merged_box_count": 3,
            "recognized_count": 3,
            "filtered_count": 3,
            "items": [],
        }

        with patch.object(server, "LOG_DIR", str(self.log_dir)):
            with patch.object(server, "detect_characters", return_value=(fake_result, fake_debug)):
                response = self.client.post(
                    "/ocr/click",
                    json={
                        "account": "foo@example.com",
                        "session_id": "session-ocr-1",
                        "image": any_base64(),
                        "target": ["抱", "空", "部"],
                    },
                )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload["success"])

        events = self.read_events()
        self.assertEqual(len(events), 2)
        self.assertEqual(events[0]["source"], "ocr-server")
        self.assertEqual(events[0]["event_type"], "ocr_request")
        self.assertEqual(events[0]["account"], "foo@example.com")
        self.assertEqual(events[1]["source"], "ocr-server")
        self.assertEqual(events[1]["event_type"], "ocr_success")
        self.assertEqual(events[1]["account"], "foo@example.com")
        self.assertEqual(events[1]["session_id"], "session-ocr-1")
        self.assertEqual(events[1]["detail"]["click_count"], 3)
        self.assertEqual(events[1]["detail"]["recognized_count"], 3)

    def test_logs_events_endpoint_filters_by_account_and_session(self):
        with patch.object(server, "LOG_DIR", str(self.log_dir)):
            server.emit_event(
                "userscript",
                "watch_start",
                account="foo@example.com",
                session_id="foo@example.com-ab12cd",
                detail={"plan": "Pro"},
            )
            server.emit_event(
                "userscript",
                "purchase_completed",
                account="foo@example.com",
                session_id="foo@example.com-ab12cd",
                detail={"hasQrCode": True},
            )
            server.emit_event(
                "userscript",
                "watch_start",
                account="bar@example.com",
                session_id="bar@example.com-ef34gh",
                detail={"plan": "Max"},
            )

            response = self.client.get(
                "/logs/events?account=foo@example.com&session_id=foo@example.com-ab12cd"
            )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["count"], 2)
        self.assertTrue(all(item["account"] == "foo@example.com" for item in payload["items"]))
        self.assertTrue(all(item["session_id"] == "foo@example.com-ab12cd" for item in payload["items"]))
        self.assertEqual(payload["items"][0]["event_label"], "开始监听")

    def test_logs_view_returns_html_page(self):
        response = self.client.get("/logs/view")

        self.assertEqual(response.status_code, 200)
        html = response.get_data(as_text=True)
        self.assertIn("GLM OCR Logs", html)
        self.assertIn("/logs/events", html)
        self.assertIn("开始监听", html)


if __name__ == "__main__":
    unittest.main()
