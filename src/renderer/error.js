'use strict';

/** 加载失败兜底页：从 query 里取原始 URL，重试 = 直接替换回站点地址。 */
(function () {
  const params = new URLSearchParams(location.search);
  const target = params.get('url') || 'https://chat.deepseek.com/';
  const code = params.get('code') || '';
  const desc = params.get('desc') || '';

  const targetEl = document.getElementById('target');
  targetEl.textContent = target;
  targetEl.title = target;

  const detailEl = document.getElementById('detail');
  if (code) detailEl.textContent = `错误码 ${code}${desc ? ' · ' + desc : ''}`;

  document.getElementById('retry').addEventListener('click', () => {
    location.replace(target);
  });
  document.getElementById('reload').addEventListener('click', () => location.reload());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') location.replace(target);
  });
})();
