/**
 * 最小**结构性合法**的 mp4（2026-10-12 视频接入）。
 *
 * 为什么夹具要拼真 box 链：`.mp4` 进了登记前置门（`verifyMp4Buffer` —— 顶层 box
 * 链必须恰好铺满整个文件、且带 ftyp/moov/mdat），`Buffer.from('video')` 这种假字节
 * 现在会被拒。凡是"替身文件内容无所谓"的 mp4 夹具，都从这里取字节。
 */
export function makeMp4Buffer(mdatBytes = 64): Buffer {
  const box = (type: string, payload: Buffer): Buffer => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + payload.length, 0);
    header.write(type, 4, 'latin1');
    return Buffer.concat([header, payload]);
  };
  return Buffer.concat([
    box('ftyp', Buffer.from('isomisoftyp1', 'latin1')),
    box('moov', Buffer.alloc(16, 7)),
    box('mdat', Buffer.alloc(mdatBytes, 1)),
  ]);
}
