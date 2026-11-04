// Builders for raw controller reports, shared by the unit and end-to-end tests.

const i16 = v => [v & 0xff, (v >> 8) & 0xff];
const u16 = v => [v & 0xff, (v >> 8) & 0xff];

export function x360Report({ b0 = 0, b1 = 0, lt = 0, rt = 0, lx = 0, ly = 0, rx = 0, ry = 0 } = {}) {
  return [0x00, 0x14, b0, b1, lt, rt, ...i16(lx), ...i16(ly), ...i16(rx), ...i16(ry), 0, 0, 0, 0, 0, 0];
}

export function gipReport({ b4 = 0, b5 = 0, lt = 0, rt = 0, lx = 0, ly = 0, rx = 0, ry = 0, seq = 1 } = {}) {
  return [0x20, 0x00, seq, 0x0e, b4, b5, ...u16(lt), ...u16(rt), ...i16(lx), ...i16(ly), ...i16(rx), ...i16(ry)];
}

export function gipGuideReport({ pressed, seq = 1, ack = false }) {
  return [0x07, ack ? 0x30 : 0x20, seq, 0x02, pressed ? 0x01 : 0x00, 0x5b];
}
