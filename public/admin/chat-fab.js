'use strict';
/* زر الشات العايم: متاح في كل صفحات الإدارة، بيهز إشعار بعدد الرسائل الجديدة،
   وبيفتح درج محادثة سريع من أي مكان. الاستقصاء كل 25 ثانية عبر كوكي الجلسة. */
(function () {
  if (window.__MAVI_CHAT_FAB__) return;
  window.__MAVI_CHAT_FAB__ = true;
  const SEEN_KEY = 'mavi_chat_seen_id';
  let unread = 0;
  let lastId = 0;
  let open = false;
  let pollTimer = null;

  function seenId() { return Number(localStorage.getItem(SEEN_KEY) || 0); }
  function markSeen(id) { try { localStorage.setItem(SEEN_KEY, String(id)); } catch (_) {} }

  const fab = document.createElement('button');
  fab.type = 'button';
  fab.id = 'mavi-chat-fab';
  fab.setAttribute('aria-label', 'شات الفريق — فتح المحادثة');
  fab.style.cssText = 'position:fixed;left:14px;bottom:14px;z-index:2147483000;width:56px;height:56px;border-radius:50%;border:none;background:#172b4b;color:#fff;font-size:24px;cursor:pointer;box-shadow:0 4px 14px rgba(23,43,75,.4);display:flex;align-items:center;justify-content:center;';
  const badge = document.createElement('span');
  badge.style.cssText = 'position:absolute;top:-4px;right:-4px;min-width:20px;height:20px;border-radius:10px;background:#af3941;color:#fff;font-size:12px;font-weight:700;display:none;align-items:center;justify-content:center;padding:0 5px;';
  fab.appendChild(document.createTextNode('💬'));
  fab.appendChild(badge);
  fab.style.position = 'fixed';
  fab.appendChild(badge);

  const drawer = document.createElement('div');
  drawer.id = 'mavi-chat-drawer';
  drawer.style.cssText = 'position:fixed;left:14px;bottom:80px;z-index:2147483000;width:min(360px,92vw);max-height:min(520px,70vh);background:#fff;border:1px solid #d8cfc0;border-radius:14px;box-shadow:0 8px 30px rgba(23,43,75,.25);display:none;flex-direction:column;overflow:hidden;';
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-label', 'شات الفريق');

  function render(messages) {
    const list = document.createElement('div');
    list.style.cssText = 'flex:1;overflow:auto;padding:10px;background:#faf7f2;';
    list.id = 'mavi-chat-fab-list';
    for (const m of messages.slice().reverse()) {
      const mine = m.sender_role === 'owner';
      const row = document.createElement('div');
      row.style.cssText = `margin-bottom:8px;text-align:${mine ? 'left' : 'right'};`;
      const bubble = document.createElement('div');
      bubble.style.cssText = `display:inline-block;max-width:88%;padding:7px 10px;border-radius:10px;font-size:13px;line-height:1.5;text-align:right;background:${mine ? '#172b4b' : '#fff'};color:${mine ? '#fff' : '#1c2b3a'};border:${mine ? 'none' : '1px solid #e2d9c8'};white-space:pre-wrap;`;
      bubble.textContent = m.body;
      const meta = document.createElement('div');
      meta.style.cssText = 'font-size:10.5px;color:#8a7f6d;margin-top:2px;';
      meta.textContent = `${m.sender_name}${m.request_kind ? ' · طلب ' + String(m.request_kind) : ''}`;
      row.appendChild(meta);
      row.appendChild(bubble);
      list.appendChild(row);
    }
    if (!messages.length) {
      list.innerHTML = '<p style="text-align:center;color:#8a7f6d;font-size:12px;padding:18px 6px">لسه مفيش رسائل — ابدأ المحادثة مع فريقك 👋</p>';
    }
    return list;
  }

  function setBadge(count) {
    unread = count;
    if (count > 0) {
      badge.style.display = 'flex';
      badge.textContent = count > 9 ? '٩+' : String(count);
    } else {
      badge.style.display = 'none';
    }
  }

  async function api(path, opts) {
    const res = await fetch('/api/admin/office' + path, Object.assign({ credentials: 'same-origin' }, opts || {}));
    if (!res.ok) throw Object.assign(new Error('chat_api'), { status: res.status, data: await res.json().catch(() => ({})) });
    return res.json();
  }

  async function poll() {
    try {
      const d = await api('/chat');
      const msgs = Array.isArray(d.messages) ? d.messages : [];
      lastId = msgs.length ? Math.max(...msgs.map(m => Number(m.id))) : 0;
      if (!open) {
        const newOnes = msgs.filter(m => Number(m.id) > seenId() && m.sender_role !== 'owner');
        setBadge(newOnes.length);
      }
      if (open) {
        const listEl = document.getElementById('mavi-chat-fab-list');
        if (listEl) {
          const nearBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 60;
          const fresh = render(msgs);
          listEl.replaceWith(fresh);
          if (nearBottom) fresh.scrollTop = fresh.scrollHeight;
        }
        markSeen(lastId);
        setBadge(0);
      }
      fab.style.display = 'flex';
    } catch (err) {
      if (err && err.status === 401) {
        fab.style.display = 'none';
        drawer.style.display = 'none';
        open = false;
      }
    }
  }

  async function openDrawer() {
    open = true;
    drawer.style.display = 'flex';
    drawer.innerHTML = '';
    const head = document.createElement('div');
    head.style.cssText = 'padding:10px 14px;background:#172b4b;color:#fff;font-weight:700;font-size:14px;display:flex;justify-content:space-between;align-items:center;';
    head.innerHTML = '<span>💬 شات الفريق</span>';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '✕';
    closeBtn.setAttribute('aria-label', 'إغلاق الشات');
    closeBtn.style.cssText = 'background:transparent;border:none;color:#fff;font-size:16px;cursor:pointer;';
    closeBtn.onclick = () => { open = false; drawer.style.display = 'none'; };
    head.appendChild(closeBtn);
    drawer.appendChild(head);
    const loading = document.createElement('div');
    loading.style.cssText = 'padding:18px;text-align:center;color:#8a7f6d;font-size:12px;';
    loading.textContent = 'جاري تحميل المحادثة...';
    drawer.appendChild(loading);
    try {
      const d = await api('/chat');
      const msgs = Array.isArray(d.messages) ? d.messages : [];
      lastId = msgs.length ? Math.max(...msgs.map(m => Number(m.id))) : 0;
      markSeen(lastId);
      setBadge(0);
      drawer.removeChild(loading);
      const composer = document.createElement('div');
      composer.style.cssText = 'padding:10px;border-top:1px solid #e2d9c8;background:#fff;';
      const ta = document.createElement('textarea');
      ta.id = 'mavi-chat-fab-input';
      ta.maxLength = 1000;
      ta.rows = 2;
      ta.placeholder = 'اكتبي رسالتك للفريق...';
      ta.style.cssText = 'width:100%;border:1px solid #d8cfc0;border-radius:8px;padding:8px;font-family:inherit;font-size:13px;resize:vertical;';
      const sendBtn = document.createElement('button');
      sendBtn.type = 'button';
      sendBtn.textContent = 'إرسال';
      sendBtn.style.cssText = 'margin-top:6px;background:#172b4b;color:#fff;border:none;border-radius:8px;padding:7px 16px;font-family:inherit;font-weight:700;cursor:pointer;';
      const errEl = document.createElement('div');
      errEl.style.cssText = 'color:#af3941;font-size:11px;margin-top:4px;';
      sendBtn.onclick = async () => {
        const text = ta.value.trim();
        if (!text) { errEl.textContent = 'اكتبي رسالة الأول'; return; }
        sendBtn.disabled = true;
        errEl.textContent = '';
        try {
          await api('/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body: text, request_kind: '', request_payload: '' }),
          });
          ta.value = '';
          await poll();
        } catch (e) {
          errEl.textContent = (e.data && e.data.message) || 'تعذر الإرسال';
        }
        sendBtn.disabled = false;
      };
      composer.appendChild(ta);
      composer.appendChild(sendBtn);
      composer.appendChild(errEl);
      const listEl = render(msgs);
      drawer.appendChild(listEl);
      listEl.scrollTop = listEl.scrollHeight;
      drawer.appendChild(composer);
    } catch (e) {
      loading.textContent = (e.data && e.data.message) || 'تعذر تحميل الشات';
    }
  }

  fab.onclick = () => { open ? (open = false, drawer.style.display = 'none') : openDrawer(); };

  function mount() {
    document.body.appendChild(fab);
    document.body.appendChild(drawer);
    poll();
    pollTimer = setInterval(poll, 25000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
  window.addEventListener('beforeunload', () => { if (pollTimer) clearInterval(pollTimer); });
})();
