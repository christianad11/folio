const recent = (a, b) => (b.lastOpened || b.addedAt || 0) - (a.lastOpened || a.addedAt || 0);

export function sortShelfBooks(books, shelfId, mode = 'manual') {
  return [...books].sort((a, b) => {
    if (mode === 'title') return a.title.localeCompare(b.title);
    if (mode === 'progress') return b.progress - a.progress;
    if (mode === 'manual') {
      const rank = book => Number.isFinite(book.shelfOrder?.[shelfId]) ? book.shelfOrder[shelfId] : Infinity;
      const left = rank(a), right = rank(b);
      if (left !== right) return left - right;
    }
    return recent(a, b);
  });
}

// Input is the full shelf in its current display order, including hidden search results.
export function reorderShelfBooks(books, shelfId, bookId, targetId, after = false) {
  const source = books.findIndex(book => book.id === bookId);
  if (source < 0 || bookId === targetId || !books.some(book => book.id === targetId)) return [];
  const ordered = [...books], [moved] = ordered.splice(source, 1);
  ordered.splice(ordered.findIndex(book => book.id === targetId) + Number(after), 0, moved);
  if (ordered.every((book, index) => book.id === books[index].id)) return [];
  return ordered.map((book, index) => ({...book, shelfOrder: {...book.shelfOrder, [shelfId]: index}}));
}

export function detachShelf(books, shelfId) {
  return books.filter(book => book.shelfId === shelfId || Object.hasOwn(book.shelfOrder || {}, shelfId)).map(book => {
    const shelfOrder = {...book.shelfOrder};
    delete shelfOrder[shelfId];
    return {...book, shelfId: book.shelfId === shelfId ? null : book.shelfId, shelfOrder};
  });
}

export function validateShelfName(value, shelves, currentId) {
  const name = value.trim();
  if (!name) throw new Error('Enter a shelf name.');
  if (name.length > 60) throw new Error('Use 60 characters or fewer.');
  if (shelves.some(shelf => shelf.id !== currentId && shelf.name.trim().toLowerCase() === name.toLowerCase())) throw new Error('A shelf with this name already exists.');
  return name;
}
