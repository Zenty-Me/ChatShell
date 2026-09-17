'use strict';

const $ = (id) => document.getElementById(id);

let items = [];
let selIdx = 0;
let editingId = null;

/* ------------------------------- 主题 ------------------------------- */

const mq = window.matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => {
  document.documentElement.dataset.theme = mq.matches ? 'dark' : 'light';
};
applyTheme();
mq.addEventListener('change', applyTheme);

/* ------------------------------- 列表 ------------------------------- */

async function refresh({ keepIndex = true } = {}) {
  items = (await window.dsPalette.list($('search').value)) || [];
  if (!keepIndex) selIdx = 0;
  if (selIdx >= items.length) selIdx = Math.max(0, items.length - 1);
  render();
}

function isEditorOpen() {
  return !$('editor').classList.contains('hidden');
}

function render() {
  const list = $('list');
  list.textContent = '';
  $('empty').classList.toggle('hidden', items.length > 0);

  items.forEach((item, idx) => {
    const li = document.createElement('li');
    li.className = `item${idx === selIdx ? ' sel' : ''}`;
    li.dataset.id = item.id || '';

    const main = document.createElement('div');
    main.className = 'item-main';

    const title = document.createElement('div');
    title.className = 'item-title';
    title.textContent = item.title || '（无标题）';
    main.appendChild(title);

    const preview = document.createElement('div');
    preview.className = 'item-preview';
    preview.textContent = String(item.text || '').replace(/\s+/g, ' ').slice(0, 160);
    main.appendChild(preview);
    li.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'item-actions';
    const mk = (glyph, tip, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = glyph;
      b.title = tip;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
      });
      return b;
    };
    actions.appendChild(mk('⏎', '填入并发送', () => send(item, true)));
    actions.appendChild(mk('↧', '只填入输入框', () => send(item, false)));
    actions.appendChild(mk('✎', '编辑', () => openEditor(item)));
    actions.appendChild(mk('✕', '删除', () => removeItem(item)));
    li.appendChild(actions);

    li.addEventListener('click', () => {
      selIdx = idx;
      render();
    });
    li.addEventListener('dblclick', () => send(item, true));

    list.appendChild(li);
  });

  const sel = list.querySelector('.item.sel');
  if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
}

function send(item, submit) {
  if (!item) return;
  window.dsPalette.send(item.text || item.title || '', submit);
}

async function removeItem(item) {
  if (!item || !item.id) return;
  await window.dsPalette.remove(item.id);
  await refresh({ keepIndex: false });
}

/* ------------------------------- 编辑 ------------------------------- */

function openEditor(item) {
  editingId = item ? item.id : null;
  $('edit-title').value = item ? item.title || '' : '';
  $('edit-text').value = item ? item.text || '' : '';
  $('list').classList.add('hidden');
  $('empty').classList.add('hidden');
  $('editor').classList.remove('hidden');
  $('btn-delete').classList.toggle('hidden', !item);
  setTimeout(() => {
    if (item) $('edit-text').focus();
    else $('edit-title').focus();
  }, 0);
}

function closeEditor() {
  editingId = null;
  $('editor').classList.add('hidden');
  $('list').classList.remove('hidden');
  refresh();
  $('search').focus();
}

$('editor').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('edit-title').value.trim();
  const text = $('edit-text').value;
  if (!title && !text.trim()) {
    closeEditor();
    return;
  }
  await window.dsPalette.save({ id: editingId, title: title || text.trim().slice(0, 20), text });
  closeEditor();
});

$('btn-cancel').addEventListener('click', closeEditor);
$('btn-new').addEventListener('click', () => openEditor(null));
$('btn-delete').addEventListener('click', async () => {
  if (editingId) await window.dsPalette.remove(editingId);
  closeEditor();
});

// 标题里按 Enter 直接跳到内容
$('edit-title').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('edit-text').focus();
  }
});

/* ------------------------------- 搜索与键盘 ------------------------------- */

let searchTimer = null;
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => refresh({ keepIndex: false }), 120);
});

document.addEventListener('keydown', (e) => {
  const inEditor = isEditorOpen();

  if (e.key === 'Escape') {
    e.preventDefault();
    if (inEditor) closeEditor();
    else window.dsPalette.close();
    return;
  }

  if (e.ctrlKey && !e.shiftKey && (e.key === 'n' || e.key === 'N')) {
    e.preventDefault();
    openEditor(null);
    return;
  }

  if (inEditor) return; // 编辑态下其余按键交给表单自己处理

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    selIdx = Math.min(items.length - 1, selIdx + 1);
    render();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    selIdx = Math.max(0, selIdx - 1);
    render();
  } else if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    send(items[selIdx], !e.ctrlKey); // Ctrl+Enter = 只填入不发送
  }
});

/* ------------------------------- 生命周期 ------------------------------- */

window.dsPalette.onReset(() => {
  $('search').value = '';
  selIdx = 0;
  closeEditor();
  refresh({ keepIndex: false });
  setTimeout(() => $('search').focus(), 0);
});

refresh({ keepIndex: false });
