// Generates a valid grade-2 UEB .brf fixture by forward-translating print with
// liblouis and encoding the cells as Braille ASCII (NABCC). Layout (centered
// title, blank-line headings, form-feed page break) drives heading detection.
const createLiblouis = require('/tmp/llbuild/liblouis.js');
const fs = require('fs');

// Braille ASCII: index = dot value 0..63, value = the ASCII byte for that cell.
const BYVAL = " A1B'K2L@CIF/MSP\"E3H9O6R^DJG>NTQ,*5<-U8V.%[$+X!&;:4\\0Z7(_?W]#Y)=";
function uniToAscii(braille) {
  let s = '';
  for (const ch of braille) {
    const v = ch.charCodeAt(0) - 0x2800;
    s += (v >= 0 && v < 64) ? BYVAL[v] : ' ';
  }
  return s;
}
function fwd(mod, tbl, text) {
  const inlen = text.length;
  const inPtr = mod._malloc((inlen + 1) * 2); mod.stringToUTF16(text, inPtr, (inlen + 1) * 2);
  const outCap = inlen * 4 + 128; const outPtr = mod._malloc(outCap * 2);
  const inlenPtr = mod._malloc(4); mod.setValue(inlenPtr, inlen, 'i32');
  const outlenPtr = mod._malloc(4); mod.setValue(outlenPtr, outCap, 'i32');
  const ok = mod.ccall('lou_translateString', 'number', ['string', 'number', 'number', 'number', 'number', 'number', 'number', 'number'], [tbl, inPtr, inlenPtr, outPtr, outlenPtr, 0, 0, 0]);
  let out = '';
  if (ok) { const n = mod.getValue(outlenPtr, 'i32'); for (let i = 0; i < n; i++) out += String.fromCharCode(mod.getValue(outPtr + i * 2, 'i16') & 0xFFFF); }
  mod._free(inPtr); mod._free(outPtr); mod._free(inlenPtr); mod._free(outlenPtr);
  return out;
}

createLiblouis().then(mod => {
  const tbl = 'unicode.dis,en-ueb-g2.ctb';
  const t = s => uniToAscii(fwd(mod, tbl, s));
  const W = 36;
  const center = s => ' '.repeat(Math.max(0, Math.floor((W - s.length) / 2))) + s;
  const page1 = [
    center(t('A Study in Braille')), '',
    t('Chapter One'), '',
    t('The story begins on a quiet morning.'),
    t('Snow was falling softly outside.'),
  ];
  const page2 = [
    t('Chapter Two'), '',
    t('Spring arrived and the garden grew.'),
    t('Bright flowers were everywhere.'),
  ];
  const brf = page1.join('\n') + '\n\f' + page2.join('\n') + '\n';
  fs.writeFileSync('/drives/Books/LLeBooks/_qa-formats/Braille Book.brf', brf, 'latin1');
  console.log('wrote fixture, bytes=' + brf.length);
  console.log('title cells: ' + JSON.stringify(page1[0]));
  console.log('chapter one cells: ' + JSON.stringify(page1[2]));
});
