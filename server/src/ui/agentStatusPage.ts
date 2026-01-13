export const AGENT_STATUS_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="8" fill="#f97316" />
  <g transform="translate(4, 4)" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z" />
    <path d="M3 6h18" />
    <path d="M16 10a4 4 0 0 1-8 0" />
  </g>
</svg>`;

export const AGENT_STATUS_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Taobao Agent 状态</title>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <style>
      :root {
        --bg: #0b1020;
        --panel: rgba(255, 255, 255, 0.06);
        --panel2: rgba(255, 255, 255, 0.08);
        --border: rgba(255, 255, 255, 0.12);
        --text: rgba(255, 255, 255, 0.92);
        --muted: rgba(255, 255, 255, 0.70);
        --good: #22c55e;
        --warn: #f59e0b;
        --bad: #ef4444;
        --btn: rgba(255, 255, 255, 0.10);
        --btnHover: rgba(255, 255, 255, 0.14);
        --shadow: 0 18px 50px rgba(0, 0, 0, 0.45);
        --radius: 14px;
        --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji";
        color: var(--text);
        background: radial-gradient(1200px 700px at 20% 10%, #1a2a6c 0%, transparent 55%),
          radial-gradient(900px 600px at 80% 20%, #b21f1f 0%, transparent 50%),
          radial-gradient(900px 600px at 60% 90%, #0f766e 0%, transparent 45%),
          var(--bg);
      }
      .wrap {
        max-width: 980px;
        margin: 0 auto;
        padding: 28px 18px 40px;
      }
      .top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 14px;
      }
      .title {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      h1 {
        font-size: 20px;
        margin: 0;
        letter-spacing: 0.2px;
      }
      .sub {
        font-size: 13px;
        color: var(--muted);
      }
      .badge {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 10px 12px;
        border: 1px solid var(--border);
        border-radius: 999px;
        background: rgba(0, 0, 0, 0.20);
        box-shadow: var(--shadow);
        user-select: none;
      }
      .dot {
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: var(--warn);
        box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.18);
      }
      .dot.good { background: var(--good); box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.16); }
      .dot.bad { background: var(--bad); box-shadow: 0 0 0 4px rgba(239, 68, 68, 0.16); }
      .grid {
        display: grid;
        grid-template-columns: 1fr;
        gap: 14px;
      }
      @media (min-width: 860px) {
        .grid { grid-template-columns: 1.15fr 0.85fr; }
      }
      .card {
        border: 1px solid var(--border);
        border-radius: var(--radius);
        background: linear-gradient(180deg, var(--panel), rgba(255, 255, 255, 0.03));
        box-shadow: var(--shadow);
        overflow: hidden;
      }
      .card .hd {
        padding: 14px 16px;
        border-bottom: 1px solid var(--border);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }
      .card .hd h2 {
        font-size: 14px;
        margin: 0;
        color: rgba(255, 255, 255, 0.86);
        font-weight: 600;
      }
      .card .bd {
        padding: 14px 16px 16px;
      }
      .kv {
        display: grid;
        grid-template-columns: 140px 1fr;
        gap: 10px 12px;
        align-items: start;
      }
      .k { color: var(--muted); font-size: 13px; padding-top: 2px; }
      .v {
        font-size: 13px;
        word-break: break-all;
        background: var(--panel2);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 9px 10px;
        font-family: var(--mono);
      }
      .row {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
        justify-content: flex-start;
      }
      button, input {
        font: inherit;
      }
      .btn {
        border: 1px solid var(--border);
        background: var(--btn);
        color: var(--text);
        border-radius: 12px;
        padding: 10px 12px;
        cursor: pointer;
        transition: all 120ms ease;
      }
      .btn:hover { background: var(--btnHover); transform: translateY(-1px); }
      .btn:active { transform: translateY(0); }
      .btn.primary { border-color: rgba(34,197,94,0.35); }
      .btn.danger { border-color: rgba(239,68,68,0.35); }
      .input {
        width: 100%;
        border: 1px solid var(--border);
        background: rgba(0, 0, 0, 0.25);
        color: var(--text);
        border-radius: 12px;
        padding: 10px 12px;
        outline: none;
      }
      .help {
        color: var(--muted);
        font-size: 12px;
        margin-top: 8px;
        line-height: 1.5;
      }
      .msg {
        margin-top: 10px;
        padding: 10px 12px;
        border-radius: 12px;
        border: 1px solid var(--border);
        background: rgba(0, 0, 0, 0.18);
        font-size: 13px;
        white-space: pre-wrap;
      }
      .msg.good { border-color: rgba(34,197,94,0.35); }
      .msg.bad { border-color: rgba(239,68,68,0.35); }
      .logs {
        font-family: var(--mono);
        font-size: 12px;
        line-height: 1.45;
        padding: 12px;
        background: rgba(0, 0, 0, 0.35);
        border: 1px solid var(--border);
        border-radius: 12px;
        overflow: auto;
        max-height: 360px;
      }
      a { color: rgba(147, 197, 253, 0.95); text-decoration: none; }
      a:hover { text-decoration: underline; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="top">
        <div class="title">
          <h1>Taobao Agent 状态</h1>
          <div class="sub">用于小白用户：查看是否已连接、是否已配对、以及一键完成配对。</div>
        </div>
        <div class="badge" title="连接状态">
          <span id="dot" class="dot"></span>
          <span id="statusText">加载中…</span>
        </div>
      </div>

      <div class="grid">
        <div class="card">
          <div class="hd">
            <h2>基本信息</h2>
            <div class="row">
              <button class="btn" id="btnRefresh">刷新</button>
              <button class="btn" id="btnCopyAgentId">复制 AgentId</button>
              <button class="btn primary" id="btnOpenAdmin">打开后台</button>
            </div>
          </div>
          <div class="bd">
            <div class="kv">
              <div class="k">AgentId</div>
              <div class="v" id="agentId">-</div>
              <div class="k">WS 地址</div>
              <div class="v" id="wsUrl">-</div>
              <div class="k">是否已配对</div>
              <div class="v" id="hasToken">-</div>
              <div class="k">最后错误</div>
              <div class="v" id="lastError">-</div>
              <div class="k">本机状态页</div>
              <div class="v" id="statusUrl">-</div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="hd">
            <h2>配对</h2>
          </div>
          <div class="bd">
            <div class="row">
              <input class="input" id="pairCode" placeholder="输入配对码（PAIR_CODE）" autocomplete="off" />
              <button class="btn primary" id="btnPair">立即配对</button>
            </div>
            <div class="help">
              配对码在后台生成，通常有有效期；如果提示过期/无效，请回后台重新生成一个再试。
            </div>
            <div id="pairMsg" class="msg" style="display:none"></div>
          </div>
        </div>

        <div class="card" style="grid-column: 1 / -1">
          <div class="hd">
            <h2>运行日志（最近）</h2>
            <div class="row">
              <span class="sub">每 2 秒自动刷新</span>
            </div>
          </div>
          <div class="bd">
            <div class="logs" id="logs">-</div>
          </div>
        </div>
      </div>
    </div>

    <script>
      const els = {
        dot: document.getElementById('dot'),
        statusText: document.getElementById('statusText'),
        agentId: document.getElementById('agentId'),
        wsUrl: document.getElementById('wsUrl'),
        hasToken: document.getElementById('hasToken'),
        lastError: document.getElementById('lastError'),
        statusUrl: document.getElementById('statusUrl'),
        logs: document.getElementById('logs'),
        btnRefresh: document.getElementById('btnRefresh'),
        btnCopyAgentId: document.getElementById('btnCopyAgentId'),
        btnOpenAdmin: document.getElementById('btnOpenAdmin'),
        pairCode: document.getElementById('pairCode'),
        btnPair: document.getElementById('btnPair'),
        pairMsg: document.getElementById('pairMsg'),
      };

      let lastStatus = null;
      function setDot(kind) {
        els.dot.classList.remove('good', 'bad');
        if (kind === 'good') els.dot.classList.add('good');
        else if (kind === 'bad') els.dot.classList.add('bad');
      }

      function showMsg(text, ok) {
        els.pairMsg.style.display = 'block';
        els.pairMsg.textContent = String(text || '');
        els.pairMsg.classList.remove('good', 'bad');
        els.pairMsg.classList.add(ok ? 'good' : 'bad');
      }

      async function getJson(url, options) {
        const res = await fetch(url, options);
        const txt = await res.text();
        let data = null;
        try { data = JSON.parse(txt); } catch {}
        if (!res.ok || (data && data.success === false)) {
          const msg = (data && data.error) ? (typeof data.error === 'string' ? data.error : JSON.stringify(data.error)) : ('HTTP ' + res.status);
          throw new Error(msg);
        }
        return data;
      }

      function render(status) {
        lastStatus = status;
        const connected = !!status.connected;
        const hasToken = !!status.hasToken;
        els.statusText.textContent = connected ? '已连接' : (hasToken ? '未连接（正在重试）' : '未配对');
        setDot(connected ? 'good' : (hasToken ? 'bad' : 'bad'));

        els.agentId.textContent = status.agentId || '-';
        els.wsUrl.textContent = status.wsUrl || '-';
        els.hasToken.textContent = hasToken ? '是' : '否';
        els.lastError.textContent = status.lastError || '-';
        els.statusUrl.textContent = status.statusUrl || (location.origin + '/');

        if (Array.isArray(status.logs) && status.logs.length > 0) {
          els.logs.textContent = status.logs.join('\\n');
        } else {
          els.logs.textContent = '-';
        }
      }

      async function refresh() {
        try {
          const data = await getJson('/api/status');
          render(data.data || data);
        } catch (e) {
          setDot('bad');
          els.statusText.textContent = '状态获取失败';
          els.lastError.textContent = String(e && e.message ? e.message : e);
        }
      }

      async function doPair() {
        const code = String(els.pairCode.value || '').trim();
        if (!code) {
          showMsg('请输入配对码。', false);
          return;
        }
        els.btnPair.disabled = true;
        try {
          await getJson('/api/pair', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ code }),
          });
          showMsg('配对成功：Agent 已保存授权并开始连接。', true);
          els.pairCode.value = '';
          await refresh();
        } catch (e) {
          showMsg('配对失败：' + String(e && e.message ? e.message : e), false);
        } finally {
          els.btnPair.disabled = false;
        }
      }

      els.btnRefresh.addEventListener('click', refresh);
      els.btnPair.addEventListener('click', doPair);
      els.pairCode.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doPair();
      });

      els.btnCopyAgentId.addEventListener('click', async () => {
        const text = (lastStatus && lastStatus.agentId) ? String(lastStatus.agentId) : String(els.agentId.textContent || '');
        try {
          await navigator.clipboard.writeText(text);
          showMsg('已复制 AgentId 到剪贴板。', true);
        } catch {
          const ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          showMsg('已复制 AgentId 到剪贴板。', true);
        }
      });

      els.btnOpenAdmin.addEventListener('click', () => {
        const url = (lastStatus && lastStatus.adminUrl) ? String(lastStatus.adminUrl) : '';
        if (!url) {
          showMsg('后台地址为空，请先确保 /api/status 返回 adminUrl。', false);
          return;
        }
        window.open(url, '_blank', 'noopener,noreferrer');
      });

      refresh();
      setInterval(refresh, 2000);
    </script>
  </body>
</html>
`;
