import { KEY, sortNames, filterNames, planSelection, validateGroups, validateFavorites, libraryNames, nativeSnapshot, sameSet, unique } from './core.mjs';

let root, native, context, search, modeSelect, sortSelect, list, groupsList, count, status, undoButton;
let optionObserver, pageObserver, timer, syncTimer, disposed = false, undoState = null, busy = false;
let groups = [], configValid = true, groupQuery = '';
let activeDialog = null;
let orb, settingsRoot, mountListeners, resizeTimer, dragTimer;
let drag = null, dragged = false;
let activeTab = 'books', booksPage, combosPage, groupSearch, tabs, lastOpener;
let bulkOn, bulkOff;
let orbAnchor = {};
let temporarilyDocked = false;
let favorites = [], folders = [], favoritesValid = true, foldersValid = true;
let activeFolder = '__unfiled__', folderTools, folderSelect, manageFolder, newFolderButton;
const tabIds = ['books', 'favorites', 'folders', 'groups'];
const viewStates = new Map();
const unsubscribers = [];
const getContext = () => globalThis.SillyTavern?.getContext?.();
const jq = () => globalThis.jQuery || globalThis.$;

function el(tag, text, cls) {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (cls) n.className = cls;
    return n;
}
function button(text, action, cls = '') {
    const b = el('button', text, `glm-button ${cls}`);
    b.type = 'button';
    b.addEventListener('click', () => Promise.resolve().then(action).catch(showError));
    return b;
}
function say(text, error = false) {
    if (status) { status.textContent = text; status.classList.toggle('glm-error', error); }
}
function showError(e) { say(e?.message || String(e), true); }
function snapshot() { return nativeSnapshot(native, getContext().getWorldInfoNames()); }
function settings() { return getContext().extensionSettings[KEY] || {}; }
function persist(extra = {}) {
    const ctx = getContext();
    ctx.extensionSettings[KEY] = { ...settings(), ...extra };
    ctx.saveSettingsDebounced();
}
function saveGroups(next) {
    if (!configValid) throw new Error('旧组合数据无效，暂不覆盖。请先保留设置并排查。');
    groups = validateGroups(next);
    persist({ groups });
    renderGroups();
}
function saveFolders(next) {
    if (!foldersValid) throw new Error('旧文件夹数据无效，暂不覆盖。请先保留设置并排查。');
    folders = validateGroups(next, '文件夹');
    if (!folders.some(f => f.id === activeFolder)) activeFolder = '__unfiled__';
    persist({ folders, lastFolderId: activeFolder }); sync();
}
function toggleFavorite(name) {
    if (!favoritesValid) throw new Error('旧收藏数据无效，暂不覆盖。请先保留设置并排查。');
    const removing = favorites.includes(name);
    favorites = validateFavorites(removing ? favorites.filter(n => n !== name) : [...favorites, name]);
    persist({ favorites }); sync();
    say(`${removing ? '已取消收藏' : '已收藏'}「${name}」，启用状态未改变。`);
}
function openBook(name) {
    const record = snapshot().records.find(r => r.name === name);
    const editor = document.querySelector('#world_editor_select');
    if (!editor || !record) throw new Error('找不到世界书编辑入口，请刷新目录。');
    if (document.querySelector('#WorldInfo')?.classList.contains('closedDrawer')) jq()('#WIDrawerIcon').trigger('click');
    jq()(editor).val(record.value).trigger('change'); closePanel(false);
}
function restoreDialogFocus(opener) {
    const replacement = opener?.dataset?.focus ? [...root.querySelectorAll('[data-focus]')].find(n => n.dataset.focus === opener.dataset.focus) : null;
    (opener?.isConnected ? opener : replacement || tabs[tabIds.indexOf(activeTab)])?.focus({ preventScroll: true });
}

// Native selection events can arrive twice. Retain the focused control when
// rebuilding a list; never steal focus from the search field or another app UI.
function replaceList(container, fragment) {
    const focused = document.activeElement;
    const controls = [...container.querySelectorAll('[data-focus]')];
    const index = controls.indexOf(focused);
    const key = index >= 0 ? focused.dataset.focus : null;
    const scroll = container.scrollTop;
    container.replaceChildren(fragment);
    if (key !== null) {
        const next = [...container.querySelectorAll('[data-focus]')];
        (next.find(n => n.dataset.focus === key) || next[Math.min(index, next.length - 1)] || (activeTab === 'groups' ? groupSearch : search))?.focus({ preventScroll: true });
    }
    container.scrollTop = scroll;
}

function applySelection(target, description, remember = true) {
    const before = snapshot();
    const wanted = unique(target);
    if (wanted.some(n => !before.names.includes(n))) throw new Error('所选世界书已不存在，请刷新目录。');
    if (sameSet(before.selected, wanted)) { say('当前启用列表已经相同，无需修改。'); return; }
    const values = before.records.filter(r => wanted.includes(r.name)).map(r => r.value);
    // ST's own change handler updates selected_world_info and saves account settings.
    jq()(native).val(values).trigger('change');
    const after = snapshot();
    if (!sameSet(after.selected, wanted)) throw new Error('酒馆没有接受完整选择，请检查原生列表。');
    undoState = remember ? { before: before.selected, after: after.selected } : null;
    sync();
    say(`${description}。全局已开启 ${after.selected.length} 本；对后续生成生效。`);
}

function visibleNames(s = snapshot()) {
    return filterNames(libraryNames(s.names, favorites, folders, activeTab, activeFolder), s.selected, search.value, modeSelect.value, sortSelect.value);
}
function renderList(s) {
    const visible = visibleNames(s);
    const scope = libraryNames(s.names, favorites, folders, activeTab, activeFolder);
    const missingCount = scope.filter(n => !s.names.includes(n)).length;
    const prefix = activeTab === 'favorites' ? `收藏 ${scope.length} 本` : activeTab === 'folders' ? `本分类 ${scope.length} 本` : `共 ${s.names.length} 本`;
    count.textContent = `${prefix} · 全局已开 ${s.selected.length} 本 · 当前显示 ${visible.length} 本${missingCount ? ` · 缺失 ${missingCount} 本` : ''}`;
    bulkOn.disabled = !visible.some(n => s.names.includes(n) && !s.selected.includes(n));
    bulkOff.disabled = !visible.some(n => s.selected.includes(n));
    bulkOn.title = `开启筛选结果中尚未开启的 ${visible.filter(n => s.names.includes(n) && !s.selected.includes(n)).length} 本`;
    bulkOff.title = `关闭筛选结果中已开启的 ${visible.filter(n => s.selected.includes(n)).length} 本`;
    const frag = document.createDocumentFragment();
    for (const name of visible) {
        const missing = !s.names.includes(name);
        const row = el('div', undefined, 'glm-book');
        const label = el('label');
        const check = el('input');
        check.type = 'checkbox'; check.checked = s.selected.includes(name);
        check.disabled = missing;
        check.dataset.focus = `book:${name}`;
        check.addEventListener('change', () => {
            try {
                const current = snapshot().selected;
                applySelection(check.checked ? unique([...current, name]) : current.filter(n => n !== name), `${check.checked ? '开启' : '关闭'}「${name}」`);
            } catch (e) { sync(); showError(e); }
        });
        const text = el('span', name); text.title = name;
        label.append(check, text);
        if (missing) { const badge = el('small', '缺失', 'glm-warning'); badge.title = '已删除或改名'; label.append(badge); }
        const star = button(favorites.includes(name) ? '★' : '☆', () => toggleFavorite(name), 'glm-star');
        star.setAttribute('aria-label', `${favorites.includes(name) ? '取消收藏' : '收藏'}世界书 ${name}`);
        star.setAttribute('aria-pressed', String(favorites.includes(name)));
        star.title = favorites.includes(name) ? '取消收藏，不会关闭世界书' : '加入收藏夹，不会自动启用';
        star.dataset.focus = `star:${name}`; star.disabled = !favoritesValid;
        const edit = button('编辑', () => openBook(name), 'glm-edit');
        edit.disabled = missing; edit.title = '打开酒馆原生世界书编辑器';
        edit.setAttribute('aria-label', `编辑世界书 ${name}`);
        edit.dataset.focus = `edit:${name}`;
        const organize = button('分类', () => openAssignment(name), 'glm-edit');
        organize.setAttribute('aria-label', `整理世界书 ${name}`); organize.title = '将这本书放入一个或多个文件夹';
        organize.dataset.focus = `organize:${name}`; organize.disabled = missing || !foldersValid;
        row.append(label, star, edit, organize); frag.append(row);
    }
    if (!visible.length) {
        const empty = el('div', undefined, 'glm-empty');
        const text = !s.names.length ? '当前账号还没有世界书' : scope.length ? '没有匹配的世界书' : activeTab === 'favorites' ? '还没有收藏。在世界书旁点 ☆ 即可加入。' : activeFolder === '__unfiled__' ? '全部世界书都已分类。' : '文件夹是空的。点“管理文件夹”添加成员，或在世界书旁点“分类”。';
        empty.append(el('p', text));
        if (search.value || modeSelect.value !== 'all') empty.append(button('清除搜索和筛选', () => { search.value = ''; modeSelect.value = 'all'; sync(); search.focus(); }));
        frag.append(empty);
    }
    replaceList(list, frag);
}

function renderGroups(s = null) {
    if (!groupsList) return;
    try { s ||= snapshot(); } catch { return; }
    const frag = document.createDocumentFragment();
    const matching = groups.filter(g => g.name.toLowerCase().includes(groupQuery.toLowerCase()));
    for (const name of sortNames(matching.map(g => g.name))) {
        const g = matching.find(g => g.name === name);
        const row = el('div', undefined, 'glm-group');
        const missing = g.books.filter(n => !s.names.includes(n));
        const on = g.books.filter(n => s.selected.includes(n)).length;
        const exact = !missing.length && sameSet(g.books, s.selected);
        row.append(el('strong', g.name), el('span', ` ${on}/${g.books.length} 已开${exact ? ' · 当前组合' : ''}${missing.length ? ` · 缺失 ${missing.length} 本` : ''}`, 'glm-muted'));
        const actions = el('div', undefined, 'glm-actions');
        for (const [text, label, action] of [['仅启用此组合', '切换', 'replace'], ['追加开启', '开启', 'enable'], ['关闭成员', '关闭', 'disable']]) {
            const b = button(text, () => {
                const live = snapshot();
                const plan = planSelection(live.selected, g.books, live.names, action);
                const off = live.selected.filter(n => !plan.target.includes(n));
                const on = plan.target.filter(n => !live.selected.includes(n));
                if (action === 'replace' && off.length && !globalThis.confirm(`仅启用「${g.name}」？\n将开启 ${on.length} 本、关闭 ${off.length} 本其他世界书。\n${plan.target.length ? '其他全局书将关闭；操作后可撤销。' : '这是空组合，将关闭全部全局世界书；操作后可撤销。'}`)) return;
                applySelection(plan.target, `${label}组合「${g.name}」`);
            }, action === 'replace' ? 'glm-primary' : '');
            b.title = action === 'replace' ? '替换当前全局启用列表' : action === 'enable' ? '开启组合成员，保留其他书' : '关闭组合成员，保留其他书';
            b.setAttribute('aria-label', `${label}组合 ${g.name}`);
            b.dataset.focus = `${action}:${g.id}`;
            actions.append(b);
        }
        const edit = button('编辑', () => openGroupEditor(g));
        edit.setAttribute('aria-label', `编辑组合 ${g.name}`);
        edit.dataset.focus = `edit:${g.id}`;
        actions.append(edit); row.append(actions);
        if (missing.length) row.append(el('p', `已删除或改名：${missing.join('、')}`, 'glm-warning'));
        frag.append(row);
    }
    if (!matching.length) frag.append(el('p', groups.length ? '没有匹配的组合。' : '还没有组合。可把当前启用列表保存为组合，再编辑成员。', 'glm-muted'));
    replaceList(groupsList, frag);
}

function sync() {
    if (disposed || !root?.isConnected) return;
    try {
        const s = snapshot();
        if (undoState && !sameSet(s.selected, undoState.after)) undoState = null;
        undoButton.disabled = !undoState;
        renderFolderTools(s); renderList(s); renderGroups(s);
    } catch (e) { showError(e); }
}
function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(sync, 60); }

function renderFolderTools(s) {
    if (!folderSelect) return;
    if (activeFolder !== '__unfiled__' && !folders.some(f => f.id === activeFolder)) activeFolder = '__unfiled__';
    const fragment = document.createDocumentFragment();
    const unfiled = libraryNames(s.names, favorites, folders, 'folders', '__unfiled__').length;
    fragment.append(new Option(`未分类 (${unfiled})`, '__unfiled__'));
    for (const name of sortNames(folders.map(f => f.name))) {
        const f = folders.find(f => f.name === name);
        fragment.append(new Option(`${f.name} (${f.books.length})`, f.id));
    }
    folderSelect.replaceChildren(fragment); folderSelect.value = activeFolder;
    manageFolder.disabled = !foldersValid || activeFolder === '__unfiled__';
    newFolderButton.disabled = !foldersValid;
}

function openAssignment(name) {
    if (activeDialog) return;
    if (!foldersValid) throw new Error('文件夹数据无效，暂不覆盖。');
    const opener = document.activeElement;
    const dialog = el('dialog', undefined, 'glm-dialog'); activeDialog = dialog;
    dialog.setAttribute('aria-label', '整理世界书');
    const heading = el('h3', '整理世界书');
    heading.tabIndex = -1; heading.setAttribute('autofocus', '');
    const top = el('div', undefined, 'glm-dialog-top');
    top.append(heading, el('strong', name), el('p', '可选多个文件夹。这里只做分类，不移动文件、不改变启用状态。', 'glm-muted'));
    const selected = new Set(folders.filter(f => f.books.includes(name)).map(f => f.id));
    const initial = [...selected];
    const close = () => { dialog.close(); dialog.remove(); activeDialog = null; restoreDialogFocus(opener); };
    const cancel = () => {
        if (!sameSet([...selected], initial) && !globalThis.confirm('分类有未保存的修改。放弃这些修改？')) return;
        close();
    };
    dialog.addEventListener('cancel', e => { e.preventDefault(); cancel(); });
    const members = el('div', undefined, 'glm-member-list');
    for (const folderName of sortNames(folders.map(f => f.name))) {
        const folder = folders.find(f => f.name === folderName);
        const label = el('label', undefined, 'glm-member');
        const check = el('input'); check.type = 'checkbox'; check.checked = selected.has(folder.id);
        check.addEventListener('change', () => { if (check.checked) selected.add(folder.id); else selected.delete(folder.id); });
        label.append(check, el('span', folder.name)); members.append(label);
    }
    if (!folders.length) {
        members.append(el('p', '还没有文件夹。新建后即可把这本书放进去。', 'glm-empty'), button('新建文件夹并加入这本书', () => { close(); openGroupEditor(null, 'folder', [name]); }));
    }
    const localError = el('p', '', 'glm-error'); localError.setAttribute('role', 'status');
    const actions = el('div', undefined, 'glm-actions');
    const save = button('保存分类', () => {
        try {
            saveFolders(folders.map(f => ({ ...f, books: selected.has(f.id) ? unique([...f.books, name]) : f.books.filter(n => n !== name) })));
            close(); say(`「${name}」分类已更新；启用状态未改变。`);
        } catch (e) { localError.textContent = e.message; }
    }, 'glm-primary');
    save.disabled = !folders.length;
    actions.append(save, button('取消', cancel));
    const bottom = el('div', undefined, 'glm-dialog-bottom'); bottom.append(localError, actions);
    dialog.append(top, members, bottom); document.body.append(dialog); positionDialog(); dialog.showModal(); heading.focus();
}

function openGroupEditor(existing = null, kind = 'group', seed = null) {
    if (activeDialog) return;
    const isFolder = kind === 'folder', noun = isFolder ? '文件夹' : '组合';
    if (isFolder ? !foldersValid : !configValid) throw new Error(`${noun}数据无效，暂不覆盖。`);
    const initial = snapshot();
    const members = new Set(existing?.books ?? seed ?? (isFolder ? [] : initial.selected));
    const dialog = el('dialog', undefined, 'glm-dialog');
    const opener = document.activeElement;
    activeDialog = dialog;
    const heading = el('h3', existing ? `编辑${noun}` : isFolder ? '新建文件夹' : '保存为新组合');
    heading.id = 'glm-editor-title'; dialog.setAttribute('aria-labelledby', heading.id);
    const nameLabel = el('label', `${noun}名称`);
    const nameInput = el('input'); nameInput.id = 'glm-group-name'; nameInput.maxLength = 80;
    nameInput.value = existing?.name || ''; nameLabel.htmlFor = nameInput.id;
    const find = el('input'); find.type = 'search'; find.placeholder = `搜索${noun}成员`; find.setAttribute('aria-label', `搜索${noun}成员`);
    const memberList = el('div', undefined, 'glm-member-list');
    const counter = el('p', '', 'glm-muted');
    const localError = el('p', '', 'glm-error'); localError.setAttribute('role', 'status');
    const initialName = existing?.name || '';
    const initialMembers = [...members];
    const close = () => {
        dialog.close(); dialog.remove(); activeDialog = null;
        restoreDialogFocus(opener);
    };
    const cancel = () => {
        if ((nameInput.value !== initialName || !sameSet([...members], initialMembers)) && !globalThis.confirm(`${noun}有未保存的修改。放弃这些修改？`)) return;
        close();
    };
    dialog.addEventListener('cancel', e => { e.preventDefault(); cancel(); });
    const updateCounter = () => { counter.textContent = `已选 ${members.size} 本 · 保存不会切换当前启用列表`; };
    function renderMembers() {
        const current = snapshot();
        updateCounter();
        const names = filterNames(unique([...current.names, ...(existing?.books ?? []), ...members]), [], find.value);
        const frag = document.createDocumentFragment();
        for (const name of names) {
            const label = el('label', undefined, 'glm-member');
            const c = el('input'); c.type = 'checkbox'; c.checked = members.has(name);
            c.dataset.focus = name;
            c.addEventListener('change', () => { if (c.checked) members.add(name); else members.delete(name); updateCounter(); });
            label.append(c, el('span', name + (current.names.includes(name) ? '' : '（缺失）')));
            frag.append(label);
        }
        if (!names.length) frag.append(el('p', '没有匹配的成员。', 'glm-empty'));
        replaceList(memberList, frag);
    }
    find.addEventListener('input', renderMembers);
    const memberActions = el('div', undefined, 'glm-actions');
    memberActions.append(button('加入当前搜索结果', () => { for (const n of filterNames(snapshot().names, [], find.value)) members.add(n); renderMembers(); }),
        button('移除当前搜索结果', () => { for (const n of filterNames([...members], [], find.value)) members.delete(n); renderMembers(); }));
    const actions = el('div', undefined, 'glm-actions');
    actions.append(button(`保存${noun}`, () => {
        try {
            const name = nameInput.value.trim();
            if (!name) throw new Error(`请填写${noun}名称。`);
            const collection = isFolder ? folders : groups;
            if (collection.some(g => g.id !== existing?.id && g.name === name)) throw new Error(`${noun}名称已存在，请换个名称。`);
            if (isFolder && name === '未分类') throw new Error('“未分类”是系统视图，请换个名称。');
            const id = globalThis.crypto?.randomUUID?.() || `${kind}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            const item = { id: existing?.id || id, name, books: [...members] };
            const next = existing ? collection.map(g => g.id === existing.id ? item : g) : [...collection, item];
            if (isFolder) { activeFolder = item.id; saveFolders(next); } else saveGroups(next);
            close(); say(`${noun}「${name}」已更新，交由酒馆自动保存；当前启用列表未改变。`);
        } catch (e) { localError.textContent = e.message; }
    }, 'glm-primary'), button('取消', cancel));
    if (existing) actions.append(button(`删除${noun}`, () => {
        if (!globalThis.confirm(`删除${noun}「${existing.name}」？只删${noun}记录，不删除世界书，也不改变当前启用状态。`)) return;
        try {
            if (isFolder) saveFolders(folders.filter(g => g.id !== existing.id)); else saveGroups(groups.filter(g => g.id !== existing.id));
            close(); say(`已删除${noun}记录，世界书及启用状态保留。`);
        } catch (e) { localError.textContent = e.message; }
    }));
    const top = el('div', undefined, 'glm-dialog-top');
    top.append(heading, nameLabel, nameInput, find, counter, memberActions);
    const bottom = el('div', undefined, 'glm-dialog-bottom'); bottom.append(localError, actions);
    dialog.append(top, memberList, bottom);
    const finePointer = matchMedia('(pointer:fine)').matches;
    if (finePointer) nameInput.autofocus = true;
    else { heading.tabIndex = -1; heading.setAttribute('autofocus', ''); }
    document.body.append(dialog); renderMembers(); positionDialog(); dialog.showModal();
    if (finePointer) nameInput.focus();
    else heading.focus();
}

function orbSize() {
    const value = Number(settings().orbSize);
    return Number.isFinite(value) ? Math.min(88, Math.max(32, value)) : 52;
}
function viewport() {
    const v = globalThis.visualViewport;
    return { x: v?.offsetLeft || 0, y: v?.offsetTop || 0, width: v?.width || innerWidth, height: v?.height || innerHeight };
}
function placeOrb(x, y) {
    const size = orbSize(), v = viewport();
    const left = Math.max(v.x + 4, Math.min(Number.isFinite(x) ? x : v.x + v.width - size - 18, v.x + v.width - size - 4));
    const top = Math.max(v.y + 4, Math.min(Number.isFinite(y) ? y : v.y + v.height - size - 100, v.y + v.height - size - 4));
    Object.assign(orb.style, { width: size + 'px', height: size + 'px', left: left + 'px', top: top + 'px' });
    return { x: left, y: top };
}
function positionPanel() {
    if (!root || root.hidden) return;
    const v = viewport(), margin = 10, gap = 12;
    let width = Math.min(560, v.width - margin * 2);
    let r = orb.hidden ? { left: v.x + v.width, right: v.x + v.width, top: v.y + v.height, bottom: v.y + v.height } : orb.getBoundingClientRect();
    let leftRoom = r.left - v.x - gap - margin;
    let rightRoom = v.x + v.width - r.right - gap - margin;
    let beside = Math.max(leftRoom, rightRoom) >= Math.min(360, width);
    let above = r.top - v.y - gap - margin;
    let below = v.y + v.height - r.bottom - gap - margin;
    // A saved middle-of-screen position must not cover the search or buttons
    // on phones. Dock temporarily, without changing the saved drag position.
    if (!orb.hidden && !beside && Math.max(above, below) < 350 && !drag) {
        const size = orbSize();
        placeOrb(v.x + v.width - size - 8, v.y + v.height - size - 8);
        temporarilyDocked = true; r = orb.getBoundingClientRect();
        leftRoom = r.left - v.x - gap - margin; rightRoom = v.x + v.width - r.right - gap - margin;
        beside = Math.max(leftRoom, rightRoom) >= Math.min(360, width);
        above = r.top - v.y - gap - margin; below = v.y + v.height - r.bottom - gap - margin;
    }
    if (beside) width = Math.min(width, Math.max(leftRoom, rightRoom));
    const height = Math.min(690, v.height - margin * 2,
        !beside ? Math.max(above, below) : Infinity);
    root.classList.toggle('glm-compact', height < 480);
    let left = beside ? (leftRoom >= width ? r.left - width - gap : r.right + gap) : v.x + (v.width - width) / 2;
    let top = !beside && below > above ? r.bottom + gap : r.bottom - height;
    if (!beside && above >= below) top = r.top - gap - height;
    left = Math.max(v.x + margin, Math.min(left, v.x + v.width - width - margin));
    top = Math.max(v.y + margin, Math.min(top, v.y + v.height - height - margin));
    Object.assign(root.style, { width: `${width}px`, height: `${height}px`, left: `${left}px`, top: `${top}px` });
}
function positionDialog() {
    if (!activeDialog) return;
    const v = viewport(), width = Math.min(590, v.width - 20), height = Math.min(700, v.height - 20);
    activeDialog.classList.toggle('glm-compact', height < 480);
    Object.assign(activeDialog.style, { width: `${width}px`, height: `${height}px`, left: `${v.x + (v.width - width) / 2}px`, top: `${v.y + (v.height - height) / 2}px` });
}
function closePanel(restoreFocus = true) {
    if (!root) return;
    root.hidden = true; orb?.setAttribute('aria-expanded', 'false');
    if (temporarilyDocked) { temporarilyDocked = false; placeOrb(orbAnchor.x, orbAnchor.y); }
    if (restoreFocus) (lastOpener?.isConnected && !lastOpener.hidden ? lastOpener : !orb.hidden ? orb : settingsRoot.querySelector('button'))?.focus({ preventScroll: true });
}
function openPanel() {
    if (root.hidden) lastOpener = document.activeElement;
    sync(); root.hidden = false; orb.setAttribute('aria-expanded', 'true'); positionPanel();
    if (matchMedia('(pointer:fine)').matches) (activeTab === 'groups' ? groupSearch : search).focus({ preventScroll: true });
    else root.focus({ preventScroll: true });
}
function switchTab(value, focus = false) {
    const changed = value !== activeTab;
    if (changed && activeTab !== 'groups') viewStates.set(activeTab, { query: search.value, mode: modeSelect.value });
    activeTab = value;
    booksPage.hidden = value === 'groups'; combosPage.hidden = value !== 'groups';
    folderTools.hidden = value !== 'folders';
    if (value !== 'groups') {
        if (changed) {
            const state = viewStates.get(value) || { query: '', mode: 'all' };
            search.value = state.query; modeSelect.value = state.mode;
        }
        booksPage.setAttribute('aria-labelledby', `glm-tab-${tabIds.indexOf(value)}`);
    }
    tabs.forEach((tab, i) => {
        const selected = tabIds[i] === value;
        tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
        if (focus && selected) tab.focus();
    });
    sync();
}
function createOrbAndSettings() {
    mountListeners = new AbortController();
    orb = el('button', undefined, 'glm-orb');
    orb.type = 'button'; orb.title = '全局世界书管理（拖动可移动）';
    orb.setAttribute('aria-label', 'DeepSeek风格悬浮球：全局世界书管理');
    orb.setAttribute('aria-controls', KEY); orb.setAttribute('aria-expanded', 'false');
    const icon = el('img'); icon.src = new URL('./assets/deepseek.png', import.meta.url).href;
    icon.alt = ''; icon.draggable = false; orb.append(icon);
    document.body.append(orb);
    orbAnchor = settings().orbPosition || {};
    placeOrb(orbAnchor.x, orbAnchor.y);
    orb.hidden = settings().orbEnabled === false;
    orb.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        const r = orb.getBoundingClientRect();
        clearTimeout(dragTimer); dragged = false; drag = { id: e.pointerId, x: e.clientX, y: e.clientY, left: r.left, top: r.top };
        orb.setPointerCapture(e.pointerId);
    });
    orb.addEventListener('pointermove', e => {
        if (!drag || drag.id !== e.pointerId) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.hypot(dx, dy) > 5) dragged = true;
        if (dragged) { placeOrb(drag.left + dx, drag.top + dy); positionPanel(); }
    });
    function endDrag(e) {
        if (!drag || drag.id !== e.pointerId) return;
        if (dragged) {
            const r = orb.getBoundingClientRect(); orbAnchor = { x: r.left, y: r.top }; persist({ orbPosition: orbAnchor });
            temporarilyDocked = false;
        }
        if (orb.hasPointerCapture(e.pointerId)) orb.releasePointerCapture(e.pointerId);
        drag = null;
        positionPanel();
        dragTimer = setTimeout(() => { dragged = false; }, 100);
    }
    orb.addEventListener('pointerup', endDrag);
    orb.addEventListener('pointercancel', endDrag);
    orb.addEventListener('click', e => {
        if (dragged && e.detail !== 0) { dragged = false; return; }
        dragged = false; if (root.hidden) openPanel(); else closePanel();
    });
    function resized() {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            if (!orb) return;
            placeOrb(orbAnchor.x, orbAnchor.y); positionPanel(); positionDialog();
        }, 80);
    }
    const listener = { signal: mountListeners.signal };
    window.addEventListener('resize', resized, listener);
    globalThis.visualViewport?.addEventListener('resize', resized, listener);
    globalThis.visualViewport?.addEventListener('scroll', resized, listener);
    document.addEventListener('pointerdown', e => {
        if (!root.hidden && !activeDialog && !root.contains(e.target) && !orb.contains(e.target)) closePanel(false);
    }, listener);
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !root.hidden && !activeDialog) { e.preventDefault(); closePanel(); }
    }, listener);

    settingsRoot = el('div', undefined, 'extension_container glm-settings');
    const details = el('details'); details.append(el('summary', '全局世界书管理 · 悬浮球'));
    const enabledLabel = el('label');
    const toggle = el('input'); toggle.type = 'checkbox'; toggle.checked = !orb.hidden;
    enabledLabel.append(toggle, document.createTextNode(' 显示DeepSeek风格悬浮球'));
    toggle.addEventListener('change', () => { orb.hidden = !toggle.checked; persist({ orbEnabled: toggle.checked }); positionPanel(); });
    const sizeLabel = el('label', '悬浮球大小');
    const slider = el('input'); slider.type = 'range'; slider.min = '32'; slider.max = '88'; slider.step = '2';
    slider.value = String(orbSize()); slider.id = 'glm-orb-size'; sizeLabel.htmlFor = slider.id;
    const sizeText = el('output', `${orbSize()} px`); sizeText.htmlFor = slider.id;
    slider.addEventListener('input', () => {
        const size = Number(slider.value);
        persist({ orbSize: size }); sizeText.textContent = `${size} px`; placeOrb(orbAnchor.x, orbAnchor.y); positionPanel();
    });
    details.append(enabledLabel, sizeLabel, slider, sizeText, el('p', '只改变外观，不会切换当前模型或接口。', 'glm-muted'),
        button('打开全局世界书管理', openPanel), button('重置悬浮球位置', () => {
            orbAnchor = {}; placeOrb(); persist({ orbPosition: null }); positionPanel();
        }));
    settingsRoot.append(details);
    (document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings')).append(settingsRoot);
}

function mount(select) {
    native = select;
    context = getContext();
    snapshot();
    let loadError = ''; configValid = true; favoritesValid = true; foldersValid = true;
    try { groups = validateGroups(settings().groups ?? []); }
    catch (e) { groups = []; configValid = false; loadError = e.message; }
    try { favorites = validateFavorites(settings().favorites ?? []); }
    catch (e) { favorites = []; favoritesValid = false; loadError += ` ${e.message}`; }
    try { folders = validateGroups(settings().folders ?? [], '文件夹'); }
    catch (e) { folders = []; foldersValid = false; loadError += ` ${e.message}`; }
    activeFolder = typeof settings().lastFolderId === 'string' ? settings().lastFolderId : '__unfiled__';
    root = el('section', undefined, 'glm-panel'); root.id = KEY; root.hidden = true; root.tabIndex = -1;
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'false'); root.setAttribute('aria-label', '全局世界书管理');
    const header = el('div', undefined, 'glm-header');
    const title = el('div'); title.append(el('span', 'LORE MANAGER', 'glm-eyebrow'), el('strong', '全局世界书管理'));
    header.append(title, button('关闭面板', () => closePanel(), 'glm-close'));
    const tabBar = el('div', undefined, 'glm-tabs'); tabBar.setAttribute('role', 'tablist'); tabBar.setAttribute('aria-label', '管理分类');
    tabs = ['世界书', '收藏夹', '文件夹', '组合'].map((name, i) => {
        const b = button(name, () => switchTab(tabIds[i]));
        b.id = `glm-tab-${i}`; b.setAttribute('role', 'tab'); b.setAttribute('aria-controls', i === 3 ? 'glm-page-groups' : 'glm-page-books');
        b.addEventListener('keydown', e => {
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
                e.preventDefault();
                const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabIds.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabIds.length) % tabIds.length;
                switchTab(tabIds[next], true);
            }
        });
        tabBar.append(b); return b;
    });
    booksPage = el('div', undefined, 'glm-page'); combosPage = el('div', undefined, 'glm-page');
    [booksPage, combosPage].forEach((page, i) => { page.id = i ? 'glm-page-groups' : 'glm-page-books'; page.setAttribute('role', 'tabpanel'); page.setAttribute('aria-labelledby', `glm-tab-${i ? 3 : 0}`); });
    search = el('input'); search.type = 'search'; search.placeholder = '搜索世界书名称（空格分隔多个词）';
    search.setAttribute('aria-label', '搜索世界书名称'); search.addEventListener('input', sync);
    const searchRow = el('div', undefined, 'glm-search-row');
    searchRow.append(search, button('清空', () => { search.value = ''; sync(); search.focus(); }));
    folderTools = el('div', undefined, 'glm-folder-tools');
    folderSelect = el('select'); folderSelect.setAttribute('aria-label', '选择文件夹');
    folderSelect.addEventListener('change', () => { activeFolder = folderSelect.value; persist({ lastFolderId: activeFolder }); sync(); });
    newFolderButton = button('新建文件夹', () => openGroupEditor(null, 'folder'));
    manageFolder = button('管理文件夹', () => {
        const folder = folders.find(f => f.id === activeFolder); if (folder) openGroupEditor(folder, 'folder');
    });
    folderTools.append(folderSelect, newFolderButton, manageFolder);
    const controls = el('div', undefined, 'glm-actions');
    modeSelect = el('select'); modeSelect.setAttribute('aria-label', '显示范围');
    for (const [v, t] of [['all', '全部'], ['on', '已开启'], ['off', '未开启']]) modeSelect.add(new Option(t, v));
    sortSelect = el('select'); sortSelect.setAttribute('aria-label', '排序方式');
    for (const [v, t] of [['name', '名称 / 拼音顺序'], ['active', '已开启优先'], ['original', '酒馆原顺序']]) sortSelect.add(new Option(t, v));
    sortSelect.value = ['name', 'active', 'original'].includes(settings().sort) ? settings().sort : 'name';
    modeSelect.addEventListener('change', sync);
    sortSelect.addEventListener('change', () => { persist({ sort: sortSelect.value }); sync(); });
    controls.append(modeSelect, sortSelect);
    const bulk = el('div', undefined, 'glm-actions');
    bulkOn = button('开启结果', () => {
        const s = snapshot(); applySelection(unique([...s.selected, ...visibleNames(s).filter(n => s.names.includes(n))]), '已开启当前搜索结果');
    });
    bulkOff = button('关闭结果', () => {
        const s = snapshot(), names = new Set(visibleNames(s));
        applySelection(s.selected.filter(n => !names.has(n)), '已关闭当前搜索结果');
    });
    bulkOn.setAttribute('aria-label', '开启当前结果'); bulkOff.setAttribute('aria-label', '关闭当前结果');
    bulk.append(bulkOn, bulkOff);
    undoButton = button('撤销上次开关', () => {
        if (!undoState) return;
        const s = snapshot();
        if (!sameSet(s.selected, undoState.after)) { undoState = null; sync(); throw new Error('启用列表已在别处改变，无法撤销旧操作。'); }
        applySelection(undoState.before, '已恢复上次启用列表', false);
    });
    undoButton.disabled = true;
    const refresh = button('刷新目录', async () => {
        if (busy) return;
        busy = true; refresh.disabled = true;
        try { await getContext().updateWorldInfoList(); sync(); say('世界书目录已刷新。'); }
        finally { busy = false; refresh.disabled = false; }
    });
    bulk.append(refresh);
    count = el('p', '', 'glm-muted');
    list = el('div', undefined, 'glm-list'); list.setAttribute('aria-label', '世界书列表');
    const groupActions = el('div', undefined, 'glm-actions');
    groupActions.append(button('当前启用保存为组合', () => openGroupEditor(), 'glm-primary'));
    groupSearch = el('input'); groupSearch.type = 'search'; groupSearch.placeholder = '搜索组合'; groupSearch.setAttribute('aria-label', '搜索组合'); groupSearch.value = groupQuery;
    groupSearch.addEventListener('input', () => { groupQuery = groupSearch.value; renderGroups(); });
    groupsList = el('div', undefined, 'glm-groups');
    combosPage.append(groupActions, groupSearch, el('p', '仅启用＝替换全局列表；追加开启＝保留其他书。关闭成员时，两组重叠的书也会关闭。', 'glm-muted'), groupsList);
    status = el('p', '只管理全局启用列表。角色、聊天和用户绑定的世界书另算。', 'glm-status');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    booksPage.append(folderTools, searchRow, controls, count, bulk, list);
    const footer = el('div', undefined, 'glm-footer'); footer.append(status, undoButton);
    root.append(header, tabBar, booksPage, combosPage, footer);
    switchTab(activeTab);
    document.body.append(root);
    createOrbAndSettings();
    sync(); if (loadError) showError(new Error(loadError));
    jq()(native).on('change.glm', scheduleSync);
    optionObserver = new MutationObserver(scheduleSync);
    optionObserver.observe(native, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['selected', 'value'] });
    const eventName = context.eventTypes?.WORLDINFO_SETTINGS_UPDATED;
    if (eventName && context.eventSource?.on) {
        context.eventSource.on(eventName, scheduleSync);
        unsubscribers.push(() => context.eventSource.removeListener(eventName, scheduleSync));
    }
}

function unmount() {
    clearTimeout(syncTimer);
    optionObserver?.disconnect();
    if (native) jq()?.(native).off('change.glm');
    mountListeners?.abort(); clearTimeout(resizeTimer); clearTimeout(dragTimer); drag = null;
    for (const off of unsubscribers.splice(0)) off();
    activeDialog?.close(); activeDialog?.remove(); activeDialog = null;
    root?.remove(); orb?.remove(); settingsRoot?.remove();
    root = null; orb = null; native = null; undoState = null;
}

function boot(attempt = 0) {
    if (disposed) return;
    const ctx = getContext(), select = document.querySelector('#world_info');
    if (!ctx?.getWorldInfoNames || !ctx.extensionSettings || !ctx.saveSettingsDebounced || !jq() || !select ||
        !(document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings'))) {
        if (attempt < 120) timer = setTimeout(() => boot(attempt + 1), 500);
        return;
    }
    try {
        mount(select);
        pageObserver = new MutationObserver(() => {
            if (disposed || (native?.isConnected && root?.isConnected)) return;
            pageObserver.disconnect(); unmount(); boot();
        });
        pageObserver.observe(document.body, { childList: true, subtree: true });
    } catch (e) {
        unmount(); console.error('[全局世界书管理]', e);
        if (attempt < 20) timer = setTimeout(() => boot(attempt + 1), 500);
    }
}
export function onDisable() {
    disposed = true; clearTimeout(timer); pageObserver?.disconnect(); unmount();
}
boot();
