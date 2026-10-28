// Keep search offsets tied to PDF.js text items, including expanded ligatures
// and words or phrases that continue onto the next line.
export function normalizeSearchText(raw, mapOffsets=false) {
  const text=[],starts=[],ends=[];
  for (let offset=0;offset<raw.length;) {
    const start=offset,char=String.fromCodePoint(raw.codePointAt(offset));
    offset+=char.length;
    if (char==='\u00ad') continue;
    if (/[-\u2010]/u.test(char) && /\p{L}/u.test(raw[start-1]||'')) {
      const continuation=raw.slice(offset).match(/^[ \t]*\n[ \t]*(?=\p{L})/u);
      if (continuation) {offset+=continuation[0].length;continue;}
    }
    let normalized=char.normalize('NFKC').toLowerCase().replace(/[\u2018\u2019]/g,"'");
    if (/\s/u.test(normalized)) {
      while (offset<raw.length && /\s/u.test(raw[offset])) offset++;
      normalized=' ';
    }
    text.push(normalized);
    if (mapOffsets) for (let i=0;i<normalized.length;i++) {starts.push(start);ends.push(offset);}
  }
  return {text:text.join(''),starts:mapOffsets?Uint32Array.from(starts):null,ends:mapOffsets?Uint32Array.from(ends):null};
}

export function indexPDFText(content) {
  const chunks=[],segments=[];
  let offset=0,item=0;
  for (const part of content.items) {
    if (typeof part.str!=='string') continue;
    segments.push({item:item++,start:offset,end:offset+part.str.length});
    chunks.push(part.str);offset+=part.str.length;
    if (part.hasEOL) {chunks.push('\n');offset++;}
  }
  return {...normalizeSearchText(chunks.join(''),true),segments};
}

export function findPDFMatches(index,query,page) {
  const matches=[];
  if (!query) return matches;
  let offset=0;
  while ((offset=index.text.indexOf(query,offset))!==-1) {
    const start=index.starts[offset],end=index.ends[offset+query.length-1];
    let low=0,high=index.segments.length;
    while (low<high) {
      const middle=(low+high)>>>1;
      if (index.segments[middle].end<=start) low=middle+1;else high=middle;
    }
    const ranges=[];
    for (let i=low;i<index.segments.length && index.segments[i].start<end;i++) {
      const segment=index.segments[i];
      if (segment.end>segment.start) ranges.push({item:segment.item,start:Math.max(start,segment.start)-segment.start,end:Math.min(end,segment.end)-segment.start});
    }
    if (ranges.length) matches.push({page,ranges});
    offset+=query.length;
  }
  return matches;
}
