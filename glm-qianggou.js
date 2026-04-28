// ==UserScript==
// @name         GLM Coding 抢购助手 (增强版) v1.8
// @namespace    http://tampermonkey.net/
// @version      1.8
// @description  准点自动点击指定套餐，支持时间自动校准（优先网站时间，失败则NTP），绕过限流，支持验证码等待与异常弹窗检测自动重试，并接入 ddddocr 点击验证码识别。
// @author       Codex
// @match        *://bigmodel.cn/*
// @match        https://*.bigmodel.cn/*
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      localhost
// @connect      127.0.0.1
// ==/UserScript==
//
// ============================================================
// 使用说明：
// 如遇弹窗（购买人数多/无价格）会自动重发。如遇腾讯验证码，会尝试通过本地 ddddocr 服务自动识别。
// 请确保本地 ddddocr HTTP 服务已启动，并将接口地址改成下方 OCR_API_URL。
// ============================================================

(function () {
  "use strict";

  if (window.__autoGlmSimple16Initialized) return;
  window.__autoGlmSimple16Initialized = true;

  const INVITE_CODE = "HSOWBABFLO";

  const OCR_API_URL = "http://127.0.0.1:5000/ocr/click";
  let originalFetch = null; // 用于时间校准获取真实时间
  const LOG_API_URL = "http://127.0.0.1:5000/log/event";
  const OCR_API_TIMEOUT = 8000;
  const LOG_API_TIMEOUT = 3000;
  const CAPTCHA_EXPECTED_TARGET_COUNT = 3;
  const WINDOW_RANDOM_ID = Math.random().toString(36).slice(2, 8);

  function getGlmCodingInviteTarget(target = "/glm-coding") {
    try {
      const url = new URL(target, window.location.origin);
      if (!url.pathname.startsWith("/glm-coding")) return target;
      url.searchParams.set("ic", INVITE_CODE);
      return `${url.pathname}${url.search}${url.hash}`;
    } catch (_) {
      return `/glm-coding?ic=${encodeURIComponent(INVITE_CODE)}`;
    }
  }

  (function injectInviteCode() {
    try {
      const { pathname, search, origin, hash } = window.location;
      if (!pathname.startsWith("/glm-coding")) return;

      const params = new URLSearchParams(search);
      if (params.get("ic") === INVITE_CODE) return;

      params.set("ic", INVITE_CODE);
      const targetUrl = `${origin}${pathname}?${params.toString()}${hash}`;
      window.history.replaceState(null, "", targetUrl);

      if (
        document.readyState === "complete" &&
        !sessionStorage.getItem("glm_ic_injected")
      ) {
        sessionStorage.setItem("glm_ic_injected", "1");
        location.replace(targetUrl);
      }
    } catch (_) {
      /* 静默失败，不影响主流程 */
    }
  })();

  // ==========================================
  // 时间校准模块
  // ==========================================

  const TIME_SYNC = {
    offset: 0, // 本地时间与服务器时间的偏差 (serverTime = localTime + offset)
    lastSyncTime: 0, // 上次同步时间戳
    syncIntervalMs: 60 * 1000, // 每60秒同步一次
    isSynced: false, // 是否已成功同步过
    source: null, // 当前时间源: 'website' | 'ntp'

    // 获取校正后的当前时间
    now: function () {
      return Date.now() + this.offset;
    },

    // 获取距离目标时间的剩余毫秒数 (使用校正后时间)
    getRemainingMs: function (targetTimestamp) {
      return targetTimestamp - this.now();
    },

    // 获取距离目标时间的格式化倒计时
    getCountdown: function (targetTimestamp) {
      const diff = this.getRemainingMs(targetTimestamp);
      if (diff <= 0) return null;
      const h = Math.floor(diff / (1000 * 60 * 60));
      const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const s = Math.floor((diff % (1000 * 60)) / 1000);
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    },

    // 方式1: 从网站获取服务器时间 (使用原始fetch避免被拦截)
    syncFromWebsite: async function () {
      try {
        // 使用 originalFetch 避免被脚本拦截，获取真实的服务器时间
        const startTime = Date.now();
        const response = await originalFetch("https://www.bigmodel.cn/");

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        // 从响应头获取服务器时间
        const dateHeader = response.headers.get("Date");
        if (!dateHeader) {
          throw new Error("响应中没有 Date 头");
        }

        const serverTime = new Date(dateHeader).getTime();
        if (isNaN(serverTime)) {
          throw new Error("Date 头解析失败");
        }

        // 用往返时间的一半作为延迟补偿
        const endTime = Date.now();
        const roundTrip = endTime - startTime;
        const localTime = startTime + roundTrip / 2;
        const newOffset = serverTime - localTime;

        console.log(
          `[TimeSync] 网站时间同步成功: offset=${newOffset.toFixed(0)}ms, serverTime=${new Date(serverTime).toLocaleString()}`,
        );
        return {
          success: true,
          offset: newOffset,
          source: "website",
          serverTime,
        };
      } catch (error) {
        console.warn(`[TimeSync] 网站时间同步失败: ${error.message}`);
        return { success: false, error: error.message };
      }
    },

    // 方式2: 从大网站获取时间 (直接从响应头Date取)
    syncFromBackupSite: async function () {
      try {
        // 使用国内大网站，它们的服务器时间非常准确
        const backupSites = [
          "https://www.baidu.com/",
          "https://www.taobao.com/",
        ];

        for (const url of backupSites) {
          try {
            const startTime = Date.now();
            const response = await fetch(url, {
              cache: "no-cache",
              mode: "cors",
            });

            if (!response.ok) continue;

            const endTime = Date.now();

            // 直接从响应头取 Date
            const dateHeader = response.headers.get("Date");
            if (!dateHeader) continue;

            const serverTime = new Date(dateHeader).getTime();
            if (isNaN(serverTime)) continue;

            // 用往返时间的一半作为延迟补偿
            const roundTrip = endTime - startTime;
            const localTime = startTime + roundTrip / 2;
            const newOffset = serverTime - localTime;

            console.log(
              `[TimeSync] 备用网站时间同步成功: source=${url}, offset=${newOffset.toFixed(0)}ms`,
            );
            return {
              success: true,
              offset: newOffset,
              source: "backup",
              serverTime,
            };
          } catch (e) {
            console.warn(`[TimeSync] 备用网站 ${url} 失败: ${e.message}`);
            continue;
          }
        }

        throw new Error("所有备用网站都失败");
      } catch (error) {
        console.warn(`[TimeSync] 备用网站时间同步失败: ${error.message}`);
        return { success: false, error: error.message };
      }
    },

    // 综合同步: 优先网站，失败则备用网站
    sync: async function () {
      // 优先尝试目标网站时间
      let result = await this.syncFromWebsite();

      // 如果网站失败，尝试备用网站(百度/淘宝)
      if (!result.success) {
        console.log("[TimeSync] 目标网站时间不可用，尝试备用网站...");
        result = await this.syncFromBackupSite();
      }

      if (result.success) {
        this.offset = result.offset;
        this.lastSyncTime = Date.now();
        this.isSynced = true;
        this.source = result.source;

        // 上报到日志系统
        sendStructuredLog("time_sync", {
          offset: result.offset,
          source: result.source,
          serverTime: result.serverTime,
        });

        return { success: true, ...result };
      }

      return { success: false, error: "所有时间源都不可用" };
    },

    // 检查是否需要同步
    needsSync: function () {
      return (
        !this.isSynced || Date.now() - this.lastSyncTime > this.syncIntervalMs
      );
    },

    // 获取状态信息
    getStatus: function () {
      return {
        isSynced: this.isSynced,
        source: this.source,
        offset: this.offset,
        lastSyncTime: this.lastSyncTime,
        nextSyncIn: Math.max(
          0,
          this.syncIntervalMs - (Date.now() - this.lastSyncTime),
        ),
      };
    },
  };

  // 后台定期同步时间 (每60秒检查一次)
  async function startTimeSyncLoop() {
    // 延迟一下确保页面加载完成
    await new Promise((r) => setTimeout(r, 1000));

    // 首次同步
    const result = await TIME_SYNC.sync();
    if (!result.success && !TIME_SYNC.isSynced) {
      console.warn("[TimeSync] 首次同步失败，将在下次检查时重试");
      // 稍后重试一次
      setTimeout(async () => {
        if (TIME_SYNC.needsSync()) {
          await TIME_SYNC.sync();
        }
      }, 10000);
    }

    // 定时检查
    setInterval(async () => {
      if (TIME_SYNC.needsSync()) {
        console.log("[TimeSync] 开始定时同步...");
        await TIME_SYNC.sync();
      }
    }, 30000); // 每30秒检查一次
  }

  function getAccountLabel() {
    const accountNode = document.querySelector(
      ".user-dropdown-menu .inner-link",
    );
    const rawText = (accountNode?.textContent || "").trim();
    if (!rawText) return "unknown";
    return rawText
      .replace(/\s+/g, " ")
      .replace(/[\\/:*?"<>|]/g, "_")
      .slice(0, 80);
  }

  function getWindowSessionId() {
    return `${getAccountLabel()}-${WINDOW_RANDOM_ID}`;
  }

  // ==========================================
  // 网络拦截层
  // ==========================================

  // 保存原始 fetch，后续用于时间校准
  originalFetch = window.fetch;

  // 1. 绕过限流接口
  window.fetch = async function (...args) {
    const [input] = args;
    const requestUrl =
      typeof input === "string" ? input : input?.url || String(input || "");
    if (requestUrl.includes("/api/biz/rate-limit/check")) {
      console.log("[Auto-GLM-1.7] 拦截限流检查，强制放行");
      return new Response(
        JSON.stringify({
          code: 0,
          msg: "success",
          data: null,
          success: true,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    const response = await originalFetch.apply(this, args);
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const clone = response.clone();
      try {
        let text = await clone.text();
        if (
          text.includes('"isSoldOut":true') ||
          text.includes('"disabled":true') ||
          text.includes('"soldOut":true')
        ) {
          console.log("[Auto-GLM-1.7] 拦截售罄数据:", requestUrl);
          text = text
            .replace(/"isSoldOut":true/g, '"isSoldOut":false')
            .replace(/"disabled":true/g, '"disabled":false')
            .replace(/"soldOut":true/g, '"soldOut":false')
            .replace(/"stock":0/g, '"stock":999');
          return new Response(text, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }
      } catch (e) {
        console.log("[Auto-GLM-1.7] Fetch拦截异常:", e.message);
      }
    }
    return response;
  };

  // 2. 绕过 XHR 售罄数据
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._reqUrl = url;
    return originalXHROpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("readystatechange", function () {
      if (this.readyState === 4 && this.status === 200) {
        const contentType = this.getResponseHeader("content-type") || "";
        if (contentType.includes("application/json")) {
          try {
            let text = this.responseText;
            if (
              text.includes('"isSoldOut":true') ||
              text.includes('"disabled":true') ||
              text.includes('"soldOut":true')
            ) {
              console.log("[Auto-GLM-1.7] 拦截XHR售罄数据:", this._reqUrl);
              text = text
                .replace(/"isSoldOut":true/g, '"isSoldOut":false')
                .replace(/"disabled":true/g, '"disabled":false')
                .replace(/"soldOut":true/g, '"soldOut":false')
                .replace(/"stock":0/g, '"stock":999');
              Object.defineProperty(this, "responseText", {
                get: function () {
                  return text;
                },
              });
              Object.defineProperty(this, "response", {
                get: function () {
                  return JSON.parse(text);
                },
              });
            }
          } catch (e) {
            console.log("[Auto-GLM-1.7] XHR拦截异常:", e.message);
          }
        }
      }
    });
    originalXHRSend.apply(this, args);
  };

  // 3. 绕过 rate-limit 页面跳转
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  history.pushState = function (...args) {
    const url = args[2] || "";
    if (url && url.includes("rate-limit")) {
      console.log(
        "[Auto-GLM-1.7] 拦截 pushState 跳转至限流页，强制跳转回目标页",
      );
      setTimeout(
        () => {
          history.pushState(null, "", getGlmCodingInviteTarget());
        },
        Math.floor(Math.random() * 701) + 500,
      );
      return;
    }
    return originalPushState.apply(this, args);
  };
  history.replaceState = function (...args) {
    const url = args[2] || "";
    if (url && url.includes("rate-limit")) {
      console.log(
        "[Auto-GLM-1.7] 拦截 replaceState 跳转至限流页，强制跳转回目标页",
      );
      setTimeout(
        () => {
          history.replaceState(null, "", getGlmCodingInviteTarget());
        },
        Math.floor(Math.random() * 701) + 500,
      );
      return;
    }
    return originalReplaceState.apply(this, args);
  };

  console.log("[Auto-GLM-1.7] 网络拦截器已注册");

  // ==========================================
  // 页面状态层
  // ==========================================

  const CAPTCHA_WRAPPER_ID = "tcaptcha_transform_dy";

  // 多维度验证码状态检测
  function isCaptchaVisible() {
    const wrapper = document.getElementById(CAPTCHA_WRAPPER_ID);
    if (!wrapper) return false;

    // 检查计算样式
    const style = window.getComputedStyle(wrapper);

    // 未激活时处于绝对定位隐藏态，激活时为 fixed
    if (style.position !== "fixed") return false;
    if (parseFloat(style.opacity) < 0.5) return false;
    if (style.display === "none") return false;

    const popupType = document.querySelector(".tencent-captcha-dy__popup-type");
    if (!popupType) return false;

    return true;
  }

  async function getImgFromBackground(selector) {
    const el = document.querySelector(selector);
    if (!el) return null;

    // 从 computedStyle 中提取 url("...") 里的链接
    const bgImg = window.getComputedStyle(el).backgroundImage;
    const url = bgImg.match(/url\("?(.+?)"?\)/)?.[1];
    console.log(url);

    if (!url) {
      console.error("未能从背景中提取到图片 URL");
      return null;
    }

    // 创建一个新的图片对象并等待加载
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous"; // 尝试处理跨域
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  }

  function normalizeTargetChars(rawText) {
    return (rawText || "")
      .replace(/\s+/g, "")
      .replace(/请(?:依次|按顺序)?点击[：:「『【“"]?/g, "")
      .replace(/[」』】”",，。；;！？!?、]/g, "")
      .split("")
      .filter(Boolean);
  }

  function getBoxCenter(box) {
    if (!Array.isArray(box) || box.length < 4) return null;

    if (box.length >= 8) {
      return {
        x: (box[0] + box[2] + box[4] + box[6]) / 4,
        y: (box[1] + box[3] + box[5] + box[7]) / 4,
      };
    }

    const [x1, y1, x2, y2] = box.map(Number);
    return {
      x: (x1 + x2) / 2,
      y: (y1 + y2) / 2,
    };
  }

  function normalizeDdddocrResult(response) {
    const payload = response?.data ?? response?.result ?? response;
    const candidates = [];

    const pushCandidate = (item) => {
      if (!item) return;
      const text = String(item.text ?? item.char ?? item.label ?? "").trim();
      if (!text) return;

      if (typeof item.x === "number" && typeof item.y === "number") {
        candidates.push({ text, x: item.x, y: item.y });
        return;
      }

      const center = getBoxCenter(
        item.box ?? item.bbox ?? item.rect ?? item.points,
      );
      if (center) {
        candidates.push({ text, x: center.x, y: center.y });
      }
    };

    if (Array.isArray(payload)) {
      payload.forEach(pushCandidate);
    } else if (Array.isArray(payload?.items)) {
      payload.items.forEach(pushCandidate);
    } else if (Array.isArray(payload?.targets)) {
      payload.targets.forEach(pushCandidate);
    } else if (Array.isArray(payload?.words)) {
      payload.words.forEach(pushCandidate);
    } else if (Array.isArray(payload?.texts) && Array.isArray(payload?.boxes)) {
      payload.texts.forEach((text, index) => {
        pushCandidate({ text, box: payload.boxes[index] });
      });
    } else if (Array.isArray(payload?.detections)) {
      payload.detections.forEach(pushCandidate);
    }

    return candidates;
  }

  function normalizeClickPoints(response) {
    const points = response?.click_points;
    if (!Array.isArray(points)) return [];

    return points
      .map((item) => {
        const text = String(item?.text ?? "").trim();
        const x = Number(item?.x);
        const y = Number(item?.y);
        if (!text || !Number.isFinite(x) || !Number.isFinite(y)) return null;
        return { text, x, y };
      })
      .filter(Boolean);
  }

  function getCaptchaRoot() {
    return (
      document.getElementById(CAPTCHA_WRAPPER_ID) ||
      document.querySelector(".tencent-captcha-dy")
    );
  }

  function safeStringify(value) {
    try {
      return JSON.stringify(value);
    } catch (error) {
      return JSON.stringify({
        message: "stringify_failed",
        error: error?.message || String(error),
      });
    }
  }

  function sendStructuredLog(eventType, detail = {}) {
    const account = getAccountLabel();
    const payload = {
      account,
      session_id: getWindowSessionId(),
      event_type: eventType,
      page_url: location.href,
      detail,
    };

    console.log("[Auto-GLM-EVENT]", payload);
    GM_xmlhttpRequest({
      method: "POST",
      url: LOG_API_URL,
      headers: { "Content-Type": "application/json" },
      timeout: LOG_API_TIMEOUT,
      data: safeStringify(payload),
      onload: () => {},
      ontimeout: () => {
        console.warn("[Auto-GLM-EVENT] 日志服务超时:", eventType);
      },
      onerror: () => {
        console.warn("[Auto-GLM-EVENT] 日志服务连接失败:", eventType);
      },
    });
  }

  function isElementVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (parseFloat(style.opacity || "1") <= 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findCaptchaCloseButton() {
    const root = getCaptchaRoot();
    if (!root) return null;

    const selectorCandidates = [
      ".tencent-captcha-dy__header-close",
      ".tencent-captcha-dy__close",
      ".close",
      "[aria-label*='关闭']",
      "[title*='关闭']",
    ];

    for (const selector of selectorCandidates) {
      const el = root.querySelector(selector);
      if (isElementVisible(el)) return el;
    }

    return (
      Array.from(root.querySelectorAll("button, span, i, div")).find((el) => {
        const text = `${el.textContent || ""} ${el.getAttribute?.("aria-label") || ""} ${el.getAttribute?.("title") || ""}`;
        return /关闭|取消|×|✕|✖/.test(text) && isElementVisible(el);
      }) || null
    );
  }

  function findCaptchaConfirmButton() {
    const root = getCaptchaRoot();
    if (!root) return null;

    const selectorCandidates = [
      ".tencent-captcha-dy__verify-confirm-btn",
      ".tencent-captcha-dy__submit",
      ".tencent-captcha-dy__btn--primary",
      ".tencent-captcha-dy__footer button",
      "button",
      "[role='button']",
    ];

    for (const selector of selectorCandidates) {
      const matched = Array.from(root.querySelectorAll(selector)).find((el) => {
        const text =
          `${el.textContent || ""} ${el.getAttribute?.("aria-label") || ""}`.trim();
        return /确定|确认|提交|完成|验证/.test(text) && isElementVisible(el);
      });
      if (matched) return matched;
    }

    return null;
  }

  function closeCaptchaPopup(reason = "") {
    const closeBtn = findCaptchaCloseButton();
    if (!closeBtn) {
      console.warn("[OCR] 未找到验证码关闭按钮", reason);
      return false;
    }
    console.warn("[OCR] 关闭验证码弹窗:", reason);
    return dispatchRealClick(closeBtn);
  }

  function submitCaptchaSelection() {
    const confirmBtn = findCaptchaConfirmButton();
    if (!confirmBtn) {
      console.warn("[OCR] 未找到验证码确认按钮");
      return false;
    }
    console.log("[OCR] 点击验证码确认按钮");
    try {
      confirmBtn.scrollIntoView({
        block: "center",
        inline: "center",
        behavior: "auto",
      });
    } catch {}
    try {
      confirmBtn.focus({ preventScroll: true });
    } catch {}
    const rect = confirmBtn.getBoundingClientRect();
    const eventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: unsafeWindow,
      clientX: rect.left + Math.max(1, rect.width / 2),
      clientY: rect.top + Math.max(1, rect.height / 2),
    };
    ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(
      (type) => dispatchMouseLikeEvent(confirmBtn, type, eventInit),
    );
    return true;
  }

  function buildCaptchaFingerprint(imgUrl, targets) {
    return `${imgUrl}::${targets.join("")}`;
  }

  // OCR 接口 - 调用本地 ddddocr HTTP 服务
  async function solveCaptchaViaOCR() {
    try {
      const bgDiv = document.querySelector(
        ".tencent-captcha-dy__verify-bg-img",
      );
      const header = document.querySelector(".tencent-captcha-dy__header-text");

      if (!bgDiv || !header) return false;

      // 1. 提取背景图 URL
      const bgStyle = window.getComputedStyle(bgDiv).backgroundImage;
      const imgUrl = bgStyle.match(/url\(["']?(.*?)["']?\)/)?.[1];
      console.log(imgUrl);
      if (!imgUrl) return false;

      // 2. 提取文字顺序
      const rawText = header.getAttribute("aria-label") || header.innerText;
      const targets = normalizeTargetChars(rawText);
      console.log("[OCR] 目标顺序:", targets);
      if (targets.length === 0) {
        console.warn("[OCR] 未解析出目标字符:", rawText);
        return false;
      }

      const fingerprint = buildCaptchaFingerprint(imgUrl, targets);
      if (captchaActionState.fingerprint !== fingerprint) {
        captchaActionState = { fingerprint, stage: "idle" };
      } else if (captchaActionState.stage === "submitted") {
        console.log("[OCR] 当前验证码已完成点击并提交，等待结果");
        return true;
      } else if (captchaActionState.stage === "closed") {
        console.log("[OCR] 当前验证码已关闭，等待弹窗消失");
        return false;
      }

      if (targets.length !== CAPTCHA_EXPECTED_TARGET_COUNT) {
        captchaActionState.stage = "closed";
        closeCaptchaPopup(
          `目标字数不是 ${CAPTCHA_EXPECTED_TARGET_COUNT}，实际为 ${targets.length}`,
        );
        return false;
      }

      // 3. 加载图片转 base64
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = imgUrl;
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
      });

      console.log("[OCR] 图片尺寸:", img.width, "x", img.height);

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);
      const fullBase64 = canvas.toDataURL("image/png");
      const imgBase64 = fullBase64.split(",")[1];
      console.log("[OCR] base64 长度:", imgBase64 ? imgBase64.length : 0);

      // 4. 调用 ddddocr 服务
      const response = await new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "POST",
          url: OCR_API_URL,
          headers: { "Content-Type": "application/json" },
          timeout: OCR_API_TIMEOUT,
          data: JSON.stringify({
            account: getAccountLabel(),
            session_id: getWindowSessionId(),
            page_url: location.href,
            image: imgBase64,
            target: targets,
          }),
          onload: (r) => {
            console.log("[OCR] 响应状态:", r.status);
            console.log("[OCR] 响应内容:", r.responseText);
            resolve(JSON.parse(r.responseText));
          },
          ontimeout: () => reject(new Error("OCR 服务超时")),
          onerror: () => reject(new Error("OCR 服务连接失败")),
        });
      });

      if (response?.success === false || response?.code === -1) {
        console.warn("[OCR] 识别失败:", response);
        return false;
      }

      const clickPoints = normalizeClickPoints(response);
      if (clickPoints.length > 0) {
        console.log(
          "[OCR] click_points:",
          clickPoints
            .map(
              (w) =>
                `"${w.text}"@(${Number(w.x).toFixed(0)},${Number(w.y).toFixed(0)})`,
            )
            .join(", "),
        );
      }

      const words = normalizeDdddocrResult(response);
      console.log(
        "[OCR] 识别结果:",
        words
          .map(
            (w) =>
              `"${w.text}"@(${Number(w.x).toFixed(0)},${Number(w.y).toFixed(0)})`,
          )
          .join(", "),
      );

      if (words.length === 0 && clickPoints.length === 0) {
        console.warn("[OCR] 未能识别到任何文字");
        return false;
      }

      // 5. 按顺序匹配并点击
      const scaleX = bgDiv.offsetWidth / img.width;
      const scaleY = bgDiv.offsetHeight / img.height;
      const orderedPoints =
        clickPoints.length > 0
          ? clickPoints
          : (() => {
              const usedIndexes = new Set();
              const fallbackPoints = [];

              for (const char of targets) {
                const matchIndex = words.findIndex(
                  (w, index) => !usedIndexes.has(index) && w.text === char,
                );
                const match = matchIndex >= 0 ? words[matchIndex] : null;
                if (match) {
                  usedIndexes.add(matchIndex);
                  fallbackPoints.push(match);
                } else {
                  console.warn(`[OCR] 未找到字符: ${char}`);
                }
              }

              return fallbackPoints;
            })();

      sendStructuredLog("ocr_result_received", {
        targetCount: targets.length,
        recognizedCount: words.length,
        clickPointCount: orderedPoints.length,
        targets,
        clickTexts: orderedPoints.map((point) => point.text),
        isThreeChars: orderedPoints.length === CAPTCHA_EXPECTED_TARGET_COUNT,
      });

      if (orderedPoints.length !== CAPTCHA_EXPECTED_TARGET_COUNT) {
        sendStructuredLog("ocr_result_not_3", {
          expectedCount: CAPTCHA_EXPECTED_TARGET_COUNT,
          actualCount: orderedPoints.length,
          targets,
          clickTexts: orderedPoints.map((point) => point.text),
        });
        console.warn(
          `[OCR] 识别结果不是 ${CAPTCHA_EXPECTED_TARGET_COUNT} 个字，实际为 ${orderedPoints.length}，关闭验证码`,
        );
        captchaActionState.stage = "closed";
        closeCaptchaPopup(`识别结果不是 ${CAPTCHA_EXPECTED_TARGET_COUNT} 个字`);
        return false;
      }

      captchaActionState.stage = "clicking";
      let clickedCount = 0;
      for (const point of orderedPoints) {
        const x = point.x * scaleX;
        const y = point.y * scaleY;

        console.log(
          `[OCR] 点击字符 "${point.text}" 于 (${x.toFixed(0)}, ${y.toFixed(0)})`,
        );
        await simulateSmartClick(bgDiv, x, y);
        await new Promise((r) => setTimeout(r, 200));
        clickedCount++;
      }

      console.log(`[OCR] 完成点击 ${clickedCount}/${targets.length} 个字符`);
      if (clickedCount === CAPTCHA_EXPECTED_TARGET_COUNT) {
        await new Promise((r) => setTimeout(r, 250));
        submitCaptchaSelection();
        sendStructuredLog("ocr_submit", {
          clickedCount,
          targets,
        });
        captchaActionState.stage = "submitted";
        return true;
      }

      captchaActionState.stage = "closed";
      closeCaptchaPopup("点击数量不足 3 个");
      return false;
    } catch (error) {
      captchaActionState.stage = "idle";
      sendStructuredLog("ocr_request_failed", {
        message: error?.message || String(error),
      });
      console.error("[OCR] 过程出错:", error);
      return false;
    }
  }

  // 核心模拟点击辅助函数
  async function simulateSmartClick(el, x, y) {
    const rect = el.getBoundingClientRect();
    const clientX = rect.left + x;
    const clientY = rect.top + y;
    const opts = { clientX, clientY, bubbles: true, composed: true };

    el.dispatchEvent(new MouseEvent("mousedown", opts));
    await new Promise((r) => setTimeout(r, 20 + Math.random() * 30)); // 模拟按压
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  }

  // 统一弹窗检测
  function detectDialogState() {
    const dialogWrappers = document.querySelectorAll(".el-dialog__wrapper");
    for (const wrapper of Array.from(dialogWrappers)) {
      if (wrapper.style.display === "none") continue;

      // 1. 检测 "购买人数较多"
      const emptyWrap = wrapper.querySelector(".empty-data-wrap");
      if (emptyWrap?.textContent?.includes("购买人数较多")) {
        return {
          type: "busy",
          closeBtn: wrapper.querySelector(".el-dialog__headerbtn"),
        };
      }

      // 2. 检测 支付相关弹窗
      const isPayDialog =
        wrapper.querySelector(".pay-dialog") ||
        wrapper.querySelector(".scan-code-box") ||
        wrapper.querySelector(".confirm-pay-btn");

      if (isPayDialog) {
        const hasQrCode = Boolean(
          wrapper.querySelector(
            ".scan-code-box img, .scan-code-box canvas, .qrcode img, .qrcode canvas, [class*='qrcode'] img, [class*='qrcode'] canvas",
          ),
        );
        let hasRealPrice = false;

        // 策略A：检测 .price-item 包含数字
        const priceItems = wrapper.querySelectorAll(".price-item");
        for (const el of Array.from(priceItems)) {
          const text = el.textContent.replace(/[￥\s]/g, "").trim();
          if (text.length > 0 && /\d/.test(text)) {
            hasRealPrice = true;
            break;
          }
        }

        // 策略B：检测 .info-price 中的 span（除了￥符号那个）包含数字
        if (!hasRealPrice) {
          const infoPriceSpans = wrapper.querySelectorAll(
            ".info-price > span:not(.price-icon)",
          );
          for (const el of Array.from(infoPriceSpans)) {
            const text = el.textContent.replace(/[￥\s]/g, "").trim();
            if (text.length > 0 && /\d/.test(text)) {
              hasRealPrice = true;
              break;
            }
          }
        }

        if (hasRealPrice) {
          if (hasQrCode) {
            return {
              type: "qr-pay",
              hasQrCode: true,
              closeBtn: wrapper.querySelector(".el-dialog__headerbtn"),
            };
          }
          return {
            type: "success-pay",
            hasQrCode,
            closeBtn: wrapper.querySelector(".el-dialog__headerbtn"),
          };
        }

        if (wrapper.querySelector(".confirm-pay-btn")) {
          return {
            type: "confirm-pay",
            hasQrCode,
            closeBtn: wrapper.querySelector(".el-dialog__headerbtn"),
          };
        }

        // 走到这一步说明弹出了购买框，但是金额里没内容
        return {
          type: "empty-price",
          hasQrCode,
          closeBtn: wrapper.querySelector(".el-dialog__headerbtn"),
        };
      }
    }
    return null;
  }

  function refreshStatus() {
    const el = document.getElementById("glm-simple-status-v16");
    const renderedText = lastStatusText || "就绪";
    if (renderedText === lastRenderedStatusText) return;
    lastRenderedStatusText = renderedText;
    if (el) el.textContent = renderedText;
  }

  function updateSyncStatus() {
    const syncText = document.getElementById("glm-simple-sync-text-v16");
    const syncIndicator = document.getElementById(
      "glm-simple-sync-indicator-v16",
    );
    const syncSource = document.getElementById("glm-simple-sync-source-v16");

    if (!syncText || !syncIndicator || !syncSource) return;

    const status = TIME_SYNC.getStatus();

    if (status.isSynced) {
      const offsetDisplay =
        Math.abs(status.offset) < 1000
          ? `${status.offset >= 0 ? "+" : ""}${status.offset.toFixed(0)}ms`
          : `${(status.offset / 1000).toFixed(2)}s`;
      syncText.textContent = `时间已校准 (偏差 ${offsetDisplay})`;
      syncIndicator.className = "sync-indicator synced";
      syncSource.textContent =
        status.source === "website" ? "网站时间" : "NTP时间";
    } else {
      syncText.textContent = "时间校准中...";
      syncIndicator.className = "sync-indicator syncing";
      syncSource.textContent = "--";
    }
  }

  // 启动时间校准状态更新循环
  function startSyncStatusLoop() {
    updateSyncStatus();
    setInterval(updateSyncStatus, 5000); // 每5秒更新一次显示
  }

  function updateStatus(text) {
    lastStatusText = text;
    refreshStatus();
  }

  function getIdleStatusText() {
    const countdown = getCountdown();
    return countdown ? `倒计时 ${countdown}` : "已到点，等待重试闭环";
  }

  function getRateLimitRedirectTarget() {
    if (!location.pathname.includes("/html/rate-limit.html")) return "";
    try {
      const redirect = new URLSearchParams(location.search).get("redirect");
      return getGlmCodingInviteTarget(redirect || "/glm-coding");
    } catch {
      return getGlmCodingInviteTarget();
    }
  }

  function redirectAwayFromRateLimitPage() {
    const redirectTarget = getRateLimitRedirectTarget();
    if (!redirectTarget) return false;
    console.warn("[Auto-GLM-1.7] 当前位于限流页，尝试跳回:", redirectTarget);
    location.replace(redirectTarget);
    return true;
  }

  if (redirectAwayFromRateLimitPage()) return;

  // ==========================================
  // 核心逻辑
  // ==========================================

  const STORAGE_KEY = "glm-simple-config-v16";
  const WATCH_GRACE_MS = 5 * 60 * 1000;
  const CYCLE_SETTLE_MS = 350;
  const SECOND_CLICK_DELAY_MS = 120;
  const DIALOG_RETRY_BASE_DELAY_MS = 350; // 已缩短，加速重试
  const DIALOG_RETRY_RANDOM_MS = 300; // 已缩短
  const PRODUCT_MAP = {
    Lite: {
      month: "product-02434c",
      quarter: "product-b8ea38",
      year: "product-70a804",
    },
    Pro: {
      month: "product-1df3e1",
      quarter: "product-fef82f",
      year: "product-5643e6",
    },
    Max: {
      month: "product-2fc421",
      quarter: "product-5d3a03",
      year: "product-d46f8b",
    },
  };
  const CYCLE_LABELS = {
    month: "连续包月",
    quarter: "连续包季",
    year: "连续包年",
  };

  const DEFAULT_CONFIG = {
    targetPlan: "Pro",
    billingCycle: "quarter",
    targetHour: 10,
    targetMinute: 0,
    targetSecond: 0,
  };

  let config = loadConfig();
  let tickTimer = null;
  let isWatching = false;
  let isWaitingCaptcha = false;
  let captchaActionState = { fingerprint: "", stage: "idle" };
  let isClicking = false;
  let hasCompleted = false; // 取代 hasClicked，只有出现真实支付框才设为true
  let targetTimestamp = 0;
  let lastCycleSwitchAt = 0;
  let lastStatusText = "";
  let lastRenderedStatusText = "";
  let retryCount = 0;
  const MAX_RETRY_COUNT = 300; // 安全阈值，避免死循环

  function resetCaptchaActionState() {
    captchaActionState = { fingerprint: "", stage: "idle" };
  }

  function clampNumber(value, min, max, fallback) {
    const next = Number(value);
    if (!Number.isFinite(next)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(next)));
  }

  function sanitizeConfig(raw = {}) {
    return {
      targetPlan: PRODUCT_MAP[raw.targetPlan]
        ? raw.targetPlan
        : DEFAULT_CONFIG.targetPlan,
      billingCycle: CYCLE_LABELS[raw.billingCycle]
        ? raw.billingCycle
        : DEFAULT_CONFIG.billingCycle,
      targetHour: clampNumber(raw.targetHour, 0, 23, DEFAULT_CONFIG.targetHour),
      targetMinute: clampNumber(
        raw.targetMinute,
        0,
        59,
        DEFAULT_CONFIG.targetMinute,
      ),
      targetSecond: clampNumber(
        raw.targetSecond,
        0,
        59,
        DEFAULT_CONFIG.targetSecond,
      ),
    };
  }

  function loadConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULT_CONFIG };
      return { ...DEFAULT_CONFIG, ...sanitizeConfig(JSON.parse(raw)) };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  function saveConfig() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch (e) {}
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function log(msg) {
    console.log(`[Auto-GLM-1.7] ${msg}`);
    const logBox = document.getElementById("glm-simple-log");
    if (logBox) {
      const time = new Date().toLocaleTimeString();
      logBox.innerHTML =
        `<div>[${time}] ${escapeHtml(msg)}</div>` + logBox.innerHTML;
      if (logBox.children.length > 50) logBox.lastElementChild.remove();
    }
  }

  function normalizeText(text) {
    return String(text || "")
      .replace(/\s+/g, "")
      .trim();
  }

  function getTargetDate(now = new Date()) {
    return new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      config.targetHour,
      config.targetMinute,
      config.targetSecond || 0,
      0,
    );
  }

  function refreshTargetTimestamp() {
    targetTimestamp = getTargetDate().getTime();
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function isVisibleElement(node) {
    if (!node || !node.isConnected) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findCycleTab(cycle) {
    const label = CYCLE_LABELS[cycle];
    if (!label) return null;
    return (
      Array.from(document.querySelectorAll(".switch-tab-item")).find((node) =>
        normalizeText(node.textContent).includes(normalizeText(label)),
      ) || null
    );
  }

  function ensureBillingCycleSelected() {
    const tab = findCycleTab(config.billingCycle);
    if (!tab) return false;
    if (tab.classList.contains("active")) return true;
    if (TIME_SYNC.now() - lastCycleSwitchAt < CYCLE_SETTLE_MS) return false;
    lastCycleSwitchAt = TIME_SYNC.now();
    dispatchRealClick(tab.querySelector(".switch-tab-item-content") || tab);
    return false;
  }

  function findPlanCard(planName) {
    return (
      Array.from(document.querySelectorAll(".package-card-box .package-card"))
        .filter(isVisibleElement)
        .find((card) => {
          const title = card.querySelector(".package-card-title .font-prompt");
          return (
            title &&
            normalizeText(title.textContent) === normalizeText(planName)
          );
        }) || null
    );
  }

  function findBuyButton(card) {
    if (!card) return null;
    return (
      Array.from(
        card.querySelectorAll("button.buy-btn, .package-card-btn-box button"),
      ).find(isVisibleElement) || null
    );
  }

  function getButtonState(button) {
    if (!button) return { text: "", disabled: true };
    return {
      text: normalizeText(button.textContent),
      disabled:
        button.disabled ||
        button.getAttribute("aria-disabled") === "true" ||
        button.classList.contains("is-disabled") ||
        button.classList.contains("disabled"),
    };
  }

  function temporarilyEnableButton(button) {
    if (!button) return () => {};
    const prev = {
      disabled: button.disabled,
      disabledAttr: button.getAttribute("disabled"),
      ariaDisabled: button.getAttribute("aria-disabled"),
      className: button.className,
    };
    button.disabled = false;
    button.removeAttribute("disabled");
    button.setAttribute("aria-disabled", "false");
    button.classList.remove("is-disabled", "disabled");
    return () => {
      if (button && button.isConnected) {
        button.disabled = prev.disabled;
        if (prev.disabledAttr == null) button.removeAttribute("disabled");
        else button.setAttribute("disabled", prev.disabledAttr);
        if (prev.ariaDisabled == null) button.removeAttribute("aria-disabled");
        else button.setAttribute("aria-disabled", prev.ariaDisabled);
        button.className = prev.className;
      }
    };
  }

  function dispatchMouseLikeEvent(target, type, init) {
    const EventCtor =
      type.startsWith("pointer") && typeof PointerEvent === "function"
        ? PointerEvent
        : MouseEvent;
    target.dispatchEvent(new EventCtor(type, init));
  }

  function dispatchRealClick(target) {
    if (!target || !target.isConnected) return false;
    try {
      target.scrollIntoView({
        block: "center",
        inline: "center",
        behavior: "auto",
      });
    } catch {}
    try {
      target.focus({ preventScroll: true });
    } catch {}
    const rect = target.getBoundingClientRect();
    const eventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: unsafeWindow,
      clientX: rect.left + Math.max(1, rect.width / 2),
      clientY: rect.top + Math.max(1, rect.height / 2),
    };
    ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(
      (type) => dispatchMouseLikeEvent(target, type, eventInit),
    );
    target.click();
    return true;
  }

  function getNextTickDelay() {
    // 使用校正后的时间
    const now = TIME_SYNC.now();
    const diff = targetTimestamp - now;
    if (diff > 60_000) return 1000;
    if (diff > 10_000) return 400;
    if (diff > 3_000) return 120;
    if (diff > 0) return 30; // 较精确轮询
    if (diff > -WATCH_GRACE_MS) return 50; // 到点后的重试节奏
    return 250;
  }

  function scheduleNextTick(delay = getNextTickDelay()) {
    if (!isWatching) return;
    if (tickTimer) clearTimeout(tickTimer);
    tickTimer = setTimeout(() => {
      tickTimer = null;
      void tick();
    }, delay);
  }

  function isTargetWindowExpired() {
    // 使用校正后的时间
    const now = TIME_SYNC.now();
    return now > targetTimestamp + WATCH_GRACE_MS;
  }

  function getCountdown() {
    // 使用校正后的时间
    return TIME_SYNC.getCountdown(targetTimestamp);
  }

  async function triggerBuyButton(button) {
    if (!button || isClicking) return false;
    isClicking = true;
    let restoreButton = null;
    try {
      const { disabled } = getButtonState(button);
      if (disabled) {
        restoreButton = temporarilyEnableButton(button);
      }
      dispatchRealClick(button);
      await sleep(SECOND_CLICK_DELAY_MS);
      return true;
    } finally {
      if (restoreButton)
        setTimeout(() => {
          restoreButton();
        }, 1200);
      isClicking = false;
    }
  }

  // ============== 核心轮询 =================

  async function tick() {
    if (!isWatching || hasCompleted) return;

    if (retryCount > MAX_RETRY_COUNT) {
      stopWatching({
        statusText: "已停止(超限)",
        logMessage: "重试次数达到上限，为防止死循环自动停止",
      });
      return;
    }

    if (isTargetWindowExpired()) {
      stopWatching({
        statusText: "已过时间",
        logMessage: "已超过目标时间窗口，自动停止",
      });
      return;
    }

    // ---------- 1. 处理验证码等待期 ----------
    if (isWaitingCaptcha) {
      if (isCaptchaVisible()) {
        updateStatus("检测到验证码，尝试 OCR 识别");
        sendStructuredLog("captcha_detected", {
          stage: "waiting",
        });
        await solveCaptchaViaOCR();
        if (isCaptchaVisible()) {
          scheduleNextTick(1000);
          return;
        }
        log("验证码处理后已消失，继续检查后续弹窗");
        isWaitingCaptcha = false;
        resetCaptchaActionState();
        await sleep(300);
      } else {
        log("验证码界面消失，准备继续流程");
        isWaitingCaptcha = false;
        resetCaptchaActionState();
        await sleep(600); // 留出时间让页面可能加载失败弹窗或成功弹窗
      }
    }

    // ---------- 2. 处理弹窗检测 ----------
    // 到点后才处理弹窗，避免误杀正常弹窗 (使用校正后的时间)
    if (TIME_SYNC.now() >= targetTimestamp - 1000) {
      const dialogState = detectDialogState();

      if (dialogState) {
        if (dialogState.type === "busy") {
          sendStructuredLog("dialog_busy", { retryCount });
        }
        if (dialogState.type === "empty-price") {
          sendStructuredLog("dialog_empty_price", {
            retryCount,
            hasQrCode: Boolean(dialogState.hasQrCode),
          });
        }
        if (dialogState.type === "confirm-pay") {
          sendStructuredLog("dialog_confirm_pay", {
            hasQrCode: Boolean(dialogState.hasQrCode),
          });
        }
        if (dialogState.type === "qr-pay") {
          sendStructuredLog("dialog_qr_pay", {
            hasQrCode: true,
          });
        }
        if (
          dialogState.type === "success-pay" ||
          dialogState.type === "confirm-pay" ||
          dialogState.type === "qr-pay"
        ) {
          sendStructuredLog("purchase_completed", {
            dialogType: dialogState.type,
            hasQrCode: Boolean(dialogState.hasQrCode),
          });
          log(`🎉 检测到真实的支付弹窗(${dialogState.type})，停止重试流程！`);
          updateStatus("抢购完成(弹出支付)");
          hasCompleted = true;
          stopWatching({
            statusText: "抢购完成",
            logMessage: "流程结束，需手动扫码支付",
          });
          return;
        }

        if (dialogState.type === "busy" || dialogState.type === "empty-price") {
          retryCount++;
          log(
            `[${retryCount}]检测到无效弹窗(${dialogState.type})，关闭重试...`,
          );
          if (dialogState.closeBtn) {
            dispatchRealClick(dialogState.closeBtn);
            await sleep(getDialogRetryDelay());
          }
          // 关闭后直接重新触发下一个Tick寻找购买按钮
          scheduleNextTick(0);
          return;
        }
      }
    }

    // ---------- 3. 及时锁定验证码并挂起 ----------
    if (isCaptchaVisible()) {
      isWaitingCaptcha = true;
      log("⚠ 检测到图片验证码，脚本切换到 OCR 处理模式");
      sendStructuredLog("captcha_detected", {
        stage: "detected",
      });
      updateStatus("等待 OCR 验证");
      scheduleNextTick(500);
      return;
    }

    // ---------- 4. 正常点击流程 ----------
    updateStatus(getIdleStatusText());

    const cycleReady = ensureBillingCycleSelected();
    if (!cycleReady) {
      scheduleNextTick();
      return;
    }
    if (TIME_SYNC.now() - lastCycleSwitchAt < CYCLE_SETTLE_MS) {
      scheduleNextTick();
      return;
    }

    // 如果还没到设定的抢购绝对时间，则继续等待 (使用校正后的时间)
    if (TIME_SYNC.now() < targetTimestamp) {
      scheduleNextTick();
      return;
    }

    const card = findPlanCard(config.targetPlan);
    const button = findBuyButton(card);

    if (!button) {
      updateStatus("已到点，等待按钮渲染");
      scheduleNextTick();
      return;
    }

    // 触发点击购买按钮
    const clicked = await triggerBuyButton(button);
    if (clicked) {
      retryCount++;
      // 点击后，给予少量时间让接口返回 / 渲染弹窗
      // 这里不作阻塞式大延时，在后续的 tick 中由于是重连环，会自动捕获弹窗
      await sleep(150);
    }

    scheduleNextTick(100);
  }

  function stopWatching(options = {}) {
    const { statusText = "已停止", logMessage = "已停止" } = options;
    if (tickTimer) {
      clearTimeout(tickTimer);
      tickTimer = null;
    }
    isWatching = false;
    if (logMessage) log(logMessage);
    updateStatus(statusText);
  }

  function getDialogRetryDelay() {
    return (
      DIALOG_RETRY_BASE_DELAY_MS +
      Math.floor(Math.random() * DIALOG_RETRY_RANDOM_MS)
    );
  }

  function startWatching() {
    if (isWatching) return;
    refreshTargetTimestamp();
    if (isTargetWindowExpired()) {
      log("已超过目标时间");
      updateStatus("已过时间");
      return;
    }

    isWatching = true;
    hasCompleted = false;
    isClicking = false;
    isWaitingCaptcha = false;
    lastCycleSwitchAt = 0;
    retryCount = 0;

    const ts = `${config.targetHour}:${String(config.targetMinute).padStart(2, "0")}:${String(config.targetSecond || 0).padStart(2, "0")}`;
    log(`开始闭环监听，目标时间: ${ts}`);
    sendStructuredLog("watch_start", {
      plan: config.targetPlan,
      cycle: config.billingCycle,
      targetTime: ts,
    });
    updateStatus(getIdleStatusText());
    scheduleNextTick(0);
  }

  function resetClicked() {
    hasCompleted = false;
    isClicking = false;
    isWaitingCaptcha = false;
    retryCount = 0;
    log("已重置状态记录");
    updateStatus(getIdleStatusText());
    if (isWatching) scheduleNextTick(0);
  }

  function handleConfigChange() {
    saveConfig();
    if (!isWatching) return;
    refreshTargetTimestamp();
    hasCompleted = false;
    isWaitingCaptcha = false;
    isClicking = false;
    lastCycleSwitchAt = 0;
    retryCount = 0;
    log("配置已更新，重新开始...");
    updateStatus(getIdleStatusText());
    scheduleNextTick(0);
  }

  // ==========================================
  // UI
  // ==========================================

  function injectStyles() {
    if (document.getElementById("glm-simple-style-v16")) return;
    const s = document.createElement("style");
    s.id = "glm-simple-style-v16";
    s.textContent = `
      #glm-simple-panel-v16{position:fixed;left:20px;bottom:20px;width:300px;z-index:999999;border-radius:16px;overflow:hidden;background:linear-gradient(135deg,#133054 0%,#182a74 64%,#1d4ed8 100%);box-shadow:0 24px 64px -28px rgba(16,35,63,.45);font-family:"SF Pro Display","PingFang SC","Segoe UI",sans-serif;color:#eff6ff}
      #glm-simple-panel-v16 *{box-sizing:border-box}
      .glm-simple-head-v16{padding:14px 16px; display:flex; justify-content:space-between; align-items:center;}
      .glm-simple-title-v16{font-size:14px;font-weight:700}
      .glm-simple-body-v16{padding:12px 14px;background:rgba(255,255,255,.95);color:#1e293b}
      .glm-simple-row-v16{display:flex;gap:8px;margin-bottom:10px}
      .glm-simple-field-v16{flex:1}
      .glm-simple-field-v16 label{display:block;font-size:11px;font-weight:600;color:#475569;margin-bottom:4px}
      .glm-simple-field-v16 select,.glm-simple-field-v16 input{width:100%;padding:6px 8px;border:1px solid #cbd5e1;border-radius:8px;font-size:13px;background:#f8fafc}
      .glm-simple-time-v16{display:flex;align-items:center;gap:4px}
      .glm-simple-time-v16 input{width:50px;text-align:center}
      .glm-simple-time-v16 span{font-size:12px;color:#64748b}
      .glm-simple-status-v16{font-size:13px;margin-bottom:10px;padding:8px;background:#f1f5f9;border-radius:8px;text-align:center;font-weight:bold;color:#1e40af;}
      .glm-simple-sync-v16{font-size:11px;margin-bottom:10px;padding:6px 8px;background:#f8fafc;border-radius:8px;color:#64748b;display:flex;justify-content:space-between;align-items:center;}
      .glm-simple-sync-v16 .sync-indicator{width:8px;height:8px;border-radius:50%;background:#94a3b8;}
      .glm-simple-sync-v16 .sync-indicator.synced{background:#22c55e;}
      .glm-simple-sync-v16 .sync-indicator.syncing{background:#f59e0b;animation:pulse 1s infinite;}
      @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}
      .glm-simple-actions-v16{display:flex;gap:8px}
      .glm-simple-btn-v16{flex:1;padding:8px 12px;border:none;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;color:#fff;background:linear-gradient(135deg,#1d4ed8,#0ea5e9);transition:all .2s;}
      .glm-simple-btn-v16:hover{opacity:0.9; transform:translateY(-1px);}
      .glm-simple-btn-v16.secondary{color:#475569;background:#e2e8f0}
      .glm-simple-log-v16{margin-top:10px;max-height:100px;overflow:auto;font-size:11px;color:#334155;background:#f8fafc;border-radius:8px;padding:6px 8px;line-height:1.4;}
      .glm-simple-badge-v16{font-size:10px; background:#ef4444; color:white; padding:2px 6px; border-radius:10px;}
    `;
    document.head.appendChild(s);
  }

  function buildPanel() {
    if (document.getElementById("glm-simple-panel-v16")) return;
    const panel = document.createElement("div");
    panel.id = "glm-simple-panel-v16";
    panel.innerHTML = `
      <div class="glm-simple-head-v16">
         <div class="glm-simple-title-v16">GLM 抢购助手 <span class="glm-simple-badge-v16">v1.7</span></div>
      </div>
      <div class="glm-simple-body-v16">
        <div class="glm-simple-row-v16">
          <div class="glm-simple-field-v16">
            <label>套餐设置</label>
            <select id="glm-simple-plan-v16"><option value="Lite">Lite</option><option value="Pro">Pro</option><option value="Max">Max</option></select>
          </div>
          <div class="glm-simple-field-v16">
            <label>购买周期</label>
            <select id="glm-simple-cycle-v16"><option value="month">连续包月</option><option value="quarter">连续包季</option><option value="year">连续包年</option></select>
          </div>
        </div>
        <div class="glm-simple-row-v16 glm-simple-time-v16">
          <div class="glm-simple-field-v16"><label>目标时</label><input id="glm-simple-hour-v16" type="number" min="0" max="23"></div><span>:</span>
          <div class="glm-simple-field-v16"><label>目标分</label><input id="glm-simple-minute-v16" type="number" min="0" max="59"></div><span>:</span>
          <div class="glm-simple-field-v16"><label>目标秒</label><input id="glm-simple-second-v16" type="number" min="0" max="59"></div>
        </div>
        <div class="glm-simple-sync-v16" id="glm-simple-sync-v16">
          <span id="glm-simple-sync-text-v16">时间校准中...</span>
          <span style="display:flex;align-items:center;gap:6px;">
            <span class="sync-indicator" id="glm-simple-sync-indicator-v16"></span>
            <span id="glm-simple-sync-source-v16">--</span>
          </span>
        </div>
        <div class="glm-simple-status-v16" id="glm-simple-status-v16">就绪</div>
        <div class="glm-simple-actions-v16">
          <button class="glm-simple-btn-v16" id="glm-simple-start-v16" type="button">开启自动重试购买</button>
          <button class="glm-simple-btn-v16 secondary" id="glm-simple-stop-v16" style="flex:0.6" type="button">停止</button>
        </div>
        <div class="glm-simple-log-v16" id="glm-simple-log-v16"></div>
      </div>`;
    document.body.appendChild(panel);

    const planEl = document.getElementById("glm-simple-plan-v16");
    const cycleEl = document.getElementById("glm-simple-cycle-v16");
    const hourEl = document.getElementById("glm-simple-hour-v16");
    const minEl = document.getElementById("glm-simple-minute-v16");
    const secEl = document.getElementById("glm-simple-second-v16");

    planEl.value = config.targetPlan;
    cycleEl.value = config.billingCycle;
    hourEl.value = config.targetHour;
    minEl.value = config.targetMinute;
    secEl.value = config.targetSecond || 0;

    planEl.addEventListener("change", () => {
      config.targetPlan = planEl.value;
      handleConfigChange();
    });
    cycleEl.addEventListener("change", () => {
      config.billingCycle = cycleEl.value;
      handleConfigChange();
    });
    hourEl.addEventListener("change", () => {
      config.targetHour = Math.max(0, Math.min(23, Number(hourEl.value) || 0));
      hourEl.value = config.targetHour;
      handleConfigChange();
    });
    minEl.addEventListener("change", () => {
      config.targetMinute = Math.max(0, Math.min(59, Number(minEl.value) || 0));
      minEl.value = config.targetMinute;
      handleConfigChange();
    });
    secEl.addEventListener("change", () => {
      config.targetSecond = Math.max(0, Math.min(59, Number(secEl.value) || 0));
      secEl.value = config.targetSecond;
      handleConfigChange();
    });

    document
      .getElementById("glm-simple-start-v16")
      .addEventListener("click", startWatching);
    document
      .getElementById("glm-simple-stop-v16")
      .addEventListener("click", () => {
        stopWatching();
      });
  }

  async function bootstrap() {
    injectStyles();
    buildPanel();
    updateStatus("准备就绪");

    // 启动时间同步
    startTimeSyncLoop();
    startSyncStatusLoop();

    sendStructuredLog("page_enter", {
      title: document.title,
      userAgent: navigator.userAgent,
    });
    log("脚本引擎加载完毕 v1.8 (时间校准版)");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    // 如果文档已经加载完成，确保 bootstrap 是异步执行的
    bootstrap();
  }
})();
