// OneTab's export format: one "url | title" per line, groups separated by blank lines.

export function parseOneTab(text) {
  const groups = [];
  let cur = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      if (cur.length) groups.push(cur);
      cur = [];
      continue;
    }
    const sep = line.indexOf(' | ');
    const url = (sep < 0 ? line : line.slice(0, sep)).trim();
    const title = sep < 0 ? '' : line.slice(sep + 3).trim();
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) continue; // skip junk lines
    cur.push({ url, title: title || url });
  }
  if (cur.length) groups.push(cur);
  return groups;
}

export function toOneTab(groups) {
  return groups.map((g) => g.data.tabs.map((t) => `${t.url} | ${t.title}`).join('\n')).join('\n\n') + '\n';
}
