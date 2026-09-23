/**
 * اسکریپت ویجت چت‌بات فروشگاه
 * نحوه‌ی استفاده: این دو خط رو قبل از بسته شدن تگ </body> در سایت مشتری قرار بده:
 *
 * <script>
 *   window.ChatbotWidgetConfig = {
 *     apiUrl: "https://آدرس-سرور-تو/api/chat",
 *     siteKey: "کلید-اختصاصی-فروشگاهت",
 *     color: "#2563eb"
 *     // اختیاری: اگه فونت اختصاصی (مثل ایران یکان) روی سایتت هاست شده:
 *     // fontFamily: "IRANYekan",
 *     // fontFace: "@font-face { font-family: 'IRANYekan'; src: url('...') format('woff2'); }"
 *   };
 * </script>
 * <script src="https://آدرس-سرور-تو/widget.js"></script>
 */
(function () {
  // اگه این اسکریپت به هر دلیلی (مثلاً اضافه شدن تصادفی به دو بخش مختلف سایت)
  // بیشتر از یک بار لود بشه، فقط اولین نمونه اجرا بشه تا دو تا حباب/پنجره‌ی چت روی هم نیفته
  if (window.__shopChatbotWidgetLoaded) return;
  window.__shopChatbotWidgetLoaded = true;

  let API_URL = window.ChatbotWidgetConfig && window.ChatbotWidgetConfig.apiUrl;
  let SITE_KEY = window.ChatbotWidgetConfig && window.ChatbotWidgetConfig.siteKey;
  let THEME_COLOR = (window.ChatbotWidgetConfig && window.ChatbotWidgetConfig.color) || '#2563eb';

  if (!API_URL) {
    let scriptTag = document.currentScript;
    if (!scriptTag) {
      const allWidgetScripts = document.querySelectorAll('script[src*="widget.js"]');
      scriptTag = allWidgetScripts[allWidgetScripts.length - 1];
    }
    if (scriptTag) {
      API_URL = scriptTag.getAttribute('data-api-url');
      THEME_COLOR = scriptTag.getAttribute('data-color') || THEME_COLOR;
    }
  }

  if (!API_URL) {
    console.error('[چت‌بات فروشگاه] data-api-url تنظیم نشده است.');
    return;
  }
  if (!SITE_KEY) {
    console.error('[چت‌بات فروشگاه] siteKey تنظیم نشده است.');
    return;
  }

  // رنگ تم فقط به شکل #rrggbb پذیرفته می‌شه؛ هر چیز دیگه‌ای به رنگ پیش‌فرض برمی‌گرده
  // تا یک مقدار خراب، CSS داخل شادو-دام رو نشکنه
  if (!/^#[0-9a-fA-F]{6}$/.test(THEME_COLOR)) THEME_COLOR = '#2563eb';

  // آدرس دریافت پاسخ کارشناس انسانی، از روی همان apiUrl ساخته می‌شود تا نیازی نباشد
  // مشتری‌های قبلی کد نصبشان را عوض کنند (.../api/chat → .../api/chat/agent-messages)
  const AGENT_POLL_URL = API_URL.replace(/\/+$/, '') + '/agent-messages';

  const STORAGE_KEY = 'beporsidChatbotState:' + SITE_KEY;
  const FONT_FAMILY = (window.ChatbotWidgetConfig && window.ChatbotWidgetConfig.fontFamily) || 'Vazirmatn';

  // تنظیمات جای‌گیری حباب چت (از پنل مدیریت میاد) - چون هر سایتی منوی چسبیده‌ی
  // پایین یا دکمه‌ی شناور خودش رو داره، صاحب فروشگاه باید بتونه جاش رو جابه‌جا کنه
  const cfg = window.ChatbotWidgetConfig || {};
  // مقادیر رو محدود می‌کنیم تا یک عدد اشتباه بزرگ، حباب رو از صفحه بیرون نبره
  function clampOffset(value, fallback, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(n, 0), max);
  }
  const POS = {
    side: cfg.side === 'right' ? 'right' : 'left',
    dBottom: clampOffset(cfg.desktopBottom, 20, 400),
    dSide: clampOffset(cfg.desktopSideOffset, 20, 400),
    mBottom: clampOffset(cfg.mobileBottom, 20, 300),
    mSide: clampOffset(cfg.mobileSideOffset, 14, 120)
  };
  const SIDE = POS.side;                            // سمتی که حباب روش می‌شینه
  const OPP = SIDE === 'left' ? 'right' : 'left';   // سمت مقابل

  // فونت رو با یک تگ <link> به <head> اصلی صفحه اضافه می‌کنیم (نه با @import داخل
  // شادو-دام) چون این روش قابل‌اعتمادتره و توی مرورگرهای موبایل هم درست کار می‌کنه.
  // اگه خودت یک فونت اختصاصی (مثل ایران یکان) روی سایتت هاست کردی، می‌تونی به‌جای
  // این فونت پیش‌فرض، آدرس فایلش رو با window.ChatbotWidgetConfig.fontFace بدی.
  if (!document.getElementById('beporsid-chatbot-font')) {
    const customFontFace = window.ChatbotWidgetConfig && window.ChatbotWidgetConfig.fontFace;
    if (customFontFace) {
      const styleTag = document.createElement('style');
      styleTag.id = 'beporsid-chatbot-font';
      styleTag.textContent = customFontFace;
      document.head.appendChild(styleTag);
    } else {
      const link = document.createElement('link');
      link.id = 'beporsid-chatbot-font';
      link.rel = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;500;600;700&display=swap';
      document.head.appendChild(link);
    }
  }

  const host = document.createElement('div');
  host.id = 'shop-chatbot-widget-host';
  host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;overflow:visible;z-index:2147483000;pointer-events:none;';
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });

  const CHAT_ICON = '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.03 2 11c0 2.44 1.15 4.65 3 6.3V22l4.1-2.05c.93.2 1.9.3 2.9.3 5.52 0 10-4.03 10-9S17.52 2 12 2z"/></svg>';

  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * {
        box-sizing: border-box;
        font-family: '${FONT_FAMILY}', Tahoma, Arial, sans-serif;
        -webkit-tap-highlight-color: transparent;
      }

      /* ---------- حباب ---------- */
      .bubble {
        pointer-events: auto;
        position: fixed;
        bottom: calc(${POS.dBottom}px + env(safe-area-inset-bottom));
        ${SIDE}: ${POS.dSide}px;
        width: 58px;
        height: 58px;
        border-radius: 50%;
        background: ${THEME_COLOR};
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        box-shadow: 0 10px 24px -6px ${THEME_COLOR}99, 0 2px 6px rgba(0,0,0,0.12);
        z-index: 2147483000;
        transition: transform 0.2s ease, box-shadow 0.2s ease;
        border: 0;
        padding: 0;
      }
      .bubble:hover { transform: translateY(-2px); box-shadow: 0 14px 28px -6px ${THEME_COLOR}aa, 0 2px 6px rgba(0,0,0,0.12); }
      .bubble:active { transform: scale(0.95); }
      .bubble svg {
        width: 26px; height: 26px; fill: #fff;
        position: absolute; top: 50%; left: 50%; margin: -13px 0 0 -13px;
        transition: opacity 0.2s, transform 0.2s;
      }
      .bubble .ic-close { opacity: 0; transform: rotate(-90deg) scale(0.6); }
      .bubble.open .ic-chat { opacity: 0; transform: rotate(90deg) scale(0.6); }
      .bubble.open .ic-close { opacity: 1; transform: none; }
      .bubble .ring {
        position: absolute; inset: 0; border-radius: 50%;
        border: 2px solid ${THEME_COLOR}; opacity: 0;
        animation: ring 2.6s ease-out 1.2s 3;
      }
      @keyframes ring { 0% { transform: scale(1); opacity: .6; } 100% { transform: scale(1.55); opacity: 0; } }

      /* ---------- پنجره ---------- */
      .panel {
        pointer-events: auto;
        position: fixed;
        bottom: calc(${POS.dBottom + 72}px + env(safe-area-inset-bottom));
        ${SIDE}: ${POS.dSide}px;
        width: 370px;
        max-width: calc(100vw - 24px);
        height: 540px;
        max-height: min(75vh, 75dvh);
        background: #f5f6f8;
        border-radius: 20px;
        box-shadow: 0 24px 60px -12px rgba(15, 23, 42, 0.28), 0 0 0 1px rgba(15,23,42,0.06);
        display: none;
        flex-direction: column;
        overflow: hidden;
        z-index: 2147483000;
        direction: rtl;
        transform-origin: bottom ${SIDE};
      }
      .panel.open { display: flex; animation: pop 0.22s cubic-bezier(.2,.9,.3,1.2); }
      @keyframes pop { from { opacity: 0; transform: translateY(10px) scale(0.96); } to { opacity: 1; transform: none; } }

      /* حالت تمام‌صفحه‌ی موبایل: هم با media query هم با کلاس mobile-mode (که با جاوااسکریپت
         بر اساس اندازه‌ی واقعی صفحه‌ی گوشی اضافه می‌شه) فعال می‌شه - چون بعضی صفحات که
         تگ viewport درستی ندارن، media query به‌تنهایی قابل‌اعتماد نیست */
      .panel.mobile-mode {
        top: 0; left: 0; right: 0; bottom: 0;
        width: 100%; max-width: none; height: 100dvh; max-height: none;
        border-radius: 0; animation: none;
      }
      @media (max-width: 560px) {
        .bubble {
          ${SIDE}: ${POS.mSide}px;
          ${OPP}: auto;
          bottom: calc(${POS.mBottom}px + env(safe-area-inset-bottom));
        }
        .panel {
          top: 0; left: 0; right: 0; bottom: 0;
          width: 100%; max-width: none; height: 100dvh; max-height: none;
          border-radius: 0; animation: none;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .bubble, .bubble svg, .msg, .panel.open { transition: none; animation: none; }
        .bubble .ring { display: none; }
      }

      /* ---------- سربرگ ---------- */
      .header {
        background: ${THEME_COLOR};
        color: #fff;
        padding: 12px 14px 12px 10px;
        padding-top: max(12px, env(safe-area-inset-top));
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-shrink: 0;
      }
      .header .title-wrap { display: flex; align-items: center; gap: 10px; min-width: 0; }
      .header .avatar {
        width: 38px; height: 38px; border-radius: 12px;
        background: rgba(255,255,255,0.18);
        display: flex; align-items: center; justify-content: center;
        flex-shrink: 0;
      }
      .header .avatar svg { width: 20px; height: 20px; fill: #fff; }
      .header .title-text { display: flex; flex-direction: column; min-width: 0; }
      .header .t1 { font-weight: 700; font-size: 14.5px; line-height: 1.4; }
      .header .t2 { font-size: 11.5px; opacity: 0.85; display: flex; align-items: center; gap: 5px; }
      .header .dot { width: 7px; height: 7px; border-radius: 50%; background: #6ee7a8; box-shadow: 0 0 0 2px rgba(110,231,168,0.35); }
      .header .close {
        cursor: pointer; border: 0; background: transparent; color: #fff; padding: 0;
        width: 34px; height: 34px; border-radius: 10px;
        display: flex; align-items: center; justify-content: center;
        transition: background 0.15s; flex-shrink: 0;
      }
      .header .close:hover { background: rgba(255,255,255,0.18); }
      .header .close svg { width: 18px; height: 18px; stroke: #fff; stroke-width: 2.2; fill: none; stroke-linecap: round; }

      /* ---------- پیام‌ها ---------- */
      .messages {
        flex: 1;
        overflow-y: auto;
        -webkit-overflow-scrolling: touch;
        overscroll-behavior: contain;
        padding: 14px 12px 8px;
        display: flex;
        flex-direction: column;
        gap: 2px;
        scroll-behavior: smooth;
      }
      .messages::-webkit-scrollbar { width: 5px; }
      .messages::-webkit-scrollbar-thumb { background: #d3d7de; border-radius: 10px; }

      .day {
        align-self: center;
        font-size: 11px;
        color: #7c8494;
        background: #e9ebef;
        padding: 3px 12px;
        border-radius: 999px;
        margin: 6px 0 8px;
      }
      .msg {
        max-width: 84%;
        display: flex;
        flex-direction: column;
        margin: 3px 0;
        animation: rise 0.25s ease;
      }
      @keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
      .msg .bubble-text {
        padding: 9px 13px;
        border-radius: 16px;
        line-height: 1.7;
        font-size: 13.5px;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .msg.user { align-self: flex-start; }
      .msg.user .bubble-text { background: ${THEME_COLOR}; color: #fff; border-bottom-right-radius: 5px; }
      .msg.bot { align-self: flex-end; }
      .msg.bot .bubble-text { background: #fff; color: #1f2430; border-bottom-left-radius: 5px; box-shadow: 0 1px 2px rgba(15,23,42,0.06); }
      .msg .time {
        font-size: 10.5px;
        color: #98a0ad;
        margin: 3px 6px 0;
        direction: rtl;
      }
      .msg.user .time { text-align: right; }
      .msg.bot .time { text-align: left; }

      /* پیام کارشناس انسانی: عمداً از جواب هوش مصنوعی متمایز است تا مشتری بداند
         الان با یک آدم واقعی حرف می‌زند */
      .msg.agent { align-self: flex-end; }
      .msg.agent .bubble-text {
        background: #fff; color: #1f2430; border-bottom-left-radius: 5px;
        border: 1.5px solid ${THEME_COLOR}; box-shadow: 0 1px 2px rgba(15,23,42,0.06);
      }
      .msg.agent .time { text-align: left; }
      .agent-label {
        align-self: flex-end; display: inline-flex; align-items: center; gap: 5px;
        font-size: 11px; font-weight: 700; color: ${THEME_COLOR}; margin: 8px 4px 2px;
      }
      .agent-label svg { width: 12px; height: 12px; fill: currentColor; }
      /* یادداشت سیستمی وسط چت، مثل «پیام شما برای کارشناس فرستاده شد» */
      .sys-note {
        align-self: center; text-align: center; font-size: 11.5px; color: #6b7280;
        background: #eef1f5; border-radius: 999px; padding: 5px 13px; margin: 6px 0;
      }

      /* پیام خطا با دکمه‌ی تلاش دوباره */
      .msg.error .bubble-text {
        background: #fff4f4; color: #9b2c2c; border: 1px solid #f5cfcf; border-bottom-left-radius: 5px;
        box-shadow: none;
      }
      .retry {
        display: inline-flex; align-items: center; gap: 6px;
        margin-top: 6px; padding: 6px 12px;
        border: 1px solid ${THEME_COLOR}; border-radius: 999px;
        background: #fff; color: ${THEME_COLOR};
        font-size: 12.5px; font-weight: 600; cursor: pointer; font-family: inherit;
        transition: background 0.15s;
        align-self: flex-start;
      }
      .retry:hover { background: ${THEME_COLOR}14; }
      .retry:disabled { opacity: .6; cursor: default; }
      .retry svg { width: 13px; height: 13px; stroke: currentColor; stroke-width: 2.4; fill: none; stroke-linecap: round; stroke-linejoin: round; }

      .msg.typing { align-self: flex-end; }
      .msg.typing .bubble-text {
        background: #fff; display: flex; gap: 4px; align-items: center; padding: 12px 14px;
        border-bottom-left-radius: 5px; box-shadow: 0 1px 2px rgba(15,23,42,0.06);
      }
      .typing-dot { width: 6px; height: 6px; border-radius: 50%; background: #b3b9c6; animation: blink 1.2s infinite; }
      .typing-dot:nth-child(2) { animation-delay: 0.2s; }
      .typing-dot:nth-child(3) { animation-delay: 0.4s; }
      @keyframes blink { 0%, 80%, 100% { opacity: 0.3; } 40% { opacity: 1; } }

      /* ---------- ورودی ---------- */
      .input-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 10px 6px;
        background: #fff;
        border-top: 1px solid #eceef2;
        flex-shrink: 0;
      }
      .input-row input {
        flex: 1;
        border: 1.5px solid #e3e6ec;
        background: #f7f8fa;
        border-radius: 999px;
        padding: 10px 16px;
        outline: none;
        font-size: 16px;
        color: #1f2430;
        min-width: 0;
        transition: border-color 0.15s, background 0.15s;
      }
      .input-row input::placeholder { color: #9aa2b0; }
      .input-row input:focus { border-color: ${THEME_COLOR}; background: #fff; }
      .input-row button {
        background: ${THEME_COLOR};
        color: #fff;
        border: none;
        width: 40px;
        height: 40px;
        border-radius: 50%;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        padding: 0;
        transition: transform 0.1s, opacity 0.15s;
      }
      .input-row button:hover { opacity: .9; }
      .input-row button:active { transform: scale(0.92); }
      .input-row button:disabled { opacity: .5; cursor: default; }
      .input-row button svg { width: 18px; height: 18px; fill: #fff; transform: scaleX(-1); }

      .branding {
        text-align: center;
        font-size: 10.5px;
        color: #a3a9b5;
        padding: 2px 0 max(8px, env(safe-area-inset-bottom));
        background: #fff;
        flex-shrink: 0;
      }
      .branding a { color: #7c8494; text-decoration: none; font-weight: 600; }
      .branding a:hover { text-decoration: underline; }

      /* ---------- کارت محصول ---------- */
      .product-cards {
        align-self: flex-end;
        width: 88%;
        display: flex;
        flex-direction: column;
        direction: rtl;
        gap: 7px;
        padding: 4px 0 8px;
        animation: rise 0.25s ease;
      }
      .product-card {
        direction: rtl;
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        background: #fff;
        border: 1px solid #e9ebef;
        border-radius: 14px;
        overflow: hidden;
        text-decoration: none;
        color: #1f2430;
        transition: transform 0.15s, box-shadow 0.15s, border-color 0.15s;
        padding: 8px;
      }
      .product-card:hover { transform: translateY(-1px); box-shadow: 0 6px 16px -6px rgba(15,23,42,0.2); border-color: ${THEME_COLOR}55; }
      .product-card img {
        width: 60px; height: 60px; border-radius: 10px; object-fit: cover; display: block;
        background: #f1f2f5; flex-shrink: 0;
      }
      .product-card .pc-body { flex: 1; min-width: 0; }
      .product-card .pc-title {
        font-size: 12px; line-height: 1.5; overflow: hidden; text-overflow: ellipsis;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
        margin-bottom: 4px; color: #3a4150;
      }
      .product-card .pc-price { font-size: 13px; font-weight: 700; color: ${THEME_COLOR}; }
      .product-card .pc-oos { font-size: 10.5px; font-weight: 600; color: #d33; margin-top: 3px; }
      .view-all-link {
        display: block; text-align: center; padding: 9px; margin-top: 2px;
        border: 1.5px dashed ${THEME_COLOR}88; border-radius: 12px;
        color: ${THEME_COLOR}; font-size: 12.5px; font-weight: 600; text-decoration: none;
        transition: background 0.15s;
      }
      .view-all-link:hover { background: ${THEME_COLOR}11; }

      /* ---------- کارت اتصال به کارشناس ---------- */
      .handoff {
        align-self: flex-end;
        width: 88%;
        background: #fff;
        border: 1.5px solid ${THEME_COLOR}55;
        border-radius: 14px;
        padding: 12px 14px;
        margin: 4px 0 8px;
        animation: rise 0.25s ease;
      }
      .hd-head { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 13.5px; color: ${THEME_COLOR}; margin-bottom: 6px; }
      .hd-head svg { width: 18px; height: 18px; stroke: currentColor; stroke-width: 2; fill: none; stroke-linecap: round; stroke-linejoin: round; }
      .hd-text { font-size: 12.5px; color: #4a5160; line-height: 1.7; margin-bottom: 10px; }
      .hd-actions { display: flex; flex-wrap: wrap; gap: 8px; }
      .hd-btn {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 8px 14px; border-radius: 999px;
        border: 1.5px solid ${THEME_COLOR}; color: ${THEME_COLOR}; background: #fff;
        font-size: 12.5px; font-weight: 600; text-decoration: none; transition: background 0.15s;
        direction: rtl;
      }
      .hd-btn.primary { background: ${THEME_COLOR}; color: #fff; }
      .hd-btn:hover { background: ${THEME_COLOR}14; }
      .hd-btn.primary:hover { background: ${THEME_COLOR}; opacity: .9; }
      .hd-btn svg { width: 14px; height: 14px; stroke: currentColor; stroke-width: 2; fill: none; stroke-linecap: round; stroke-linejoin: round; }

      .msg-link { color: ${THEME_COLOR}; text-decoration: underline; word-break: break-all; }
      .msg.user .msg-link { color: #fff; }
    </style>

    <button class="bubble" id="bubble" aria-label="گفتگو با دستیار فروشگاه">
      <span class="ring"></span>
      <span class="ic-chat">${CHAT_ICON}</span>
      <svg class="ic-close" viewBox="0 0 24 24"><path d="M18.3 5.7a1 1 0 0 0-1.4 0L12 10.6 7.1 5.7a1 1 0 0 0-1.4 1.4l4.9 4.9-4.9 4.9a1 1 0 1 0 1.4 1.4l4.9-4.9 4.9 4.9a1 1 0 0 0 1.4-1.4L13.4 12l4.9-4.9a1 1 0 0 0 0-1.4z"/></svg>
    </button>

    <div class="panel" id="panel" role="dialog" aria-label="گفتگو با دستیار فروشگاه">
      <div class="header">
        <div class="title-wrap">
          <div class="avatar">${CHAT_ICON}</div>
          <div class="title-text">
            <span class="t1">دستیار فروشگاه</span>
            <span class="t2"><span class="dot"></span> آنلاین · پاسخ فوری</span>
          </div>
        </div>
        <button class="close" id="closeBtn" aria-label="بستن">
          <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <div class="messages" id="messages"></div>
      <div class="input-row">
        <input type="text" id="userInput" placeholder="سوالت رو بپرس…" autocomplete="off" />
        <button id="sendBtn" aria-label="ارسال">
          <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
        </button>
      </div>
      <!-- طبق راهنمای گوگل (Link Schemes)، لینک‌هایی که یک ابزار/ویجت به‌صورت خودکار روی سایت‌های
           دیگر می‌گذارد باید nofollow باشند تا مصداق طرح لینکی دستکاری‌شده حساب نشود. -->
      <div class="branding">قدرت گرفته از <a href="https://beporsid.com" target="_blank" rel="noopener nofollow">بپرسید</a></div>
    </div>
  `;

  const bubble = shadow.getElementById('bubble');
  const panel = shadow.getElementById('panel');
  const closeBtn = shadow.getElementById('closeBtn');
  const messagesEl = shadow.getElementById('messages');
  const inputEl = shadow.getElementById('userInput');
  const sendBtn = shadow.getElementById('sendBtn');

  // تشخیص موبایل بودن با ترکیب دو سیگنال: عرض واقعی صفحه‌ی دستگاه (screen.width) که
  // تحت‌تأثیر تنظیمات viewport اون صفحه‌ی خاص قرار نمی‌گیره، به‌علاوه‌ی media query عادی -
  // هرکدوم true بود یعنی موبایله
  const isMobileDevice = screen.width <= 560 || window.matchMedia('(max-width: 560px)').matches;
  if (isMobileDevice) {
    panel.classList.add('mobile-mode');
  }

  let history = [];
  let opened = false;
  let displayLog = []; // برای بازسازی ظاهر چت بعد از رفرش/جابه‌جایی صفحه
  let pending = false; // تا وقتی جواب یک پیام نیومده، پیام بعدی فرستاده نمی‌شه
  let lastDayKey = '';  // برای نمایش جداکننده‌ی تاریخ بین روزهای مختلف
  // --- حالت گفتگو با کارشناس انسانی ---
  let lastAgentId = 0;          // شناسه‌ی آخرین پیام کارشناس که گرفته‌ایم (برای poll)
  let lastSenderWasAgent = false; // برای اینکه برچسب «کارشناس» تکراری چاپ نشود
  let agentActive = false;       // کارشناس گفتگو را در دست دارد
  let pollTimer = null;
  let conversationStarted = false; // تا مشتری پیامی نفرستاده، گفتگویی روی سرور وجود ندارد

  // شناسه‌ی یکتای این گفتگو؛ سرور با همین شناسه پیام‌ها رو در یک مکالمه جمع می‌کنه
  // تا صاحب فروشگاه بتونه در پنل مدیریت گفتگوها رو ببینه
  function makeSessionId() {
    const rnd = (window.crypto && crypto.getRandomValues)
      ? Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('')
      : Math.random().toString(16).slice(2) + Date.now().toString(16);
    return 'cs_' + rnd;
  }
  let sessionId = makeSessionId();

  // --- تشخیص صفحه‌ای که مشتری داخلشه ---
  // برای این‌که وقتی توی صفحه‌ی محصول می‌گه «اینو دارین؟»، دستیار بدونه منظورش کدوم محصوله.
  // عنوان محصول از og:title یا h1 صفحه برداشته می‌شه (شاپفا هر دو رو داره).
  function detectPage() {
    const url = location.href || '';
    const path = (location.pathname || '').toLowerCase();
    const info = { url: url.slice(0, 500), type: 'other', product: '' };
    try {
      if (/\/(cart|checkout|basket|payment|order\/)/.test(path)) {
        info.type = 'checkout';
      } else if (/\/product\//.test(path) || document.querySelector('meta[property="og:type"][content="product"]')) {
        info.type = 'product';
        const og = document.querySelector('meta[property="og:title"]');
        const h1 = document.querySelector('h1');
        let title = (og && og.getAttribute('content')) || (h1 && h1.textContent) || document.title || '';
        // پسوندهایی مثل « | فروشگاه قاب من» که سایت‌ها به عنوان اضافه می‌کنن
        title = title.split(/\s[|\-–—]\s/)[0].trim();
        info.product = title.slice(0, 200);
      }
    } catch (e) { /* اگه ساختار صفحه غیرمنتظره بود، فقط آدرس فرستاده می‌شه */ }
    return info;
  }
  const PAGE = detectPage();

  // پیام خوش‌آمد بر اساس صفحه: توی صفحه‌ی محصول، خودش پیش‌قدم می‌شه
  function greetingText() {
    if (PAGE.type === 'product' && PAGE.product) {
      return 'سلام! درباره‌ی «' + PAGE.product + '» سوالی داری؟ موجودی، رنگ‌ها یا زمان ارسالش رو بپرس.';
    }
    if (PAGE.type === 'checkout') {
      return 'سلام! برای تکمیل خرید، روش پرداخت یا ارسال کمکی لازم داری؟';
    }
    return 'سلام! چطور می‌تونم کمکتون کنم؟';
  }

  // --- تاریخ و ساعت فارسی (تقویم شمسی) ---
  // اگر مرورگر از تقویم فارسی پشتیبانی نکرد، به فرمت ساده‌ی عددی برمی‌گردیم
  function faTime(ts) {
    try { return new Date(ts).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }); }
    catch (e) { const d = new Date(ts); return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0'); }
  }
  function faDate(ts) {
    try { return new Date(ts).toLocaleDateString('fa-IR', { day: 'numeric', month: 'long' }); }
    catch (e) { const d = new Date(ts); return d.getMonth() + 1 + '/' + d.getDate(); }
  }
  function faDayLabel(ts) {
    const d = new Date(ts), now = new Date();
    const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    if (sameDay(d, now)) return 'امروز';
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (sameDay(d, y)) return 'دیروز';
    try { return d.toLocaleDateString('fa-IR', { weekday: 'long', day: 'numeric', month: 'long' }); }
    catch (e) { return faDate(ts); }
  }
  function dayKeyOf(ts) { const d = new Date(ts); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }

  // --- ذخیره و بازیابی وضعیت چت با sessionStorage ---
  // این باعث می‌شه اگه مشتری بین صفحات سایت جابه‌جا بشه، مکالمه‌ش پاک نشه
  function saveState() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ open: opened, history, displayLog, sessionId, lastAgentId, agentActive }));
    } catch (e) { /* اگه sessionStorage در دسترس نبود، مشکلی نیست، فقط ذخیره نمی‌شه */ }
  }

  function restoreState() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const state = JSON.parse(raw);
      history = state.history || [];
      displayLog = state.displayLog || [];
      if (state.sessionId) sessionId = state.sessionId;
      lastAgentId = state.lastAgentId || 0;
      agentActive = !!state.agentActive;

      let prevWasAgent = false;
      displayLog.forEach(entry => {
        if (entry.type === 'msg') {
          // برچسب «کارشناس» فقط بالای اولین پیام از یک رشته پیام انسانی
          if (entry.sender === 'agent' && !prevWasAgent) renderAgentLabel();
          renderMessage(entry.text, entry.sender, entry.ts);
          prevWasAgent = entry.sender === 'agent';
        } else if (entry.type === 'products') {
          renderProductCards(entry.products, entry.searchLink, entry.searchLabel);
        } else if (entry.type === 'error') {
          renderError(entry.text, entry.retryText, entry.ts);
        } else if (entry.type === 'handoff') {
          renderHandoff(entry.handoff);
        } else if (entry.type === 'note') {
          renderSysNote(entry.text);
        }
      });
      lastSenderWasAgent = prevWasAgent;

      // اگر قبلاً پیامی رد و بدل شده، گفتگو روی سرور وجود دارد و باید منتظر کارشناس بمانیم
      if (history.length) conversationStarted = true;

      if (state.open) {
        opened = true;
        panel.classList.add('open');
        bubble.classList.add('open');
        startPolling();
      }
    } catch (e) { /* داده‌ی خراب یا ناموجود - نادیده می‌گیریم */ }
  }

  function setOpen(next) {
    opened = next;
    panel.classList.toggle('open', opened);
    bubble.classList.toggle('open', opened);
    saveState();
    if (opened) {
      if (messagesEl.children.length === 0) {
        addMessage(greetingText(), 'bot');
      }
      if (!isMobileDevice) inputEl.focus();
      scrollToBottom();
      startPolling();   // تا پنل باز است، جواب کارشناس را زنده تحویل می‌گیریم
    } else {
      stopPolling();
    }
  }
  bubble.addEventListener('click', () => setOpen(!opened));
  closeBtn.addEventListener('click', () => setOpen(false));

  // اسکرول به پایین رو با یک فریم تأخیر انجام می‌دیم تا مطمئن بشیم مرورگر ارتفاع
  // واقعی محتوای تازه‌اضافه‌شده (مخصوصاً ردیف کارت‌های محصول) رو محاسبه کرده،
  // وگرنه گاهی اسکرول قبل از رندر کامل انجام می‌شه و بخشی از کارت زیر دیده می‌شه
  function scrollToBottom() {
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
      // یک بار دیگه با کمی تأخیر بیشتر، برای اطمینان از تصاویری که ممکنه دیرتر لود بشن
      setTimeout(() => { messagesEl.scrollTop = messagesEl.scrollHeight; }, 150);
    });
  }

  // متن پیام رو امن نمایش می‌دیم (بدون اجازه‌ی تزریق HTML) ولی لینک‌ها رو قابل کلیک می‌کنیم.
  // به‌جای innerHTML از ساخت گره‌های متنی و <a> استفاده می‌کنیم تا کد مخرب اجرا نشه.
  function renderTextWithLinks(container, text) {
    const urlPattern = /(https?:\/\/[^\s<>"']+)/g;
    let lastIndex = 0;
    let match;

    while ((match = urlPattern.exec(text)) !== null) {
      if (match.index > lastIndex) {
        container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      const a = document.createElement('a');
      a.href = match[0];
      a.target = '_blank';
      a.rel = 'noopener';
      a.className = 'msg-link';
      a.textContent = match[0].length > 45 ? match[0].slice(0, 42) + '…' : match[0];
      container.appendChild(a);
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
      container.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
  }

  // اگر این پیام مربوط به روز جدیدی باشه، یک جداکننده‌ی تاریخ قبلش می‌گذاریم
  function ensureDaySeparator(ts) {
    if (!ts) return;
    const key = dayKeyOf(ts);
    if (key === lastDayKey) return;
    lastDayKey = key;
    const sep = document.createElement('div');
    sep.className = 'day';
    sep.textContent = faDayLabel(ts);
    messagesEl.appendChild(sep);
  }

  // زیر هر پیام، ساعت و تاریخ ارسال به فارسی
  function makeTimeEl(ts) {
    const t = document.createElement('div');
    t.className = 'time';
    t.textContent = faTime(ts) + ' · ' + faDate(ts);
    return t;
  }

  // renderMessage فقط ظاهر رو می‌سازه (بدون ذخیره در تاریخچه) - برای بازسازی از حافظه استفاده می‌شه
  function renderMessage(text, sender, ts) {
    ensureDaySeparator(ts);
    const el = document.createElement('div');
    el.className = 'msg ' + sender;
    const body = document.createElement('div');
    body.className = 'bubble-text';
    renderTextWithLinks(body, text);
    el.appendChild(body);
    if (ts) el.appendChild(makeTimeEl(ts));
    messagesEl.appendChild(el);
    scrollToBottom();
    return el;
  }

  function addMessage(text, sender) {
    const ts = Date.now();
    const el = renderMessage(text, sender, ts);
    displayLog.push({ type: 'msg', text, sender, ts });
    saveState();
    return el;
  }

  // برچسب «کارشناس» بالای اولین پیام انسانی، تا مشتری بفهمد از اینجا به بعد آدم جواب می‌دهد
  function renderAgentLabel() {
    const l = document.createElement('div');
    l.className = 'agent-label';
    l.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0 2c-4.4 0-8 2.2-8 5v1h16v-1c0-2.8-3.6-5-8-5z"/></svg><span>کارشناس</span>';
    messagesEl.appendChild(l);
    return l;
  }

  function renderSysNote(text) {
    const n = document.createElement('div');
    n.className = 'sys-note';
    n.textContent = text;
    messagesEl.appendChild(n);
    scrollToBottom();
    return n;
  }

  function addSysNote(text) {
    renderSysNote(text);
    displayLog.push({ type: 'note', text });
    saveState();
  }

  // پیام کارشناس انسانی (از پنل یا از تلگرام فرستاده شده)
  function addAgentMessage(text, ts) {
    if (!lastSenderWasAgent) renderAgentLabel();
    const el = renderMessage(text, 'agent', ts || Date.now());
    displayLog.push({ type: 'msg', text, sender: 'agent', ts: ts || Date.now() });
    lastSenderWasAgent = true;
    saveState();
    return el;
  }

  // پیام خطا به همراه دکمه‌ی «تلاش دوباره» که همون پیام قبلی مشتری رو دوباره می‌فرسته
  function renderError(text, retryText, ts) {
    ensureDaySeparator(ts);
    const el = document.createElement('div');
    el.className = 'msg bot error';
    const body = document.createElement('div');
    body.className = 'bubble-text';
    body.textContent = text;
    el.appendChild(body);
    if (retryText) {
      const btn = document.createElement('button');
      btn.className = 'retry';
      btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg><span>ارسال دوباره</span>';
      btn.addEventListener('click', () => {
        if (pending) return;
        // پیام خطا رو برمی‌داریم (هم از صفحه هم از حافظه) و همون متن رو دوباره می‌فرستیم
        el.remove();
        displayLog = displayLog.filter(e => !(e.type === 'error' && e.ts === ts));
        submit(retryText, true);
      });
      el.appendChild(btn);
    }
    if (ts) el.appendChild(makeTimeEl(ts));
    messagesEl.appendChild(el);
    scrollToBottom();
    return el;
  }

  function addError(text, retryText) {
    const ts = Date.now();
    renderError(text, retryText, ts);
    displayLog.push({ type: 'error', text, retryText, ts });
    saveState();
  }

  function addTypingIndicator() {
    const el = document.createElement('div');
    el.className = 'msg typing';
    el.innerHTML = '<div class="bubble-text"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></div>';
    messagesEl.appendChild(el);
    scrollToBottom();
    return el;
  }

  function renderProductCards(products, searchLink, searchLabel) {
    if (!products || products.length === 0) return;

    const wrap = document.createElement('div');
    wrap.className = 'product-cards';

    products.forEach(p => {
      const hasLink = !!p.link;
      const card = document.createElement(hasLink ? 'a' : 'div');
      card.className = 'product-card';
      if (hasLink) {
        card.href = p.link;
        card.target = '_blank';
        card.rel = 'noopener';
      } else {
        card.style.cursor = 'default';
      }

      const inStock = p.quantity === undefined || p.quantity === null || p.quantity > 0;
      const priceFormatted = typeof p.price === 'number' ? p.price.toLocaleString('fa-IR') + ' تومان' : '';

      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.src = p.thumb || '';
      img.addEventListener('error', () => { img.style.display = 'none'; });
      const bodyEl = document.createElement('div');
      bodyEl.className = 'pc-body';
      const titleEl = document.createElement('div');
      titleEl.className = 'pc-title';
      titleEl.textContent = p.title || '';
      const priceEl = document.createElement('div');
      priceEl.className = 'pc-price';
      priceEl.textContent = priceFormatted;
      bodyEl.appendChild(titleEl);
      bodyEl.appendChild(priceEl);
      if (!inStock) {
        const oos = document.createElement('div');
        oos.className = 'pc-oos';
        oos.textContent = 'ناموجود';
        bodyEl.appendChild(oos);
      }
      card.appendChild(img);
      card.appendChild(bodyEl);
      wrap.appendChild(card);
    });

    if (searchLink) {
      const viewAll = document.createElement('a');
      viewAll.className = 'view-all-link';
      viewAll.href = searchLink;
      viewAll.target = '_blank';
      viewAll.rel = 'noopener';
      viewAll.textContent = (searchLabel || 'مشاهده همه محصولات') + ' ←';
      wrap.appendChild(viewAll);
    }

    messagesEl.appendChild(wrap);
    scrollToBottom();
  }

  function addProductCards(products, searchLink, searchLabel) {
    if (!products || products.length === 0) return;
    renderProductCards(products, searchLink, searchLabel);
    displayLog.push({ type: 'products', products, searchLink, searchLabel });
    saveState();
  }

  // کارت «اتصال به کارشناس»: وقتی دستیار تشخیص بده موضوع از عهده‌ش خارجه
  function renderHandoff(h) {
    if (!h || (!h.phone && !h.link)) return;
    const card = document.createElement('div');
    card.className = 'handoff';

    const head = document.createElement('div');
    head.className = 'hd-head';
    head.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg><span>اتصال به کارشناس</span>';
    card.appendChild(head);

    const txt = document.createElement('div');
    txt.className = 'hd-text';
    txt.textContent = 'برای پیگیری این موضوع، همکاران ما آماده‌ی پاسخ‌گویی هستن.' + (h.hours ? ' ساعات پاسخ‌گویی: ' + h.hours : '');
    card.appendChild(txt);

    const row = document.createElement('div');
    row.className = 'hd-actions';
    if (h.phone) {
      const a = document.createElement('a');
      a.className = 'hd-btn primary';
      a.href = 'tel:' + String(h.phone).replace(/[^\d+]/g, '');
      // شماره با textContent گذاشته می‌شه نه innerHTML، تا هر چیزی که در پنل وارد شده
      // به‌عنوان متن دیده بشه و امکان تزریق کد در صفحه‌ی مشتری وجود نداشته باشه
      a.innerHTML = '<svg viewBox="0 0 24 24"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/></svg>';
      const phoneLabel = document.createElement('span');
      phoneLabel.textContent = 'تماس: ' + h.phone;
      a.appendChild(phoneLabel);
      row.appendChild(a);
    }
    if (h.link) {
      const a = document.createElement('a');
      a.className = 'hd-btn';
      a.href = h.link;
      a.target = '_blank';
      a.rel = 'noopener';
      const isWa = /wa\.me|whatsapp/i.test(h.link);
      const isTg = /t\.me|telegram/i.test(h.link);
      a.innerHTML = '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.7A8 8 0 1 1 21 12z"/></svg><span>' + (isWa ? 'پیام در واتساپ' : isTg ? 'پیام در تلگرام' : 'ارسال پیام') + '</span>';
      row.appendChild(a);
    }
    card.appendChild(row);
    messagesEl.appendChild(card);
    scrollToBottom();
  }

  function addHandoff(h) {
    if (!h || (!h.phone && !h.link)) return;
    renderHandoff(h);
    displayLog.push({ type: 'handoff', handoff: h });
    saveState();
  }

  function setPending(on) {
    pending = on;
    sendBtn.disabled = on;
  }

  // ---------- دریافت پاسخ کارشناس انسانی ----------
  // چون این پروژه WebSocket ندارد، ویجت هر چند ثانیه یک درخواست سبک می‌زند. فقط وقتی
  // پنل باز است و گفتگویی شروع شده poll می‌کنیم تا روی بازدیدکننده‌های عادی بار اضافه نیفتد.
  const POLL_MS = 7000;

  async function pollAgentMessages() {
    if (!conversationStarted) return;
    try {
      const url = AGENT_POLL_URL + '?siteKey=' + encodeURIComponent(SITE_KEY) +
        '&sessionId=' + encodeURIComponent(sessionId) + '&after=' + lastAgentId;
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      if (data && Array.isArray(data.items) && data.items.length) {
        data.items.forEach(m => {
          const ts = m.created_at ? Date.parse(m.created_at.replace(' ', 'T') + 'Z') : Date.now();
          addAgentMessage(m.text, isNaN(ts) ? Date.now() : ts);
          if (m.id > lastAgentId) lastAgentId = m.id;
        });
        saveState();
      }
      if (data && typeof data.agentActive === 'boolean') {
        agentActive = data.agentActive;
      }
    } catch (e) { /* قطعی موقت اینترنت نباید چیزی را خراب کند */ }
  }

  function startPolling() {
    if (pollTimer || !conversationStarted) return;
    pollTimer = setInterval(pollAgentMessages, POLL_MS);
    pollAgentMessages();
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // ارسال پیام به سرور. در حالت تلاش دوباره (isRetry) پیام مشتری قبلاً روی صفحه هست
  // و دوباره اضافه نمی‌شه؛ فقط درخواست تکرار می‌شه.
  async function submit(text, isRetry) {
    if (!text || pending) return;

    if (!isRetry) addMessage(text, 'user');
    setPending(true);
    const typingEl = addTypingIndicator();

    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text, history, siteKey: SITE_KEY, sessionId,
          pageUrl: (location.href || '').slice(0, 500),
          page: PAGE
        })
      });
      let data = null;
      try { data = await res.json(); } catch (e) { data = null; }

      typingEl.remove();

      // گفتگو روی سرور ساخته شد؛ از این به بعد باید منتظر جواب کارشناس هم باشیم
      conversationStarted = true;
      startPolling();

      // کارشناس گفتگو را در دست دارد: دستیار جواب نمی‌دهد و منتظر پاسخ انسانی می‌مانیم
      if (data && data.agentMode) {
        agentActive = true;
        lastSenderWasAgent = false;
        addSysNote(data.notice || 'پیام شما برای کارشناس فرستاده شد.');
        history.push({ role: 'user', text });
        saveState();
      } else if (data && data.reply) {
        addMessage(data.reply, 'bot');
        addProductCards(data.products, data.searchLink, data.searchLabel);
        addHandoff(data.handoff);
        history.push({ role: 'user', text });
        history.push({ role: 'assistant', text: data.reply });
        lastSenderWasAgent = false;
        saveState();
      } else {
        // خطاهای مربوط به تنظیمات (کلید اشتباه و...) قابل تکرار نیستن؛ بقیه دکمه‌ی تلاش دوباره دارن
        const msg = (data && data.error) || 'خطایی رخ داد. لطفاً دوباره تلاش کنید.';
        const retryable = res.status >= 500 || res.status === 429;
        addError(msg, retryable ? text : null);
      }
    } catch (err) {
      typingEl.remove();
      addError('اتصال به سرور برقرار نشد. اینترنت خود را بررسی کنید.', text);
    } finally {
      setPending(false);
    }
  }

  function sendMessage() {
    const text = inputEl.value.trim();
    if (!text || pending) return;
    inputEl.value = '';
    submit(text, false);
  }

  sendBtn.addEventListener('click', sendMessage);

  inputEl.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') sendMessage();
  });
  inputEl.addEventListener('keyup', (e) => e.stopPropagation());
  inputEl.addEventListener('keypress', (e) => e.stopPropagation());

  restoreState();
})();
