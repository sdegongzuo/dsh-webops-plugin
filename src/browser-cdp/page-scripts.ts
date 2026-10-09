/** 页面内执行的脚本片段；搬迁时保留字符串、转义及脚本行为。 */

/**
 * 「这个元素该怎么自我介绍」的取名片段（P0-a）。
 *
 * 用法：`${READABLE_NAME_SNIPPET}` 插在某条页面脚本里当立即执行的箭头函数，
 * 入参是要取名的元素，返回 ≤60 字的名字，取不到就返回空串。
 *
 * **为什么是字符串片段而不是函数**：下面两条脚本跑在**不同**的 `Runtime.evaluate`
 * 调用里，彼此没有共享作用域，也就没法共用一个具名函数 —— 只能各内联一份。
 * ⚠️ **改这段等于同时改两处**：两条脚本对同一个物体报出两个不同的名字，
 * 比都报不出来更糟（模型会以为那是两个东西）。
 *
 * **为什么要往上爬祖先链（而不是只读自己）**：真站的浮层常常是「没有 `aria-label`、
 * 也不是 `[role=dialog]`」的定位容器（知乎登录浮层就是 `DIV.Modal-wrapper`，且它命中时
 * `[role=dialog]` 的 `closest` 命中数为 0），而**盖住落点的那一层往往没有自己的文本**
 *（`Modal-backdrop` 就是空的）。只读自己等于把最常见的那种形状丢掉 —— 这正是
 * P0-a 的实测成因（`docs/上下文膨胀-实施方案.md` §5.2）。
 *
 * **为什么有「向上 5 层、且到 `<body>` 为止」的上限**：再往上就在读页面根了，拿回来的是
 * 整页正文的前 60 字 —— 那不是浮层的名字，是一条比空串更误导的噪声。
 */
const READABLE_NAME_SNIPPET = '(el) => {'
  + ' const labeled = el.getAttribute("aria-label") || el.getAttribute("alt") || "";'
  + ' if (labeled.trim().length > 0) return labeled.trim().slice(0, 60);'
  + ' for (let cursor = el, hops = 0;'
  + '      cursor && cursor.nodeType === 1 && cursor !== document.body && hops < 5;'
  + '      cursor = cursor.parentElement, hops++) {'
  + '   const text = String(cursor.textContent || "").replace(/\\s+/g, " ").trim();'
  + '   if (text.length > 0) return text.slice(0, 60);'
  + ' }'
  + ' return "";'
  + ' }'

/**
 * rect 测量脚本（locate / click / smooth 滚动重测共用）：视口坐标盒 + 视口尺寸一次带回。
 * `elementViewportBox` 与 `measureViewportBox` 必须用同一份，否则重测口径漂移。
 */
export const LOCATE_MEASURE_SNIPPET = ' const rect = this.getBoundingClientRect();'
  + ' return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,'
  + ' viewportWidth: window.innerWidth, viewportHeight: window.innerHeight }; }'

/**
 * 落点命中校验：问一句「这个视口坐标上最顶层的元素是谁」。
 *
 * 为什么是 `elementFromPoint` 而不是比 rect：它就是浏览器派发鼠标事件时用的那一套命中测试，
 * 「两个盒子重叠」在 CSS 里根本不等于「挡住」（祖先、`pointer-events: none`、负 z-index
 * 都是重叠但打得中）。用真实命中测试才不会把能点中的目标误报成被遮挡。
 */
export const HIT_TEST_FUNCTION = 'function (point) {'
  + ' const element = this;'
  // P0-a：取名口径与浮层探测同源，改这里要一并改 READABLE_NAME_SNIPPET 的另一处调用点。
  + ' const nameOf = ' + READABLE_NAME_SNIPPET + ';'
  + ' const top = document.elementFromPoint(Math.round(point.x), Math.round(point.y));'
  + ' let href = null;'
  + ' try { href = (element.href && String(element.href).length > 0) ? String(element.href) : element.getAttribute("href"); } catch (e) { href = null; }'
  // 命中判定只认「就是它」与「它的子孙」；命中**祖先**算 other —— 那时鼠标事件打不到它身上。
  + ' const hit = top === null ? "none" : (top === element || element.contains(top) ? "target" : "other");'
  + ' let node = null;'
  + ' if (hit === "other" && top !== null) {'
  + '   const role = top.getAttribute("role") || String(top.tagName || "").toLowerCase();'
  // 盖住人的那一层常常自己没文本（遮罩就是空的），所以名字要从它或它附近的祖先读。
  + '   const name = nameOf(top);'
  + '   const hint = top.id ? "#" + top.id'
  + '     : (typeof top.className === "string" && top.className.trim().length > 0'
  + '       ? "." + top.className.trim().split(/\\s+/)[0] : "");'
  + '   node = { role: role, name: name, hint: hint };'
  + ' }'
  + ' return { href: typeof href === "string" && href.length > 0 ? href : null, hit: hit, node: node };'
  + ' }'

/**
 * 视口中心浮层探测（B2-d）。
 *
 * 从 `elementFromPoint` 命中的那个元素往上走，找第一个「定位在浮层里」的祖先：
 *
 * - `position: fixed`，或
 * - `position: absolute` **且 `z-index` 不是 auto**
 *
 * 并且它在视口内的可见面积 ≥ 视口的 60%。三条一起才判浮层：单看「定位」会把 SPA 里
 * `position:absolute; inset:0` 的根容器（没有 z-index）算成遮罩，单看面积会把长页面里的
 * 大块正文算成浮层。
 *
 * 命中 `role=dialog` / `aria-modal` / `<dialog>` 时用**它**作为取名对象 —— 那才是模型能认出来的东西。
 * 至于名字本身，两形状共用 {@link READABLE_NAME_SNIPPET}：不再要求「必须是 dialog 才读文本」。
 */
export const OVERLAY_PROBE_EXPRESSION = '(() => {'
  + ' const nameOf = ' + READABLE_NAME_SNIPPET + ';'
  + ' const vw = window.innerWidth, vh = window.innerHeight;'
  + ' if (!vw || !vh) return null;'
  + ' const top = document.elementFromPoint(Math.round(vw / 2), Math.round(vh / 2));'
  + ' if (!top) return null;'
  + ' const visible = (el) => { const r = el.getBoundingClientRect();'
  + '   const w = Math.min(r.right, vw) - Math.max(r.left, 0);'
  + '   const h = Math.min(r.bottom, vh) - Math.max(r.top, 0);'
  + '   return w > 0 && h > 0 ? w * h : 0; };'
  + ' let node = top;'
  + ' while (node && node.nodeType === 1 && node !== document.body) {'
  + '   const style = getComputedStyle(node);'
  + '   const layered = style.position === "fixed" || (style.position === "absolute" && style.zIndex !== "auto");'
  + '   if (layered && visible(node) >= 0.6 * vw * vh) break;'
  + '   node = node.parentElement;'
  + ' }'
  + ' if (!node || node.nodeType !== 1 || node === document.body || node === document.documentElement) return null;'
  // 项 6（2026-10-07 独立验收）：`/plain` 的正常布局是 `main.fixed{inset:0}` 盖满视口、
  // 页头目录/章节链接在它**下面**（文档序在前、层叠在后）——「fixed + 覆盖 ≥60%」三条件
  // 全中，旧判据把主内容区报成了 OVERLAY。`main` / `[role=main]` 是页面主内容地标，
  // 语义上不是浮层，真遮罩从不长成 main：攀爬落到它就直接豁免。真正的模态对话框若在
  // main 之上，攀爬会先落到对话框那层（elementFromPoint 命中的是它），不走这条豁免。
  + ' const tagName = String(node.tagName || "").toLowerCase();'
  + ' const mainRole = (node.getAttribute("role") || "").toLowerCase();'
  + ' if (tagName === "main" || mainRole === "main") return null;'
  // 项 6（2026-10-07）：「fixed + 覆盖 ≥60%」不等于遮挡 —— Google 的普通 main 就是 fixed
  // 且盖满视口，被误报成 OVERLAY。遮挡的实义是「**别的**可操作控件真的点不到了」：采样
  // 分层元素**之外**的控件，逐个问它中心的命中测试落点 ——
  //   · 没有外部控件（可操作内容全在这层里）→ 正常 fixed main，不报；
  //   · 任一外部控件的中心仍命中自身（或其后代）→ 页面没有被盖死，不报；
  //   · 外部控件存在且全部被盖 → 真遮挡，照旧报（无 role / 无标签 backdrop 照样能报）。
  + ' const outside = [];'
  + ' const all = document.querySelectorAll("button, a, input, select, textarea, [role=\\"button\\"], [role=\\"link\\"]");'
  + ' for (let i = 0; i < all.length && outside.length < 8; i++) {'
  + '   const el = all[i];'
  + '   if (node.contains(el)) continue;'
  + '   const r = el.getBoundingClientRect();'
  + '   if (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) continue;'
  + '   outside.push(el);'
  + ' }'
  + ' if (outside.length === 0) return null;'
  + ' for (let i = 0; i < outside.length; i++) {'
  + '   const el = outside[i];'
  + '   const r = el.getBoundingClientRect();'
  + '   const cx = Math.round(Math.min(Math.max((r.left + r.right) / 2, 0), vw - 1));'
  + '   const cy = Math.round(Math.min(Math.max((r.top + r.bottom) / 2, 0), vh - 1));'
  + '   const hit = document.elementFromPoint(cx, cy);'
  + '   if (hit === el || (hit !== null && el.contains(hit))) return null;'
  + ' }'
  + ' const dialog = node.closest(\'[role="dialog"], [aria-modal="true"], dialog\');'
  + ' const target = dialog || node;'
  + ' const role = target.getAttribute("role") || String(target.tagName || "").toLowerCase();'
  + ' const name = nameOf(target);'
  + ' const hint = target.id ? "#" + target.id'
  + '   : (typeof target.className === "string" && target.className.trim().length > 0'
  + '     ? "." + target.className.trim().split(/\\s+/)[0] : "");'
  + ' return { role: role, name: name, hint: hint };'
  + ' })()'

/**
 * `webpage_fill` 在页面里执行的填值函数；返回值告诉调用方走了哪条分支。
 *
 * - `'value'`：`input` / `textarea` —— 原生 setter + `input`/`change`，本框架听得懂。
 * - `'editable'`：`contenteditable` —— **只聚焦 + 全选**，真正的写入交给调用方随后发的
 *   `Input.insertText`。
 * - `'text'`：其它元素 —— 保持既有的 `textContent` 行为。
 *
 * 为什么 `contenteditable` 不能直接写 `textContent`（2026-09-18 修）：Lexical / ProseMirror /
 * Slate 这类富文本框架（AI 问答页输入框的主流实现）监听的是 `beforeinput`，赋值 `textContent`
 * 不会触发它 —— 框架内部状态不更新、发送按钮不亮，模型以为填好了其实没填进去。
 * `Input.insertText` 走浏览器原生输入管线（与真人键入同一条路），会派发 `beforeinput`/`input`，
 * 框架才认。它的语义是「在选区处插入」而不是「设为」，所以必须先把已有内容全选，否则新值会被
 * 拼接到旧内容后面。
 */
export const FILL_FUNCTION = 'function (value) {'
  + ' const element = this;'
  + ' if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {'
  + '   const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;'
  + '   const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");'
  + '   if (descriptor && descriptor.set) { descriptor.set.call(element, value); } else { element.value = value; }'
  + '   element.dispatchEvent(new Event("input", { bubbles: true }));'
  + '   element.dispatchEvent(new Event("change", { bubbles: true }));'
  + '   return "value";'
  + ' }'
  + ' if (element.isContentEditable === true) {'
  + '   element.focus();'
  + '   const selection = window.getSelection();'
  + '   if (selection) {'
  + '     const range = document.createRange();'
  + '     range.selectNodeContents(element);'
  + '     selection.removeAllRanges();'
  + '     selection.addRange(range);'
  + '   }'
  + '   return "editable";'
  + ' }'
  + ' element.textContent = value;'
  + ' element.dispatchEvent(new Event("input", { bubbles: true }));'
  + ' element.dispatchEvent(new Event("change", { bubbles: true }));'
  + ' return "text"; }'
