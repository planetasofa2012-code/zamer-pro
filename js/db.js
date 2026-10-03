// Хранилище в телефоне (IndexedDB): папки, фото и их разметка.
// Элемент: { id, kind: 'folder' | 'photo', parentId, name, created, updated,
//            для фото: w, h, thumb, shapes }

const DB_NAME = 'zamershik';
let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('items', { keyPath: 'id' });
        d.createObjectStore('images');
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbPromise;
}

async function run(store, mode, fn) {
  const d = await open();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const allItems = () => run('items', 'readonly', (s) => s.getAll());
export const getItem = (id) => run('items', 'readonly', (s) => s.get(id));
export const putItem = (it) => run('items', 'readwrite', (s) => s.put(it));
export const getImage = (id) => run('images', 'readonly', (s) => s.get(id));
export const putImage = (id, blob) => run('images', 'readwrite', (s) => s.put(blob, id));

export async function children(parentId) {
  return (await allItems()).filter((it) => it.parentId === parentId);
}

// Удаление вместе со всем содержимым папки
export async function deleteItem(id) {
  const all = await allItems();
  const ids = [id];
  for (let i = 0; i < ids.length; i++) {
    for (const it of all) if (it.parentId === ids[i]) ids.push(it.id);
  }
  for (const x of ids) {
    await run('items', 'readwrite', (s) => s.delete(x));
    await run('images', 'readwrite', (s) => s.delete(x));
  }
}
