export const KEY = 'global-lore-manager';
const collator = new Intl.Collator('zh-Hans-CN-u-co-pinyin', { numeric: true, sensitivity: 'base', ignorePunctuation: true });
const clean = name => name.normalize('NFKC').replace(/^[\s\p{P}\p{S}_]+/u, '');
export const unique = list => [...new Set(list)];
export const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));

export function sortNames(names) {
    return [...names].sort((a, b) => collator.compare(clean(a), clean(b)) || collator.compare(a, b));
}

export function filterNames(names, selected, query = '', mode = 'all', sort = 'name') {
    const terms = query.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    let list = names.filter(name => {
        const text = name.normalize('NFKC').toLocaleLowerCase();
        return terms.every(t => text.includes(t)) && (mode === 'all' || (mode === 'on') === selected.includes(name));
    });
    if (sort !== 'original') list = sortNames(list);
    if (sort === 'active') list.sort((a, b) => Number(selected.includes(b)) - Number(selected.includes(a)));
    return list;
}

/** Selection order is left to ST. Display sorting never changes world priority. */
export function planSelection(current, members, available, mode) {
    const existing = new Set(available);
    const missing = unique(members.filter(n => !existing.has(n)));
    if (!['replace', 'enable', 'disable'].includes(mode)) throw new Error('未知组合操作。');
    if (missing.length && mode !== 'disable') {
        throw new Error(`组合中有${missing.length}本书已删除或改名，未改变启用列表。请先编辑组合：${missing.slice(0, 3).join('、')}`);
    }
    const target = mode === 'replace' ? unique(members)
        : mode === 'enable' ? unique([...current, ...members])
            : current.filter(n => !members.includes(n));
    return { target, missing };
}

export function validateGroups(groups, label = '组合') {
    if (!Array.isArray(groups)) throw new Error(`${label}数据不是列表。`);
    const ids = new Set(), names = new Set();
    for (const g of groups) {
        if (!g || typeof g.id !== 'string' || !g.id || typeof g.name !== 'string' || !g.name.trim() ||
            g.name.length > 80 || !Array.isArray(g.books) || g.books.some(n => typeof n !== 'string' || !n)) {
            throw new Error(`${label}格式无效，原设置未覆盖。`);
        }
        if (ids.has(g.id) || names.has(g.name.trim())) throw new Error(`${label}名称或编号重复。`);
        ids.add(g.id); names.add(g.name.trim());
    }
    return groups.map(g => ({ id: g.id, name: g.name.trim(), books: unique(g.books) }));
}

export function validateFavorites(names) {
    if (!Array.isArray(names) || names.some(n => typeof n !== 'string' || !n)) throw new Error('收藏数据格式无效，原设置未覆盖。');
    return unique(names);
}

/** Virtual categories contain names, never filesystem paths or copies. */
export function libraryNames(available, favorites, folders, view = 'books', folderId = '__unfiled__') {
    if (view === 'favorites') return unique([...available.filter(n => favorites.includes(n)), ...favorites]);
    if (view === 'folders') {
        if (folderId === '__unfiled__') {
            const filed = new Set(folders.flatMap(f => f.books));
            return available.filter(n => !filed.has(n));
        }
        const members = folders.find(f => f.id === folderId)?.books || [];
        return unique([...available.filter(n => members.includes(n)), ...members]);
    }
    return [...available];
}

export function nativeSnapshot(select, worldNames) {
    if (!select?.multiple) throw new Error('找不到酒馆原生全局世界书多选框。');
    const records = [];
    for (const option of select.options) {
        if (option.value === '') continue;
        if (!/^\d+$/.test(option.value) || worldNames[Number(option.value)] !== option.textContent) {
            throw new Error('世界书列表正在刷新或接口不匹配，请稍后再试。');
        }
        records.push({ name: option.textContent, value: option.value, selected: option.selected });
    }
    if (records.length !== worldNames.length || new Set(records.map(r => r.name)).size !== records.length) {
        throw new Error('世界书目录与选择框不同步，请点击“刷新目录”。');
    }
    return { names: records.map(r => r.name), selected: records.filter(r => r.selected).map(r => r.name), records };
}
